/* Module Engine: commit settings only after DNR accepts and verifies them. */
"use strict";

if (!globalThis.BlockAds && typeof importScripts === "function") importScripts("../shared/shared.js");
if (!globalThis.BlockAdsFlags && typeof importScripts === "function") importScripts("../blocking/flags.js");
if (!globalThis.BlockAdsScriptlets && typeof importScripts === "function") importScripts("../blocking/scriptlets.js");
if (!globalThis.BlockAdsCosmetic && typeof importScripts === "function") importScripts("../blocking/cosmetic.js");
if (!globalThis.BlockAdsNetwork && typeof importScripts === "function") importScripts("../blocking/network.js");
if (!globalThis.BlockAdsModules && typeof importScripts === "function") importScripts("modules.js");
if (!globalThis.BlockAdsUserScriptCore && typeof importScripts === "function") importScripts("../../vendor/publicsuffix/suffixes.js", "../userscripts/userscripts-matching.js", "../userscripts/userscripts-page.js", "../userscripts/userscripts-core.js");
if (!globalThis.BlockAdsUserScriptNetwork && typeof importScripts === "function") importScripts("../userscripts/userscripts-network.js");
if (!globalThis.BlockAdsUserScriptUpdates && typeof importScripts === "function") importScripts("../userscripts/userscripts-updates.js");
if (!globalThis.BlockAdsOffscreen && typeof importScripts === "function") importScripts("../userscripts/userscripts-offscreen.js");
if (!globalThis.BlockAdsXHR && typeof importScripts === "function") importScripts("../userscripts/userscripts-xhr.js");
if (!globalThis.BlockAdsClipboard && typeof importScripts === "function") importScripts("../userscripts/clipboard.js");
if (!globalThis.BlockAdsUserScriptActions && typeof importScripts === "function") importScripts("../userscripts/userscripts-actions.js");
if (!globalThis.BlockAdsUserScripts && typeof importScripts === "function") importScripts("../userscripts/userscripts-runtime.js");
if (!globalThis.BlockAdsDebug && typeof importScripts === "function") importScripts("../shared/debug-protocol.js", "debug-runtime.js");
if (!globalThis.ModuleEngineNetworkLog && typeof importScripts === "function") importScripts("network-log.js");
if (!globalThis.ModuleEngineThreatUpdates && typeof importScripts === "function") importScripts("../shared/update-config.js", "../blocking/evidence.js", "threat-updates.js");
if (!globalThis.ModuleEngineCommunityUpdates && typeof importScripts === "function") importScripts("../blocking/community-lists.js", "community-updates.js");
if (!globalThis.ModuleEngineBackupRuntime && typeof importScripts === "function") importScripts("../shared/appearance-settings.js", "../shared/backup.js", "backup-runtime.js");
const api = typeof browser !== "undefined" ? browser : chrome;
const networkLog = ModuleEngineNetworkLog.create(api, { regularTransfer: BlockAdsUserScriptNetwork.regularTransfer });
// Automatic userscript updates are recorded in the activity log.
const userscriptHost = BlockAdsUserScripts.create(api, { log: entry => addLog(entry) });
const moduleHost = BlockAdsModules.create({
  async state() {
    const result = await enqueue(() => processRequest({ type: 'GET_STATE' }));
    return { enabled: result.settings?.enabled ?? null, active: result.ok && result.settings.enabled,
      error: result.error || result.threatStatus?.error || '' };
  },
  setEnabled: enabled => enqueue(() => processRequest({ type: 'UPDATE_SETTINGS', patch: { enabled } }))
}, userscriptHost);
BlockAdsDebug.create(api, {
  userscripts: userscriptHost,
  blocking: async () => {
    const { settings } = await loadSettings();
    return { enabled: settings.enabled, configuredRulesets: settings.rulesets,
      nativeEnabledRulesets: await api.declarativeNetRequest.getEnabledRulesets(),
      dynamicRuleCount: (await api.declarativeNetRequest.getDynamicRules()).length };
  },
  activity: () => loadLog().then(entries => entries.slice()),
  network: args => networkLog.read(args),
  // Records the user's decisions on agent proposals, never the proposals themselves.
  log: entry => addLog(entry)
});
const { normalizeDomain, normalizeDomains, domainMatches, sameSite } = BlockAds;
const RULESET_IDS = ["ads_ruleset", "trackers_ruleset", "threats_ruleset", "community_ruleset"];
const THREAT_CHECK_ALARM = "reported-threats-check";
const THREAT_EXPIRY_ALARM = "reported-threats-expiry";
// Must match $ThreatEvidenceMaxAgeDays in scripts/threat-report-tools.ps1 and
// maxAgeDays in src/blocking/evidence.js.
const THREAT_MAX_AGE_DAYS = 180;
// Signed reported-threat updates (threat-updates.js). The installed list is kept
// as the exact text that was verified, and the last check's result beside it.
const THREAT_UPDATE_KEY = "threatUpdate";
const THREAT_UPDATE_STATUS_KEY = "threatUpdateStatus";
const THREAT_UPDATE_INTERVAL = 24 * 3600000;
// Filter-list updates (community-updates.js). The installed change (versions,
// disabled bundled rule IDs and added rules) is kept apart from its site hiding
// data, which only the cosmetic loader reads.
const COMMUNITY_UPDATE_KEY = "communityUpdate";
const COMMUNITY_COSMETIC_KEY = "communityUpdateCosmetic";
const COMMUNITY_STATUS_KEY = "communityUpdateStatus";
// After a failed check; a successful one waits for the lists' own interval.
const COMMUNITY_RETRY = 12 * 3600000;
const DEFAULT_SETTINGS = {
  enabled: true,
  // Reported Threats is opt-in. Every profile saves its full settings on its
  // first start, so this reaches new installs only; existing installs keep the
  // choice they saved.
  rulesets: Object.fromEntries(RULESET_IDS.map(id => [id, id !== "threats_ruleset"])),
  cosmeticFiltering: true,
  genericCosmeticFiltering: true,
  proceduralFiltering: true,
  // Scriptlet filters (site##+js(...)) from the person's rules and the lists.
  scriptletFiltering: true,
  notificationPromptBlocking: true,
  deceptivePromptBlocking: true,
  deceptiveButtonBlocking: true,
  promptAllowedDomains: [],
  customCosmeticFilters: "",
  customNetworkFilters: "",
  cosmeticPausedDomains: [],
  flagSuspects: true,
  // Download newer EasyList snapshots while the community layer is on.
  communityListUpdates: true,
  // An expired reported-threat list keeps blocking until a newer list replaces
  // it. On, the layer stops at the expiry date instead. Installs that saved
  // settings before this choice existed take this default too.
  retireExpiredThreats: false,
  whitelistedDomains: [],
  customBlockedDomains: [],
  popupBlockedDomains: [],
  allowedDomains: []
};
const DOMAIN_LIST_KEYS = ["whitelistedDomains", "customBlockedDomains", "popupBlockedDomains", "allowedDomains", "cosmeticPausedDomains", "promptAllowedDomains"];
// Always-allowed domains override every list rule (1-3, including community
// $important) but not reported threats (5) or custom blocks (50).
const ALLOWED_DOMAIN_PRIORITY = 4;
// Applied to the selected top document, then inherited by its descendants.
// Preserve player APIs and ordinary page capabilities while withholding frame
// permission to navigate the top tab, including after a genuine play click.
// Append this policy: never replace the site's own CSP or iframe restrictions.
const PAGE_GUARD_SANDBOX = "sandbox allow-scripts allow-same-origin allow-forms allow-modals " +
  "allow-orientation-lock allow-pointer-lock allow-popups allow-popups-to-escape-sandbox " +
  "allow-presentation allow-downloads allow-storage-access-by-user-activation";
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);
const ALL_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "media", "websocket", "other"
];
// YouTube video ads share hosts with the video, so the ad layer also removes
// them from player responses with a page-world script on these sites.
const YOUTUBE_SCRIPT_ID = "youtube-ads";
const YOUTUBE_DOMAINS = ["youtube.com", "youtube-nocookie.com"];
// Pop-up blocking runs only on sites the person selected in the popup.
const POPUP_SCRIPT_ID = "popup-blocker";
// Bundled generic hiding, registered as static stylesheets instead of being sent
// to every frame. The excepted sheet holds the selectors some sites exempt.
const GENERIC_SCRIPT_ID = "community-generic";
const GENERIC_EXCEPTED_SCRIPT_ID = "community-generic-excepted";
let operationQueue = Promise.resolve();

// Activity log: recent blocks and extension events for tracing. Kept in session
// storage (cleared when the browser closes), capped, local only. A logging
// failure must never affect protection, so every path here catches its errors.
const LOG_KEY = "activityLog";
const LOG_LIMIT = 1000;
const LAYER_NAMES = { ads_ruleset: "Ads", trackers_ruleset: "Trackers", threats_ruleset: "Reported threat", community_ruleset: "Community lists", _dynamic: "Custom block" };
// Fixed messages that content scripts may add; they never supply free text.
const CONTENT_EVENTS = {
  "procedural-filter-limit": () => "Advanced page hiding stopped on this page after reaching a scan limit; CSS and network filtering remain active",
  "procedural-filter-invalid": () => "Some advanced hiding filters are unsupported by this browser; other filters remain active",
  "procedural-filter-error": () => "Advanced page hiding stopped after an unexpected error; reload the page and inspect the extension console",
  "youtube-ad-skipped": () => "Skipped a YouTube video ad that reached the player"
};
// Site-specific hiding rules from the community lists, loaded once per worker.
let communityCosmetic = null;
let customCosmeticCache = { text: "", rules: [] };
let customNetworkCache = { text: "", rules: [] };

function customNetworkRules(text) {
  if (customNetworkCache.text !== text) customNetworkCache = { text, rules: BlockAdsNetwork.parse(text) };
  return customNetworkCache.rules;
}

function customCosmeticRules(text) {
  if (customCosmeticCache.text !== text) customCosmeticCache = { text, rules: BlockAdsCosmetic.parse(text) };
  return customCosmeticCache.rules;
}
let logLoad = null;
let logSaveTimer = null;
let dynamicBlockIds = null;

function loadLog() {
  logLoad ??= (async () => {
    try {
      const stored = (await api.storage.session.get(LOG_KEY))[LOG_KEY];
      if (stored?.schemaVersion === 2 && Array.isArray(stored.entries)) return stored.entries.slice(-LOG_LIMIT);
      if (Array.isArray(stored)) {
        // The installation event writes the filtered log. A read through MCP
        // must neither disclose unclassified browsing activity nor write data.
        return stored.slice(-LOG_LIMIT).filter(entry => entry && typeof entry === 'object' && !('tabId' in entry || 'site' in entry || 'host' in entry));
      }
      return [];
    } catch {
      return [];
    }
  })();
  return logLoad;
}

async function addLog(entry) {
  try {
    const entries = await loadLog();
    entries.push({ time: Date.now(), ...entry });
    if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
    // Batch writes: a busy page can produce many blocks per second.
    logSaveTimer ??= setTimeout(async () => {
      logSaveTimer = null;
      try { await api.storage.session.set({ [LOG_KEY]: { schemaVersion: 2, entries: await loadLog() } }); }
      catch (error) { console.warn("[Module Engine] Could not save the activity log:", error); }
    }, 500);
  } catch (error) {
    console.warn("[Module Engine] Could not record a log entry:", error);
  }
}

// Suspected ads that loaded (Module Engine did not block them), grouped by site and
// kept in local storage until the person blocks, allows, ignores or clears them.
// Only page sites, server names, reason codes and short paths are stored.
const FLAG_KEY = "adFlags";
const FLAG_LIMIT = 500;
let flagLoad = null;
let flagSaveTimer = null;
let flagSettings = null;

// A failed read must not become an empty store: the next save would then
// overwrite the saved flags. Fail (callers report it) and retry next time.
function loadFlags() {
  flagLoad ??= api.storage.local.get([FLAG_KEY])
    .then(stored => stored[FLAG_KEY] && typeof stored[FLAG_KEY] === "object" && !Array.isArray(stored[FLAG_KEY]) ? stored[FLAG_KEY] : {})
    .catch(error => { flagLoad = null; throw error; });
  return flagLoad;
}

function saveFlagsSoon() {
  flagSaveTimer ??= setTimeout(async () => {
    flagSaveTimer = null;
    try { await api.storage.local.set({ [FLAG_KEY]: await loadFlags() }); }
    catch (error) { console.warn("[Module Engine] Could not save flags:", error); }
  }, 1000);
}

// Settings used on every loaded request, cached until settings change.
function flagContext() {
  flagSettings ??= loadSettings().then(({ settings }) => ({
    enabled: settings.enabled && settings.flagSuspects,
    paused: settings.whitelistedDomains,
    allowed: settings.allowedDomains
  }), () => ({ enabled: false }));
  return flagSettings;
}

async function recordFlag({ host, pageHost, reasons, path, tabId }) {
  const context = await flagContext();
  if (!context.enabled || context.paused.some(domain => domainMatches(pageHost, domain)) ||
      context.allowed.some(domain => domainMatches(host, domain))) return;
  const flags = await loadFlags();
  // A review decision applies to the exact server that produced the signal.
  // Collapsing to an approximate registrable site can turn one shared-hosting
  // tenant into a block or allow decision for every tenant on that platform.
  const site = host;
  const now = Date.now();
  let entry = flags[site];
  if (entry?.status === "ignored") return;
  const isNew = !entry;
  if (isNew) {
    // Keep the newest flags when full: drop the one seen longest ago.
    const sites = Object.keys(flags);
    if (sites.length >= FLAG_LIMIT) {
      delete flags[sites.reduce((oldest, key) => flags[key].lastSeen < flags[oldest].lastSeen ? key : oldest)];
    }
    entry = flags[site] = { site, status: "new", hosts: [], reasons: [], pages: [], samples: [], count: 0, firstSeen: now, lastSeen: now };
  }
  const addUnique = (list, value, limit) => { if (value && !list.includes(value) && list.length < limit) list.push(value); };
  entry.count++;
  entry.lastSeen = now;
  addUnique(entry.hosts, host, 5);
  addUnique(entry.pages, pageHost, 10);
  addUnique(entry.samples, `${host}${path}`.slice(0, 150), 3);
  for (const reason of reasons) addUnique(entry.reasons, reason, 10);
  saveFlagsSoon();
  if (isNew) {
    await addLog({ kind: "event", site: pageHost, tabId,
      message: `Flagged ${site} for review: ${reasons.map(reason => BlockAdsFlags.REASONS[reason]).join("; ")}` });
  }
}

// Only requests that actually loaded reach this event; blocked ones never do.
async function flagRequest(details) {
  try {
    const pageUrl = details.initiator || details.documentUrl || details.originUrl || "";
    if (details.tabId < 0 || !/^https?:\/\//i.test(pageUrl)) return;
    const pageHost = urlParts(pageUrl).host;
    const reasons = BlockAdsFlags.requestSignals({ url: details.url, type: details.type, pageHost });
    if (!reasons.length) return;
    // Private-tab observations must never enter the persistent flag store.
    // Chromium omits incognito from webRequest events; use the browser's tab.
    if (details.incognito === true) return;
    if (details.incognito !== false) {
      const tab = await api.tabs.get(details.tabId).catch(() => null);
      if (tab?.incognito !== false) return;
    }
    const { host, path } = urlParts(details.url);
    await recordFlag({ host, pageHost, reasons, path, tabId: details.tabId });
  } catch (error) {
    console.warn("[Module Engine] Could not check a request for ad patterns:", error);
  }
}

async function editFlag(site, action) {
  const flags = await loadFlags();
  if (action === "clear") {
    for (const key of Object.keys(flags)) delete flags[key];
  } else if (typeof site !== "string" || !Object.hasOwn(flags, site)) {
    throw new Error("That flag no longer exists.");
  } else if (action === "remove") {
    delete flags[site];
  } else if (action === "ignore" || action === "unignore") {
    flags[site].status = action === "ignore" ? "ignored" : "new";
  } else {
    throw new Error("Unknown flag action.");
  }
  await api.storage.local.set({ [FLAG_KEY]: flags });
  return flags;
}

async function clearLog() {
  (await loadLog()).length = 0;
  await api.storage.session.remove(LOG_KEY);
}

function loadCommunityCosmetic() {
  communityCosmetic ??= (async () => {
    const response = await fetch(api.runtime.getURL("rules/community-cosmetic.json"));
    if (!response.ok) throw new Error("The bundled site hiding rules could not be read.");
    const data = await response.json();
    if (!data || !data.hide || !data.allow || (data.schemaVersion !== undefined && ![2, 3].includes(data.schemaVersion))) {
      throw new Error("The bundled cosmetic format is unsupported; rebuild the rules.");
    }
    // An installed filter-list update replaces site hiding. Generic hiding stays
    // with the release, because its stylesheets are packaged files. If the update
    // cannot be read, the bundled hiding is used rather than none.
    const update = await loadCommunityUpdate().catch(error => {
      console.warn("[Module Engine] The installed filter-list update could not be read:", error);
      return null;
    });
    if (!update) return data;
    const saved = (await api.storage.local.get([COMMUNITY_COSMETIC_KEY]))[COMMUNITY_COSMETIC_KEY];
    if (saved?.id !== update.id || !siteHidingShape(saved)) return data;
    const { hide, allow, scoped, procedural, disableGeneric, disableAll } = saved;
    // An update installed by an earlier version has no scriptlets; the bundled ones stay.
    return { ...data, hide, allow, scoped, procedural, disableGeneric, disableAll, scriptlets: Array.isArray(saved.scriptlets) ? saved.scriptlets : data.scriptlets };
  })().catch(error => {
    communityCosmetic = null;
    console.warn("[Module Engine] Site hiding rules unavailable:", error);
    return { hide: {}, allow: {} };
  });
  return communityCosmetic;
}

const stringList = value => Array.isArray(value) && value.every(item => typeof item === "string");
const selectorMap = value => Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(stringList);
function siteHidingShape(saved) {
  return Boolean(saved) && selectorMap(saved.hide) && selectorMap(saved.allow) && Array.isArray(saved.scoped) && Array.isArray(saved.procedural) &&
    stringList(saved.disableGeneric) && stringList(saved.disableAll);
}

// The bundled lists' description (versions, sources, counts), read once per worker.
// Packaged snapshots live under lists/community/, which the package includes.
const PACKAGED_LIST = /^community\/[A-Za-z0-9._-]+\.txt$/;
let communityInfoLoad = null;
function loadBundledCommunityInfo() {
  communityInfoLoad ??= fetch(api.runtime.getURL("rules/community-info.json")).then(response => {
    if (!response.ok) throw new Error("The bundled filter-list description could not be read.");
    return response.json();
  }).then(info => {
    // updates: "download" lists are downloaded from their source; "release" lists
    // change only with a new version and are converted from their packaged file.
    if (!Array.isArray(info?.lists) || !info.lists.length || !info.lists.every(list => typeof list?.id === "string" && typeof list.sha256 === "string" &&
        (list.updates === "download" || (list.updates === "release" && PACKAGED_LIST.test(list.file || ""))))) {
      throw new Error("The bundled filter-list description is invalid.");
    }
    return info;
  }).catch(error => { communityInfoLoad = null; throw error; });
  return communityInfoLoad;
}

// The packaged snapshot of a list that changes only with releases, checked
// against the hash the build recorded, so an update converts the same text.
async function readPackagedList(list) {
  const response = await fetch(api.runtime.getURL(`lists/${list.file}`));
  if (!response.ok) throw new Error(`The bundled ${list.title} snapshot could not be read.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== list.sha256) throw new Error(`The bundled ${list.title} snapshot does not match this version's record.`);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
// The bundled snapshots an installed update was made against.
const communityBaseline = info => info.lists.map(list => `${list.id}:${list.sha256}`).join(",");

// The installed filter-list change, while it fits this release: a new release
// brings newer bundled lists, and browsers re-enable bundled rules on update.
async function loadCommunityUpdate() {
  const saved = (await api.storage.local.get([COMMUNITY_UPDATE_KEY]))[COMMUNITY_UPDATE_KEY];
  if (!saved) return null;
  const info = await loadBundledCommunityInfo();
  const { isListRule } = ModuleEngineCommunityUpdates;
  if (saved.schemaVersion !== 1 || typeof saved.id !== "string" || saved.baseline !== communityBaseline(info) || !Array.isArray(saved.lists) ||
      !Array.isArray(saved.disable) || !saved.disable.every(id => Number.isInteger(id) && id > 0) ||
      !Array.isArray(saved.add) || !saved.add.every(rule => rule && isListRule(rule) && rule.condition && rule.action)) return null;
  return saved;
}

// The bundled rules and the domains list exceptions must leave alone, for a
// check: the rule file is 2.6 MiB, so it is read only then.
async function loadBundledCommunity() {
  const read = async file => {
    const response = await fetch(api.runtime.getURL(file));
    if (!response.ok) throw new Error(`The bundled ${file} could not be read.`);
    return response.json();
  };
  const [info, rules, catalog, siteHosts] = await Promise.all([loadBundledCommunityInfo(), read("rules/community.json"),
    read("rules/reviewed-domains.json"), read("rules/site-ad-hosts-info.json")]);
  // As in the build: Module Engine's own ad, tracker and site-check domains.
  const protectedDomains = [...catalog.domains.filter(item => item.category !== "unverified").map(item => item.domain),
    ...siteHosts.map(item => item.domain)];
  return { info, rules, protectedDomains };
}

function urlParts(value) {
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname.slice(0, 150) };
  } catch {
    return { host: "", path: "" };
  }
}

async function injectPopupFrame(sender, settings, active) {
  const topHost = urlParts(sender.tab?.url).host;
  if (!active || !topHost || !Number.isInteger(sender.frameId) || typeof sender.documentId !== "string" || !sender.documentId ||
      !settings.popupBlockedDomains.some(domain => domainMatches(topHost, domain))) return false;
  try {
    // Registered scripts cover matching frames at document_start. Targeting the
    // sending document also covers cross-origin children without following a navigation.
    await api.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      files: ["src/blocking/popups.js"],
      world: "MAIN"
    });
    return true;
  } catch (error) {
    // Restricted browser pages may reject injection; cosmetic filtering and
    // the registered top-page guard must continue independently.
    console.warn("[Module Engine] Could not guard a pop-up frame:", error);
    return false;
  }
}

// Scriptlet filters (scriptlets.js): the person's own ##+js() rules and the
// community lists'. Each frame gets them when its content script first asks for
// its hiding rules, which can be after the page's first scripts have run. With
// the browser's userscript access, the person's own rules are also registered
// to run at document start, before the page's own scripts.
//
// The lists' rules are not registered. Registering uBlock filters' 7,178 rules
// on about 16,000 sites made every page load about 50 ms slower in Chrome, and
// the first page after each change of the registrations (a site pause, a rule
// edit, a list update) took 1.5 to 3.5 seconds while Chrome passed the new
// scripts to its page processes (measured 19 November 2026).
const SCRIPTLET_SCRIPT_ID = "blockads-scriptlets";
// The registration is split by site into up to 32 scripts, blockads-scriptlets-0
// to -31, so a page loads its own group's rules. The ID without a number is the
// single registration of earlier versions.
const SCRIPTLET_GROUPS = 32;
const SCRIPTLET_SCRIPT_IDS = [SCRIPTLET_SCRIPT_ID, ...Array.from({ length: SCRIPTLET_GROUPS }, (_, index) => `${SCRIPTLET_SCRIPT_ID}-${index}`)];
// The last synchronization: "early" (the person's rules registered), "late"
// (all started per frame) or "off" (no scriptlet applies), with the number of
// rules, how many are the person's own, and any error.
let scriptletStatus = { mode: "off", rules: 0, own: 0, error: "" };

// The lists' rules and the person's own, for these settings.
function scriptletSources(settings, data) {
  if (!settings.enabled || !settings.cosmeticFiltering || !settings.scriptletFiltering) return { listed: [], own: [] };
  const listed = settings.rulesets.community_ruleset && Array.isArray(data?.scriptlets) ? data.scriptlets : [];
  const own = customCosmeticRules(settings.customCosmeticFilters).filter(rule => rule.scriptlet)
    .map(({ include, exclude, exception, scriptlet }) => ({ include, exclude, exception, name: scriptlet.name, args: scriptlet.args }));
  return { listed, own };
}

// Each domain belongs to a site: its last two labels, so www.example.com and
// example.com share example.com, or a one-label name such as localhost that a
// rule names, for everything under it. Sites go to groups by a fixed hash
// (FNV-1a), stable across workers and versions, so a change on one site
// re-registers one group.
function scriptletSite(domain, singles) {
  const end = domain.lastIndexOf(".");
  if (end < 0 || singles.has(domain.slice(end + 1))) return domain.slice(end + 1);
  return domain.slice(domain.lastIndexOf(".", end - 1) + 1);
}
function scriptletGroup(site) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < site.length; i++) hash = Math.imul(hash ^ site.charCodeAt(i), 0x01000193);
  return (hash >>> 0) % SCRIPTLET_GROUPS;
}

// The rules for these settings, kept while the inputs stay the same: the list
// hiding data is one object per worker, and every settings transaction ends
// with a synchronization. The lists bring thousands of rules.
//   rules: every rule, which frames start as they load.
//   early: what the registration starts, the person's own rules with the lists'
//     exceptions, so a list exception still cancels the person's rule there.
let scriptletPlan = null;
function scriptletPlanFor(settings, data) {
  const paused = [...new Set([...settings.whitelistedDomains, ...settings.cosmeticPausedDomains])];
  const excluded = [...paused, ...(settings.rulesets.community_ruleset ? data?.disableAll || [] : [])];
  const key = [data, settings.customCosmeticFilters, settings.enabled, settings.cosmeticFiltering, settings.scriptletFiltering,
    settings.rulesets.community_ruleset, paused.join("\n"), excluded.join("\n")];
  if (scriptletPlan?.key.every((part, index) => part === key[index])) return scriptletPlan;
  const { listed, own } = scriptletSources(settings, data);
  const rules = [...listed, ...own], early = [...listed.filter(rule => rule.exception), ...own];
  const named = rule => !rule.exception && rule.name;
  scriptletPlan = { key, rules, early, paused, excluded, registrations: null,
    singles: new Set(early.flatMap(rule => [...rule.include, ...rule.exclude]).filter(domain => !domain.includes("."))),
    count: rules.filter(rule => !rule.exception).length, own: own.filter(rule => !rule.exception).length,
    active: rules.some(named), earlyActive: own.some(named) };
  return scriptletPlan;
}

// The document-start registrations for a plan's early rules, none when no rule
// of the person's would run. Each frame picks its rules by its own hostname,
// from its group's. A frame can match a rule only on a domain of the frame's
// own site, so a frame needs only its site's group, and matches no other
// group's sites. A rule with domains in several groups is split into one part
// per group, with its domains and exclusions on that group's sites. Every group
// excludes all paused sites and sites whose lists turn all hiding off, as for
// site hiding.
function scriptletRegistrations(plan) {
  if (plan.registrations) return plan.registrations;
  const known = new Map();
  const groupOf = domain => {
    let index = known.get(domain);
    if (index === undefined) known.set(domain, index = scriptletGroup(scriptletSite(domain, plan.singles)));
    return index;
  };
  const groups = new Map();
  for (const rule of plan.early) {
    const parts = new Map();
    for (const domain of rule.include) {
      const index = groupOf(domain);
      if (!parts.has(index)) parts.set(index, []);
      parts.get(index).push(domain);
    }
    for (const [index, include] of parts) {
      if (!groups.has(index)) groups.set(index, []);
      groups.get(index).push({ ...rule, include, exclude: rule.exclude.filter(domain => groupOf(domain) === index) });
    }
  }
  // Rules and pauses on a one-label name such as localhost also cover its
  // subdomains, which the shared site patterns cover only exactly.
  const patterns = domains => [...new Set([...sitesPatterns(domains),
    ...domains.filter(domain => !domain.includes(".")).map(domain => `*://*.${domain}/*`)])].sort();
  const excludeMatches = patterns(plan.excluded);
  plan.registrations = [];
  for (const [index, grouped] of [...groups].sort((a, b) => a[0] - b[0])) {
    const hosts = [...new Set(grouped.filter(rule => !rule.exception && rule.name).flatMap(rule => rule.include))];
    if (!hosts.length) continue;
    const script = { id: `${SCRIPTLET_SCRIPT_ID}-${index}`, matches: patterns(hosts), excludeMatches,
      runAt: "document_start", allFrames: true, world: "MAIN", js: [{ code: BlockAdsScriptlets.code(grouped, plan.paused) }] };
    plan.registrations.push({ script, text: userScriptText(script) });
  }
  return plan.registrations;
}
const userScriptShape = script => ({ id: script.id, matches: [...(script.matches || [])].sort(), excludeMatches: [...(script.excludeMatches || [])].sort(),
  runAt: script.runAt || "document_idle", allFrames: Boolean(script.allFrames), world: script.world || "USER_SCRIPT",
  js: (script.js || []).map(source => source.code ?? source.file ?? "") });
// What a registration does, as text, for comparing the browser's copy with ours.
const userScriptText = script => canonicalText(userScriptShape(script));
const nativeUserScript = ({ excludeMatches, ...script }) => ({ ...script, ...(excludeMatches.length ? { excludeMatches } : {}) });

// The browser's userscript API while the person allows it, else null. Chrome
// and Edge also need Allow User Scripts in the extension's details.
async function scriptletAccess() {
  try {
    if (typeof api.permissions?.contains !== "function" || !(await api.permissions.contains({ permissions: ["userScripts"] }))) return null;
    const native = api.userScripts;
    if (typeof native?.getScripts !== "function" || typeof native.register !== "function" || typeof native.unregister !== "function") return null;
    await native.getScripts({ ids: [SCRIPTLET_SCRIPT_ID] });
    return native;
  } catch {
    return null;
  }
}

// Brings the registrations in line with these settings. The userscript manager
// owns only its own registrations (blockads-user-*). A failure leaves none, so
// frames get their scriptlets late rather than twice or from stale rules.
// `loaded` is the list hiding data the settings transaction already read.
async function syncScriptlets(settings, loaded = null) {
  const data = settings.enabled && settings.cosmeticFiltering && settings.scriptletFiltering && settings.rulesets.community_ruleset
    ? loaded ?? await loadCommunityCosmetic() : {};
  const plan = scriptletPlanFor(settings, data);
  const native = await scriptletAccess();
  let error = "";
  if (native) {
    try {
      const desired = scriptletRegistrations(plan);
      const current = new Map((await native.getScripts({ ids: SCRIPTLET_SCRIPT_IDS })).map(script => [script.id, script]));
      const stale = [...current.keys()].filter(id => !desired.some(({ script }) => script.id === id));
      const added = desired.filter(({ script }) => !current.has(script.id)).map(({ script }) => script);
      const changed = desired.filter(({ script, text }) => current.has(script.id) && userScriptText(current.get(script.id)) !== text).map(({ script }) => script);
      if (stale.length || added.length || changed.length) {
        if (stale.length) await native.unregister({ ids: stale });
        if (added.length) await native.register(added.map(nativeUserScript));
        if (changed.length) {
          // Updating in place keeps document-start coverage while the rules change.
          if (typeof native.update === "function") await native.update(changed.map(script => ({ ...nativeUserScript(script), excludeMatches: script.excludeMatches })));
          else { await native.unregister({ ids: changed.map(script => script.id) }); await native.register(changed.map(nativeUserScript)); }
        }
        // Read back only after a change: otherwise the browser's copy was just compared.
        const after = new Map((await native.getScripts({ ids: SCRIPTLET_SCRIPT_IDS })).map(script => [script.id, script]));
        if (after.size !== desired.length || !desired.every(({ script, text }) => after.has(script.id) && userScriptText(after.get(script.id)) === text)) {
          throw new Error("The browser did not apply the scriptlet registration.");
        }
      }
    } catch (failure) {
      error = failure?.message || String(failure);
      // Only IDs the browser reports, so one unknown ID cannot make it refuse the whole call.
      try {
        const ids = (await native.getScripts({ ids: SCRIPTLET_SCRIPT_IDS })).map(script => script.id);
        if (ids.length) await native.unregister({ ids });
      } catch { /* The browser keeps what it has; the next synchronization retries. */ }
      if (error !== scriptletStatus.error) await addLog({ kind: "error", message: `Scriptlet filters could not be registered to start before page scripts; they start as pages load instead. ${error}` });
    }
  }
  scriptletStatus = { mode: !plan.active ? "off" : plan.earlyActive && native && !error ? "early" : "late", rules: plan.count, own: plan.own, error };
}

// Whether the document-start registration for a frame's host is in place. The
// browser is asked each time: Allow User Scripts can be switched off without
// telling the worker. Only the frame's own group is read, not every group's code.
async function scriptletsRegistered(hostname) {
  const native = await scriptletAccess();
  if (!native) return false;
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const ids = scriptletPlan && host ? [`${SCRIPTLET_SCRIPT_ID}-${scriptletGroup(scriptletSite(host, scriptletPlan.singles))}`] : SCRIPTLET_SCRIPT_IDS;
  try { return (await native.getScripts({ ids })).length > 0; } catch { return false; }
}

// Starts a frame's scriptlets without the registration, in the frame's own
// page world, using the browser's frame and document IDs.
async function injectScriptlets(sender, calls) {
  if (!calls.length || !Number.isInteger(sender.frameId) || typeof sender.documentId !== "string" || !sender.documentId) return false;
  try {
    await api.scripting.executeScript({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      world: "MAIN", injectImmediately: true, func: BlockAdsScriptlets.run, args: [calls]
    });
    return true;
  } catch (error) {
    // Restricted pages refuse injection; the page's other protection continues.
    console.warn("[Module Engine] Could not start scriptlet filters in a frame:", error);
    return false;
  }
}

// Dynamic rules include site-pause allow rules; only custom blocks are logged.
async function isDynamicBlock(ruleId) {
  dynamicBlockIds ??= api.declarativeNetRequest.getDynamicRules()
    .then(rules => new Set(rules.filter(rule => rule.action.type === "block").map(rule => rule.id)))
    .catch(error => { dynamicBlockIds = null; throw error; });
  return (await dynamicBlockIds).has(ruleId);
}

// Chrome and Edge report rule matches while the extension is loaded unpacked.
// Firefox has no such event, so only events are logged there. Matches include
// allow rules (site pauses, community-list exceptions) and header rules (the
// pop-up sandbox, userscript upload guards); only verified block actions are
// logged as blocked requests.
async function logRuleMatch({ rule, request }) {
  try {
    if (!networkLog.regularTab(request.tabId, request.incognito) || !(await matchedBlock(rule))) return;
    const { host, path } = urlParts(request.url);
    const source = request.initiator || request.documentUrl || request.originUrl || "";
    // Installed list updates run as dynamic rules in their own ID ranges.
    const updated = rule.rulesetId === "_dynamic" ? { id: rule.ruleId } : null;
    const layer = updated && isThreatRule(updated) ? "threats_ruleset"
      : updated && ModuleEngineCommunityUpdates.isListRule(updated) ? "community_ruleset" : rule.rulesetId;
    await addLog({
      kind: "blocked", layer: LAYER_NAMES[layer] || rule.rulesetId, ruleId: rule.ruleId,
      host, path, type: request.type, site: urlParts(source).host, tabId: request.tabId
    });
  } catch (error) {
    console.warn("[Module Engine] Could not log a blocked request:", error);
  }
}

// A blocked navigation can leave an empty/error tab behind. Only consider a
// newly opened tab with a native opener, during its first HTTP(S) navigation.
// No page message can supply this evidence or authorize closing a tab.
const blockedPopupTabs = new Map();
const packagedPopupRules = new Map();
const BLOCKED_POPUP_TTL = 10000;
const BLOCKED_POPUP_LIMIT = 64;
// Firefox has no native match event. Its ordinary DNR read APIs do not require
// the debugging-only extensions.dnr.feedback preference.
const firefoxPopupCleanup = !api.declarativeNetRequest.onRuleMatchedDebug &&
  typeof api.runtime.getBrowserInfo === "function";
let networkRuleUpdates = 0;
const blankTabUrl = url => !url || /^about:blank(?:#|$)/.test(url);
function navigationUrl(url) {
  if (typeof url !== "string" || url.length > 8192) return "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.href;
  } catch { return ""; }
}
function popupCandidate(tabId) {
  const item = blockedPopupTabs.get(tabId);
  if (item && (networkRuleUpdates || Date.now() - item.created >= BLOCKED_POPUP_TTL)) {
    blockedPopupTabs.delete(tabId);
    return null;
  }
  return item;
}
function trackPopupTab(tab) {
  if (networkRuleUpdates || !Number.isInteger(tab.id) || !Number.isInteger(tab.openerTabId) ||
      tab.openerTabId < 0 || tab.id === tab.openerTabId || tab.pinned || tab.discarded || !blankTabUrl(tab.url)) return;
  for (const id of blockedPopupTabs.keys()) popupCandidate(id);
  if (blockedPopupTabs.size >= BLOCKED_POPUP_LIMIT) blockedPopupTabs.delete(blockedPopupTabs.keys().next().value);
  blockedPopupTabs.set(tab.id, { id: tab.id, opener: tab.openerTabId, created: Date.now(), request: null });
}
function popupRequest(details, starting = false) {
  if (details.type !== "main_frame" || details.frameId !== 0 || typeof details.requestId !== "string") return null;
  const item = popupCandidate(details.tabId), url = navigationUrl(details.url);
  if (!item) return null;
  if (!url || (item.request && item.request.id !== details.requestId)) {
    blockedPopupTabs.delete(details.tabId);
    return null;
  }
  if (!item.request || (starting && item.request.url !== url)) {
    const previousUrls = firefoxPopupCleanup && item.request ? [...item.request.previousUrls, item.request.url] : [];
    if (previousUrls.length > 8) { blockedPopupTabs.delete(item.id); return null; }
    item.request = { id: details.requestId, url, previousUrls };
  }
  if (starting) item.request.started = true;
  return item.request.url === url ? item : null;
}
function readPackagedPopupRules(resource) {
  if (!packagedPopupRules.has(resource.id)) {
    const read = fetch(api.runtime.getURL(resource.path)).then(response => {
      if (!response.ok) throw new Error("Could not read the matched rule's packaged action.");
      return response.json();
    }).then(rules => ({
      blockIds: new Set(rules.filter(item => item.action?.type === "block").map(item => item.id)),
      navigation: rules.filter(item => popupMayNavigate(item.condition))
    })).catch(error => { packagedPopupRules.delete(resource.id); throw error; });
    packagedPopupRules.set(resource.id, read);
  }
  return packagedPopupRules.get(resource.id);
}
async function matchedBlock(rule) {
  if (!Number.isInteger(rule?.ruleId)) return false;
  if (rule.rulesetId === "_dynamic") return isDynamicBlock(rule.ruleId);
  const resource = api.runtime.getManifest().declarative_net_request.rule_resources.find(item => item.id === rule.rulesetId);
  return Boolean(resource && (await readPackagedPopupRules(resource)).blockIds.has(rule.ruleId));
}

// Three-valued, deliberately partial DNR check: true, false, or unknown (null).
// Unknown conditions cannot prove a block, and a possible overriding action
// vetoes cleanup. This is only a cleanup certificate, never a blocking engine.
function popupUrlFilter(filter, sensitive, context) {
  if (typeof filter !== "string" || !filter || filter.length > 2048 || /[^\x21-\x7e]/.test(filter)) return null;
  const domainAnchor = filter.startsWith("||"), startAnchor = filter.startsWith("|");
  let pattern = filter.slice(domainAnchor ? 2 : startAnchor ? 1 : 0);
  const endAnchor = pattern.endsWith("|");
  if (endAnchor) pattern = pattern.slice(0, -1);
  if (!pattern || pattern.includes("|")) return null;
  let url = context.url.href;
  const cost = (pattern.length + 1) * (url.length + 1);
  if (cost > context.budget) return null;
  context.budget -= cost;
  if (!sensitive) { pattern = pattern.toLowerCase(); url = url.toLowerCase(); }
  let positions = new Uint8Array(url.length + 1);
  if (domainAnchor) {
    const start = url.indexOf("://") + 3, end = start + context.url.hostname.length;
    positions[start] = 1;
    for (let i = start; i < end; i++) if (url[i] === ".") positions[i + 1] = 1;
  } else if (startAnchor) positions[0] = 1;
  else positions.fill(1);
  // Bounded state propagation avoids regex backtracking on URL/filter input.
  for (let index = 0; index < pattern.length; index++) {
    const token = pattern[index];
    const next = new Uint8Array(url.length + 1);
    for (let i = 0; i <= url.length; i++) {
      if (token === "*") next[i] = positions[i] || (i > 0 && next[i - 1]);
      else if (positions[i]) {
        if (token === "^") {
          if (i === url.length && index === pattern.length - 1) next[i] = 1;
          else if (!/[a-z0-9_.%\-]/i.test(url[i])) next[i + 1] = 1;
        } else if (url[i] === token) next[i + 1] = 1;
      }
    }
    positions = next;
    if (!positions.some(Boolean)) return false;
  }
  return endAnchor ? Boolean(positions[url.length]) : positions.some(Boolean);
}
function popupMayNavigate(condition) {
  if (!condition || condition.excludedResourceTypes?.includes("main_frame")) return false;
  // Omitting both type lists excludes main_frame. An exclusion-only list can
  // cover navigation, so it must not hide a possible allow/redirect from us.
  return condition.resourceTypes ? condition.resourceTypes.includes("main_frame") : Boolean(condition.excludedResourceTypes);
}
function popupRuleCondition(condition, context) {
  if (!popupMayNavigate(condition)) return false;
  let unknown = !condition.resourceTypes;
  const host = context.url.hostname;
  const domainsMatch = domains => domains.some(domain => {
    const lower = domain.toLowerCase();
    return host === lower || host.endsWith("." + lower);
  });
  for (const [key, value] of Object.entries(condition)) {
    if (value == null || key === "resourceTypes" || key === "excludedResourceTypes" || key === "isUrlFilterCaseSensitive") continue;
    if (key === "requestDomains") { if (!domainsMatch(value)) return false; }
    else if (key === "excludedRequestDomains") { if (domainsMatch(value)) return false; }
    else if (key === "tabIds") { if (!value.includes(context.tabId)) return false; }
    else if (key === "excludedTabIds") { if (value.includes(context.tabId)) return false; }
    else if (key === "requestMethods" || key === "excludedRequestMethods") {
      if (!context.method) unknown = true;
      else if (value.includes(context.method) === (key === "excludedRequestMethods")) return false;
    } else if (key === "urlFilter") {
      const result = popupUrlFilter(value, condition.isUrlFilterCaseSensitive, context);
      if (result === false) return false;
      if (result === null) unknown = true;
    } else unknown = true; // Includes regex, initiator/party, response headers and future fields.
  }
  return unknown ? null : true;
}
async function firefoxRulesBlock(details, previousUrls) {
  const dnr = api.declarativeNetRequest;
  const [enabled, dynamic, session] = await Promise.all([
    dnr.getEnabledRulesets(), dnr.getDynamicRules(), dnr.getSessionRules()
  ]);
  const resources = api.runtime.getManifest().declarative_net_request.rule_resources;
  const lists = await Promise.all(enabled.map(async id => {
    const resource = resources.find(item => item.id === id);
    if (!resource) throw new Error("Unknown enabled ruleset.");
    const [packaged, disabled] = await Promise.all([readPackagedPopupRules(resource), dnr.getDisabledRuleIds({ rulesetId: id })]);
    const disabledIds = new Set(disabled);
    return packaged.navigation.filter(rule => !disabledIds.has(rule.id));
  }));
  const urls = [details.url, ...previousUrls].map(value => new URL(value));
  // Credential serialization and root-dot/domain normalization differ between
  // engines; leave these unusual navigations intact rather than infer a match.
  if (urls.some(url => url.username || url.password || url.hostname.endsWith("."))) return false;
  for (const url of urls) url.hash = "";
  const method = details.method?.toLowerCase();
  const context = { url: urls[0], tabId: details.tabId, budget: 500000,
    method: ["connect", "delete", "get", "head", "options", "patch", "post", "put"].includes(method) ? method : null };
  let blockedPriority = 0, overridingPriority = 0;
  for (const rule of [...dynamic, ...session, ...lists.flat()]) {
    if (rule.action.type === "modifyHeaders") continue;
    context.url = urls[0];
    const matches = popupRuleCondition(rule.condition, context), priority = rule.priority ?? 1;
    if (rule.action.type === "block") {
      if (matches === true) blockedPriority = Math.max(blockedPriority, priority);
    } else {
      // An allow/allowAllRequests on an earlier redirect hop may carry request
      // or frame state. Do not infer a block by looking only at the last URL.
      let possible = matches !== false;
      for (const url of urls.slice(1)) {
        if (possible) break;
        context.url = url;
        if (popupRuleCondition({ ...rule.condition, requestMethods: null, excludedRequestMethods: null }, context) !== false) possible = true;
      }
      if (possible) overridingPriority = Math.max(overridingPriority, priority);
    }
  }
  return blockedPriority > overridingPriority;
}
async function confirmFirefoxPopup(item, details) {
  const pending = item.request;
  try {
    const blocked = await firefoxRulesBlock(details, pending.previousUrls);
    if (popupCandidate(item.id) !== item || item.request !== pending) return;
    if (!blocked) { blockedPopupTabs.delete(item.id); return; }
    pending.blocked = true;
    await closeBlockedPopup(item);
  } catch (error) {
    if (blockedPopupTabs.get(item.id) === item) blockedPopupTabs.delete(item.id);
    console.warn("[Module Engine] Could not verify Firefox pop-up cleanup:", error);
  }
}
async function closeBlockedPopup(item) {
  const request = item.request;
  if (!request?.blocked || !request.failed || request.closing) return;
  request.closing = true;
  try {
    const tab = await api.tabs.get(item.id);
    if (popupCandidate(item.id) !== item || item.request !== request) return;
    if (tab.pinned || tab.discarded || tab.openerTabId !== item.opener ||
        (tab.pendingUrl && navigationUrl(tab.pendingUrl) !== request.url) ||
        (!blankTabUrl(tab.url) && navigationUrl(tab.url) !== request.url)) {
      blockedPopupTabs.delete(item.id);
      return;
    }
    // Recheck after the asynchronous read. Tab updates, another navigation,
    // successful responses, or rule changes invalidate this exact candidate.
    blockedPopupTabs.delete(item.id);
    await api.tabs.remove(item.id);
    if (tab.incognito === false) await addLog({ kind: "event", message: "Closed a new pop-up tab after blocking its destination",
      host: urlParts(request.url).host, tabId: item.id });
  } catch (error) {
    if (blockedPopupTabs.get(item.id) === item) blockedPopupTabs.delete(item.id);
    console.warn("[Module Engine] Could not close a blocked pop-up tab:", error);
  }
}
async function popupRuleMatched({ rule, request }) {
  const item = popupRequest(request);
  if (!item) return;
  const pending = item.request;
  try {
    if (await matchedBlock(rule) && popupCandidate(item.id) === item && item.request === pending) {
      pending.blocked = true;
      await closeBlockedPopup(item);
    }
  } catch (error) { console.warn("[Module Engine] Could not verify a blocked pop-up rule:", error); }
}
function popupNavigationFailed(details) {
  const item = popupRequest(details);
  if (!item) return;
  if (firefoxPopupCleanup) {
    // Firefox uses NS_ERROR_ABORT for DNR blocks AND unrelated cancellations.
    // Require our active policy to independently prove this exact URL blocked.
    if (details.error !== "NS_ERROR_ABORT" || !item.request.started) { blockedPopupTabs.delete(item.id); return; }
    item.request.failed = true;
    void confirmFirefoxPopup(item, details);
    return;
  }
  if (details.error !== "net::ERR_BLOCKED_BY_CLIENT") { blockedPopupTabs.delete(item.id); return; }
  item.request.failed = true;
  void closeBlockedPopup(item);
}
function popupTabUpdated(id, change, tab) {
  const item = popupCandidate(id);
  if (!item) return;
  if (tab.pinned || tab.discarded || tab.openerTabId !== item.opener ||
      (change.url !== undefined && (item.request ? navigationUrl(change.url) !== item.request.url : !blankTabUrl(change.url)))) {
    blockedPopupTabs.delete(id);
  }
}
function popupResponseStarted(details) {
  if (details.type === "main_frame" && details.frameId === 0 && ![301, 302, 303, 307, 308].includes(details.statusCode)) {
    blockedPopupTabs.delete(details.tabId);
  }
}
async function changeNetworkRules(update) {
  // Rule IDs may be reused. Never correlate a pending event against a different
  // rule action while settings are being applied or rolled back.
  blockedPopupTabs.clear();
  networkRuleUpdates++;
  try { return await update(); }
  finally { networkRuleUpdates--; }
}

function describeChanges(before, after, includeFilterCounts = true) {
  const changes = [];
  const onOff = value => value ? "on" : "off";
  if (before.enabled !== after.enabled) changes.push(`Protection turned ${onOff(after.enabled)}`);
  for (const id of RULESET_IDS) {
    if (before.rulesets[id] !== after.rulesets[id]) changes.push(`${LAYER_NAMES[id]} layer turned ${onOff(after.rulesets[id])}`);
  }
  if (before.cosmeticFiltering !== after.cosmeticFiltering) changes.push(`Cosmetic hiding turned ${onOff(after.cosmeticFiltering)}`);
  if (before.genericCosmeticFiltering !== after.genericCosmeticFiltering) changes.push(`Generic cosmetic filtering turned ${onOff(after.genericCosmeticFiltering)}`);
  if (before.proceduralFiltering !== after.proceduralFiltering) changes.push(`Advanced page hiding turned ${onOff(after.proceduralFiltering)}`);
  if (before.scriptletFiltering !== after.scriptletFiltering) changes.push(`Scriptlet filters turned ${onOff(after.scriptletFiltering)}`);
  if (before.notificationPromptBlocking !== after.notificationPromptBlocking) changes.push(`Notification request protection turned ${onOff(after.notificationPromptBlocking)}`);
  if (before.deceptivePromptBlocking !== after.deceptivePromptBlocking) changes.push(`Deceptive install prompt protection turned ${onOff(after.deceptivePromptBlocking)}`);
  if (before.deceptiveButtonBlocking !== after.deceptiveButtonBlocking) changes.push(`Deceptive button protection turned ${onOff(after.deceptiveButtonBlocking)}`);
  if (includeFilterCounts && before.customCosmeticFilters !== after.customCosmeticFilters) changes.push(`Saved ${customCosmeticRules(after.customCosmeticFilters).length} custom cosmetic rules`);
  if (includeFilterCounts && before.customNetworkFilters !== after.customNetworkFilters) changes.push(`Saved ${customNetworkRules(after.customNetworkFilters).length} custom network rules`);
  if (before.flagSuspects !== after.flagSuspects) changes.push(`Flagging suspected ads turned ${onOff(after.flagSuspects)}`);
  if (before.communityListUpdates !== after.communityListUpdates) changes.push(`Automatic filter-list updates turned ${onOff(after.communityListUpdates)}`);
  if (before.retireExpiredThreats !== after.retireExpiredThreats) changes.push(`Stopping reported threats when their evidence expires turned ${onOff(after.retireExpiredThreats)}`);
  const lists = [["customBlockedDomains", "Custom block added", "Custom block removed"],
    ["cosmeticPausedDomains", "Hiding disabled on", "Hiding enabled on"],
    ["promptAllowedDomains", "Prompts and buttons allowed on", "Prompt and button protection restored on"],
    ["whitelistedDomains", "Paused on", "Resumed on"],
    ["popupBlockedDomains", "Pop-up blocking turned on for", "Pop-up blocking turned off for"],
    ["allowedDomains", "Always allowed", "No longer always allowed"]];
  for (const [key, added, removed] of lists) {
    const oldDomains = new Set(before[key]), newDomains = new Set(after[key]);
    for (const domain of newDomains) if (!oldDomains.has(domain)) changes.push(`${added} ${domain}`);
    for (const domain of oldDomains) if (!newDomains.has(domain)) changes.push(`${removed} ${domain}`);
  }
  return changes;
}

// Reported-threat policies, bundled or updated, have exactly these fields and
// dates that fit the evidence window. `label` names the list in errors.
function threatPolicyDates(policy, label) {
  const keys = ["schemaVersion", "ruleCount", "evidenceFrom", "reviewedAt", "expiresAt"];
  if (!policy || typeof policy !== "object" || Object.keys(policy).length !== keys.length || keys.some(key => !(key in policy)) ||
      policy.schemaVersion !== 1 || !Number.isInteger(policy.ruleCount) || policy.ruleCount < 1 || policy.ruleCount > 100) {
    throw new Error(`The ${label} evidence policy is invalid.`);
  }
  const [observed, reviewed, expires] = [policy.evidenceFrom, policy.reviewedAt, policy.expiresAt].map(value => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace("Z", ".000Z")) {
      throw new Error(`The ${label} evidence dates are invalid.`);
    }
    return Date.parse(value);
  });
  if (observed > reviewed || reviewed > Date.now() || expires <= reviewed || expires - observed > THREAT_MAX_AGE_DAYS * 86400000) {
    throw new Error(`The ${label} evidence dates violate the ${THREAT_MAX_AGE_DAYS}-day review policy.`);
  }
  return { reviewed, expires };
}

// The update folder this build names, checked like any download address; ""
// when it names none.
function threatUpdateSource() {
  const configured = globalThis.ModuleEngineUpdateConfig?.threatSource;
  return configured ? ModuleEngineThreatUpdates.sourceUrl(configured) : "";
}

// What the interface shows about updates: where they come from and how the
// last check went. An invalid address in the build is reported, not used.
async function threatUpdateState() {
  let source = "", error = "";
  try { source = threatUpdateSource(); } catch (problem) { error = `This build's update address is invalid. ${problem.message}`; }
  const saved = (await api.storage.local.get([THREAT_UPDATE_STATUS_KEY]))[THREAT_UPDATE_STATUS_KEY] || {};
  return { configured: Boolean(source), host: source ? new URL(source).host : "",
    checkedAt: typeof saved.checkedAt === "string" ? saved.checkedAt : null,
    result: ["installed", "current", "error"].includes(saved.result) ? saved.result : null,
    error: error || (typeof saved.error === "string" ? saved.error : ""), notice: "" };
}

// The installed signed update, verified once per worker and list: the signature
// covers the evidence file, which binds the rules and policy by SHA-256. A list
// that no longer verifies, for example after a release stops trusting the key
// that signed it, is set aside and the bundled list is used.
let installedThreats = { text: null, value: null };
async function loadInstalledThreats() {
  const saved = (await api.storage.local.get([THREAT_UPDATE_KEY]))[THREAT_UPDATE_KEY];
  if (!saved) return { list: null, error: "" };
  const text = JSON.stringify(saved);
  if (installedThreats.text !== text) {
    let value;
    try {
      const { policy, rules } = await ModuleEngineThreatUpdates.verify(ModuleEngineThreatUpdates.restore(saved));
      value = { list: { policy, rules: ModuleEngineThreatUpdates.dynamicRules(rules) }, error: "" };
    } catch (error) {
      value = { list: null, error: `The installed update was set aside. ${error.message || String(error)}` };
    }
    installedThreats = { text, value };
  }
  return installedThreats.value;
}

// The reported-threat list in use: the bundled list, or an installed signed
// update reviewed later than it. The bundled list is the static threats_ruleset;
// an update's rules are returned as dynamic rules in `rules`.
async function loadThreats() {
  const updates = await threatUpdateState();
  try {
    // This is a packaged extension file, never a network feed or candidate host.
    const response = await fetch(api.runtime.getURL("rules/threat-policy.json"), { redirect: "error" });
    if (!response.ok) throw new Error("The bundled evidence policy could not be read.");
    const text = await response.text();
    if (text.length > 4096) throw new Error("The bundled evidence policy is oversized.");
    let policy = JSON.parse(text), rules = null;
    let { reviewed, expires } = threatPolicyDates(policy, "bundled");
    const installed = await loadInstalledThreats();
    updates.notice = installed.error;
    if (installed.list && Date.parse(installed.list.policy.reviewedAt) > reviewed) {
      ({ policy, rules } = installed.list);
      ({ expires } = threatPolicyDates(policy, "updated"));
    }
    // Alarms may be lost across browser restarts. Recheck on every worker start
    // and command; the repeating guard also handles wall-clock changes.
    if (!(await api.alarms.get(THREAT_CHECK_ALARM))) {
      await api.alarms.create(THREAT_CHECK_ALARM, { periodInMinutes: 60 });
    }
    if (expires > Date.now()) {
      const alarm = await api.alarms.get(THREAT_EXPIRY_ALARM);
      if (alarm?.scheduledTime !== expires) await api.alarms.create(THREAT_EXPIRY_ALARM, { when: expires });
    } else {
      await api.alarms.clear(THREAT_EXPIRY_ALARM);
    }
    // The list stops at its expiry until applyThreatExpiryChoice applies the
    // person's choice.
    return { status: { available: expires > Date.now(), count: policy.ruleCount, expiresAt: policy.expiresAt, retireAt: policy.expiresAt,
      reviewedAt: policy.reviewedAt, source: rules ? "update" : "bundled", error: "", updates }, rules };
  } catch (error) {
    return { status: { available: false, count: 0, expiresAt: null, retireAt: null, reviewedAt: null, source: null,
      error: `Reported threats are inactive. ${error.message || String(error)}`, updates }, rules: null };
  }
}

// An installed threat update's dynamic rules use IDs 900,001 to 900,999 (at most
// 100 rules); filter-list updates use 1,000,001 and up, and the person's own
// dynamic rules count up from 1.
const isThreatRule = rule => rule.id > ModuleEngineThreatUpdates.RULE_ID_BASE && rule.id < ModuleEngineThreatUpdates.RULE_ID_BASE + 1000;

// `retireAt` is when a checked list stops blocking: its expiry if the person
// asked for that, otherwise null, so it blocks until a newer list replaces it.
// A slow browser write may cross that moment, so it is checked again on use.
const threatRetired = status => Boolean(status?.retireAt) && Date.parse(status.retireAt) <= Date.now();

// Applies the saved or requested choice about expired evidence. A list that
// failed its checks never blocks, whatever the choice.
function applyThreatExpiryChoice(status, settings) {
  if (status.error) return;
  status.retireAt = settings.retireExpiredThreats ? status.expiresAt : null;
  status.available = !threatRetired(status);
}

function constrainThreatRules(target, status) {
  if (status?.available && threatRetired(status)) status.available = false;
  return { ...target, enabled: target.enabled.filter(id => id !== "threats_ruleset" || status?.available),
    dynamic: target.dynamic.filter(rule => !isThreatRule(rule) || status?.available) };
}

async function retireInactiveThreats(status) {
  if (status.available && !threatRetired(status)) return;
  status.available = false;
  if ((await api.declarativeNetRequest.getEnabledRulesets()).includes("threats_ruleset")) {
    await changeNetworkRules(() => api.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [], disableRulesetIds: ["threats_ruleset"] }));
    if ((await api.declarativeNetRequest.getEnabledRulesets()).includes("threats_ruleset")) {
      throw new Error("The browser did not disable inactive reported-threat rules.");
    }
  }
  const updated = (await api.declarativeNetRequest.getDynamicRules()).filter(isThreatRule);
  if (updated.length) {
    dynamicBlockIds = null;
    await changeNetworkRules(() => api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: updated.map(rule => rule.id), addRules: [] }));
    if ((await api.declarativeNetRequest.getDynamicRules()).some(isThreatRule)) {
      throw new Error("The browser did not remove inactive reported-threat rules.");
    }
  }
}

// One update check at a time. Downloads run outside the settings queue; the
// decision and installation run inside it, against the list in use then.
let threatCheck = null;
function checkThreatUpdate() {
  threatCheck ??= runThreatCheck().finally(() => { threatCheck = null; });
  return threatCheck;
}

// Due a day after the last check, while Reported Threats is on and this build
// names an update folder. Nothing is requested otherwise.
function threatCheckDue(settings, status) {
  if (threatCheck || !settings.enabled || !settings.rulesets.threats_ruleset || !status.updates?.configured) return false;
  const last = Date.parse(status.updates.checkedAt);
  // A clock that moved backwards makes the last check look future-dated.
  return !Number.isFinite(last) || last > Date.now() || Date.now() - last >= THREAT_UPDATE_INTERVAL;
}

async function runThreatCheck() {
  const checkedAt = new Date(Date.now()).toISOString();
  let outcome;
  try {
    const source = threatUpdateSource();
    if (!source) throw new Error("This build has no update address.");
    const files = await ModuleEngineThreatUpdates.fetchUpdate(source);
    outcome = await enqueue(() => installThreatUpdate(files, source));
  } catch (error) {
    outcome = { result: "error", error: error.message || String(error) };
    await addLog({ kind: "event", message: `Reported-threat update check failed: ${outcome.error}` });
  }
  await api.storage.local.set({ [THREAT_UPDATE_STATUS_KEY]: { checkedAt, ...outcome } });
  return reconcile();
}

// Installs a downloaded list that is signed, current and newer than the list in
// use, then applies it. If the browser does not take it, the previous list is
// put back, so a bad update never costs the layer its last good list.
async function installThreatUpdate(files, source) {
  const current = (await loadThreats()).status;
  const result = await ModuleEngineThreatUpdates.check(files, { currentReviewedAt: current.reviewedAt });
  if (!result.newer) return { result: "current", error: "" };
  const previous = (await api.storage.local.get([THREAT_UPDATE_KEY]))[THREAT_UPDATE_KEY];
  await api.storage.local.set({ [THREAT_UPDATE_KEY]: { ...ModuleEngineThreatUpdates.store(files), source, installedAt: new Date(Date.now()).toISOString() } });
  const applied = await processRequest({ type: "GET_STATE" });
  if (applied.ok && applied.threatStatus.source === "update" && applied.threatStatus.reviewedAt === result.policy.reviewedAt) {
    await addLog({ kind: "event", message: `Installed the reported-threat list reviewed ${result.policy.reviewedAt.slice(0, 10)}: ${result.catalog.domains.length} exact hosts` });
    return { result: "installed", error: "" };
  }
  if (previous) await api.storage.local.set({ [THREAT_UPDATE_KEY]: previous });
  else await api.storage.local.remove(THREAT_UPDATE_KEY);
  await processRequest({ type: "GET_STATE" });
  throw new Error(`The new list could not be used. ${applied.ok ? applied.threatStatus.error : applied.error}`.trim());
}

// The installed filter-list change for this request, and what the interface
// shows: the lists in use and how the last check went. If the bundled list
// description cannot be read, the bundled rules stay as they are.
async function loadCommunity(settings) {
  const saved = (await api.storage.local.get([COMMUNITY_STATUS_KEY]))[COMMUNITY_STATUS_KEY] || {};
  const updates = { enabled: settings.communityListUpdates, checkedAt: typeof saved.checkedAt === "string" ? saved.checkedAt : null,
    result: ["installed", "current", "error"].includes(saved.result) ? saved.result : null,
    error: typeof saved.error === "string" ? saved.error : "", interval: Number.isFinite(saved.interval) ? saved.interval : null, notice: "" };
  try {
    const info = await loadBundledCommunityInfo();
    const update = await loadCommunityUpdate();
    const lists = (update?.lists || info.lists).map(({ id, title, version, lastModified }) => ({ id, title, version: version ?? null, lastModified: lastModified ?? null,
      updates: info.lists.find(list => list.id === id)?.updates ?? "download" }));
    return { update, status: { source: update ? "update" : "bundled", id: update?.id ?? null, lists,
      networkRules: update?.info?.networkRules ?? info.networkRules ?? null, cosmeticSelectors: update?.info?.cosmeticSelectors ?? info.cosmeticSelectors ?? null,
      changed: update ? { disabled: update.disable.length, added: update.add.length } : null, networkApplied: Boolean(update), updates } };
  } catch (error) {
    return { update: null, status: { source: null, id: null, lists: [], networkRules: null, cosmeticSelectors: null, changed: null, networkApplied: false,
      updates: { ...updates, notice: error.message || String(error) } } };
  }
}

// One filter-list check at a time. Downloads and conversion run outside the
// settings queue; installation runs inside it, against the lists in use then.
let communityCheck = null;
function checkCommunityLists() {
  communityCheck ??= runCommunityCheck().finally(() => { communityCheck = null; });
  return communityCheck;
}

// Due once the lists' own interval has passed since the last successful check,
// or 12 hours after a failed one, while the community layer and automatic
// updates are on. Nothing is requested otherwise.
function communityCheckDue(settings, status) {
  if (communityCheck || !settings.enabled || !settings.rulesets.community_ruleset || !settings.communityListUpdates ||
      !status.lists.some(list => list.updates === "download")) return false;
  const { checkedAt, result, interval } = status.updates;
  const last = Date.parse(checkedAt);
  // A clock that moved backwards makes the last check look future-dated.
  if (!Number.isFinite(last) || last > Date.now()) return true;
  return Date.now() - last >= (result === "error" ? COMMUNITY_RETRY : interval || ModuleEngineCommunityUpdates.checkInterval(""));
}

async function runCommunityCheck() {
  const checkedAt = new Date(Date.now()).toISOString();
  let outcome;
  try {
    const { download, checkList, checkInterval, compareVersions } = ModuleEngineCommunityUpdates;
    const info = await loadBundledCommunityInfo();
    const downloaded = [];
    for (const list of info.lists.filter(item => item.updates === "download")) {
      const { text } = await download(list.source);
      downloaded.push({ id: list.id, title: list.title, text, header: checkList(text, list) });
    }
    if (!downloaded.length) throw new Error("This version has no filter list to download.");
    const interval = Math.min(...downloaded.map(list => checkInterval(list.header.expires)));
    const inUse = (await loadCommunityUpdate())?.lists || info.lists;
    if (!compareVersions(inUse, downloaded.map(list => ({ id: list.id, title: list.title, version: list.header.version })))) {
      outcome = { result: "current", error: "", interval };
    } else {
      // The bundled rules and release-only snapshots are read only once newer lists
      // have arrived. All lists are converted together, in the build's order.
      const bundled = await loadBundledCommunity();
      const lists = [];
      for (const list of info.lists) {
        lists.push(downloaded.find(item => item.id === list.id) || { id: list.id, title: list.title, text: await readPackagedList(list) });
      }
      const converted = BlockAdsCommunityLists.convert(lists, { protectedDomains: bundled.protectedDomains, compileSelector: BlockAdsCosmetic.compileSelector,
        parseScriptlet: BlockAdsScriptlets.parseBody });
      outcome = { ...(await enqueue(() => installCommunityUpdate(bundled, converted, checkedAt))), interval };
    }
  } catch (error) {
    outcome = { result: "error", error: error.message || String(error) };
    await addLog({ kind: "event", message: `Filter-list update check failed: ${outcome.error}` });
  }
  await api.storage.local.set({ [COMMUNITY_STATUS_KEY]: { checkedAt, ...outcome } });
  return reconcile();
}

// Installs converted lists that are newer than the lists in use and keep most
// of the bundled rules, as a change from the bundled ruleset, then applies it.
// If the browser does not take it, the previous lists are put back.
async function installCommunityUpdate(bundled, converted, checkedAt) {
  const { compareVersions, checkSize, difference } = ModuleEngineCommunityUpdates;
  const current = await loadCommunityUpdate();
  const versions = converted.info.lists.map(list => ({ ...list, version: list.version ?? null, lastModified: list.lastModified ?? null }));
  // Release-only lists are the packaged ones, so only downloaded lists have versions to compare.
  const downloaded = versions.filter(list => bundled.info.lists.find(item => item.id === list.id)?.updates === "download");
  if (!compareVersions(current?.lists || bundled.info.lists, downloaded)) return { result: "current", error: "" };
  checkSize(converted.info, bundled.info);
  const change = difference(bundled.rules, converted.rules);
  if (change.disable.length && typeof api.declarativeNetRequest.updateStaticRules !== "function") {
    throw new Error("This browser cannot switch off single bundled rules, so filter-list updates need a newer browser version.");
  }
  const maxDisabled = api.declarativeNetRequest.MAX_NUMBER_OF_DISABLED_STATIC_RULES ?? 5000;
  if (change.disable.length > maxDisabled) {
    throw new Error(`The lists changed too much since this release: ${change.disable.length.toLocaleString("en")} bundled rules would be switched off, ` +
      `and this browser allows ${maxDisabled.toLocaleString("en")}. The bundled lists stay in use until a new release.`);
  }
  const previous = await api.storage.local.get([COMMUNITY_UPDATE_KEY, COMMUNITY_COSMETIC_KEY]);
  const id = checkedAt;
  const { hide, allow, scoped, procedural, scriptlets, disableGeneric, disableAll } = converted.cosmetic;
  const lists = versions.map(list => ({ ...list, source: bundled.info.lists.find(item => item.id === list.id)?.source ?? null }));
  await api.storage.local.set({
    [COMMUNITY_UPDATE_KEY]: { schemaVersion: 1, id, baseline: communityBaseline(bundled.info), lists, disable: change.disable, add: change.add,
      info: { networkRules: converted.info.networkRules, cosmeticSelectors: converted.info.cosmeticSelectors } },
    [COMMUNITY_COSMETIC_KEY]: { id, hide, allow, scoped, procedural, scriptlets, disableGeneric, disableAll }
  });
  communityCosmetic = null;
  const applied = await processRequest({ type: "GET_STATE" });
  if (applied.ok && applied.communityStatus?.id === id && applied.communityStatus.networkApplied) {
    await addLog({ kind: "event", message: `Installed ${downloaded.map(list => `${list.title} ${list.version}`).join(" and ")}: ` +
      `${change.disable.length} bundled rules switched off, ${change.add.length} rules added` });
    return { result: "installed", error: "" };
  }
  if (previous[COMMUNITY_UPDATE_KEY]) await api.storage.local.set(previous);
  else await api.storage.local.remove([COMMUNITY_UPDATE_KEY, COMMUNITY_COSMETIC_KEY]);
  communityCosmetic = null;
  await processRequest({ type: "GET_STATE" });
  throw new Error(`The new lists could not be used. ${applied.ok ? applied.communityStatus?.updates.notice || "" : applied.error}`.trim());
}

function enqueue(operation) {
  const result = operationQueue.then(operation);
  // Failure must not prevent a later request from repairing state.
  operationQueue = result.catch(() => {});
  return result;
}

function validateSettings(settings) {
  for (const key of ["enabled", "cosmeticFiltering", "genericCosmeticFiltering", "proceduralFiltering", "scriptletFiltering", "notificationPromptBlocking", "deceptivePromptBlocking", "deceptiveButtonBlocking", "flagSuspects", "communityListUpdates", "retireExpiredThreats"]) {
    if (typeof settings[key] !== "boolean") throw new Error(`${key} must be true or false.`);
  }
  for (const id of RULESET_IDS) {
    if (typeof settings.rulesets?.[id] !== "boolean") throw new Error(`Invalid setting for ${id}.`);
  }
  customCosmeticRules(settings.customCosmeticFilters);
  customNetworkRules(settings.customNetworkFilters);
  const valid = {
    enabled: settings.enabled,
    rulesets: Object.fromEntries(RULESET_IDS.map(id => [id, settings.rulesets[id]])),
    cosmeticFiltering: settings.cosmeticFiltering,
    genericCosmeticFiltering: settings.genericCosmeticFiltering,
    proceduralFiltering: settings.proceduralFiltering,
    scriptletFiltering: settings.scriptletFiltering,
    notificationPromptBlocking: settings.notificationPromptBlocking,
    deceptivePromptBlocking: settings.deceptivePromptBlocking,
    deceptiveButtonBlocking: settings.deceptiveButtonBlocking,
    customCosmeticFilters: settings.customCosmeticFilters,
    customNetworkFilters: settings.customNetworkFilters,
    flagSuspects: settings.flagSuspects,
    communityListUpdates: settings.communityListUpdates,
    retireExpiredThreats: settings.retireExpiredThreats,
    ...Object.fromEntries(DOMAIN_LIST_KEYS.map(key => [key, normalizeDomains(settings[key])]))
  };
  // A custom block always wins, so allowing a domain it covers would have no effect.
  for (const domain of valid.allowedDomains) {
    const blocker = valid.customBlockedDomains.find(blocked => domainMatches(domain, blocked));
    if (blocker) {
      throw new Error(blocker === domain
        ? `${domain} is in both Custom Blocked Domains and Always Allowed Domains. Remove it from one list first.`
        : `${domain} is covered by the custom block on ${blocker}, which always wins. Remove that block first.`);
    }
  }
  return valid;
}

async function loadSettings() {
  const stored = await api.storage.local.get([...SETTING_KEYS, "quarantinedDomains"]);
  const settings = {
    ...DEFAULT_SETTINGS, ...stored,
    rulesets: { ...DEFAULT_SETTINGS.rulesets, ...stored.rulesets }
  };
  const quarantined = Array.isArray(stored.quarantinedDomains) ? stored.quarantinedDomains.map(String) : [];
  // Older versions saved invalid entries before DNR rejected them. Preserve them
  // separately and visibly so one entry cannot poison every future update.
  for (const key of DOMAIN_LIST_KEYS) {
    const entries = Array.isArray(settings[key]) ? settings[key] : [settings[key]];
    settings[key] = [];
    for (const entry of entries) {
      try {
        settings[key].push(normalizeDomain(entry));
      } catch {
        const description = `${key}: ${String(entry)}`;
        if (!quarantined.includes(description)) quarantined.push(description);
      }
    }
  }
  return { settings: validateSettings(settings), quarantined };
}

// Chrome allows 30,000 dynamic rules, Firefox 5,000.
const dynamicRuleLimit = () => api.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ??
  api.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES ?? 5000;

// `reserved` counts dynamic rules added beside these: an installed threat update.
function makeDynamicRules(settings, reserved = 0) {
  if (!settings.enabled) return [];
  const rules = [];
  const add = rule => rules.push({ id: rules.length + 1, ...rule });
  for (const domain of settings.whitelistedDomains) {
    add({
      priority: 10000, action: { type: "allow" },
      condition: {
        initiatorDomains: [domain],
        resourceTypes: ALL_RESOURCE_TYPES.filter(type => type !== "main_frame")
      }
    });
    add({
      priority: 10000, action: { type: "allowAllRequests" },
      condition: { requestDomains: [domain], resourceTypes: ["main_frame", "sub_frame"] }
    });
  }
  for (const domain of settings.customBlockedDomains) {
    add({
      priority: 50, action: { type: "block" },
      condition: { requestDomains: [domain], resourceTypes: ALL_RESOURCE_TYPES }
    });
  }
  for (const domain of settings.allowedDomains) {
    add({
      priority: ALLOWED_DOMAIN_PRIORITY, action: { type: "allow" },
      condition: { requestDomains: [domain], resourceTypes: ALL_RESOURCE_TYPES }
    });
  }
  for (const rule of customNetworkRules(settings.customNetworkFilters)) add(rule);
  if (settings.popupBlockedDomains.length) {
    add({
      // Above request-level allows (4), below site pauses (10000). This changes
      // navigation privileges, not whether an ad/media request is blocked.
      priority: 100,
      action: { type: "modifyHeaders", responseHeaders: [
        { header: "content-security-policy", operation: "append", value: PAGE_GUARD_SANDBOX }
      ] },
      condition: { requestDomains: settings.popupBlockedDomains, resourceTypes: ["main_frame"],
        ...(settings.whitelistedDomains.length ? { excludedRequestDomains: settings.whitelistedDomains } : {}) }
    });
  }
  const limit = dynamicRuleLimit();
  if (rules.length + reserved > limit) {
    throw new Error(`Too many custom network and domain rules for this browser (limit ${limit}${reserved ? `, including ${reserved} reported-threat rules` : ""}).`);
  }
  return rules;
}

// Match patterns cannot put a wildcard before an IPv4 address or bare name.
const sitePatterns = domain => /^[0-9.]+$/.test(domain) || !domain.includes(".")
  ? [`*://${domain}/*`] : [`*://*.${domain}/*`];
// One pattern per site, leaving out sites whose listed parent already has a
// subdomain wildcard pattern.
const sitesPatterns = domains => {
  const listed = new Set(domains);
  const covered = domain => domain.split(".").some((_, i, labels) => {
    const parent = labels.slice(i).join(".");
    return i > 0 && listed.has(parent) && sitePatterns(parent)[0].startsWith("*://*.");
  });
  return [...new Set([...listed].filter(domain => !covered(domain)).flatMap(sitePatterns))].sort();
};

// Sites where the bundled generic stylesheets are not injected, or null when they
// are not registered. Generic hiding stays off on paused and generichide/elemhide
// sites. A custom exception for a bundled generic selector cannot be expressed in
// a stylesheet, so its sites receive generic selectors in their frame state.
function genericSheetScope(settings, data) {
  const bundle = BlockAdsCosmetic.staticBundle(data);
  if (!bundle || !settings.enabled || !settings.cosmeticFiltering || !settings.rulesets.community_ruleset ||
      !settings.genericCosmeticFiltering) return null;
  const customSites = customCosmeticRules(settings.customCosmeticFilters)
    .filter(rule => rule.exception && bundle.generic.has(rule.selector)).flatMap(rule => rule.include);
  const base = [...settings.whitelistedDomains, ...settings.cosmeticPausedDomains,
    ...(data.disableGeneric || []), ...(data.disableAll || []), ...customSites];
  return { base, excepted: [...base, ...bundle.sites] };
}

// Whether the stylesheets were injected into a frame at this URL, judged from the
// current registration. The frame confirms it once their companion script runs.
function genericSheetsExpected(settings, data, url) {
  const scope = genericSheetScope(settings, data);
  if (!scope || !/^https?:\/\//i.test(url || "")) return false;
  const host = urlParts(url).host;
  return !scope.base.some(domain => domainMatches(host, domain));
}

function makePageScripts(settings, data) {
  if (!settings.enabled) return [];
  // A paused scope is excluded from injection, like its network exception.
  const pausedWithin = sites => settings.whitelistedDomains.filter(paused =>
    sites.some(site => domainMatches(paused, site) || domainMatches(site, paused)));
  const scripts = [];
  if (settings.rulesets.ads_ruleset) {
    scripts.push({
      id: YOUTUBE_SCRIPT_ID,
      matches: YOUTUBE_DOMAINS.flatMap(sitePatterns),
      excludeMatches: pausedWithin(YOUTUBE_DOMAINS).flatMap(sitePatterns),
      js: ["src/blocking/youtube.js"],
      css: [],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true
    });
  }
  if (settings.popupBlockedDomains.length) {
    scripts.push({
      id: POPUP_SCRIPT_ID,
      matches: settings.popupBlockedDomains.flatMap(sitePatterns),
      excludeMatches: pausedWithin(settings.popupBlockedDomains).flatMap(sitePatterns),
      js: ["src/blocking/popups.js"],
      css: [],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true
    });
  }
  if (settings.notificationPromptBlocking) {
    scripts.push({
      id: "notification-guard",
      matches: ["http://*/*", "https://*/*"],
      excludeMatches: [...new Set([...settings.whitelistedDomains, ...settings.promptAllowedDomains])].flatMap(sitePatterns),
      js: ["src/blocking/notification-guard.js"],
      css: [],
      runAt: "document_start",
      world: "MAIN",
      // A native frame registration cannot see a cross-origin parent's pause.
      // Start in the top document; the hook handles accessible child realms.
      allFrames: false
    });
  }
  const generic = genericSheetScope(settings, data);
  if (generic) {
    // A frame matches its own URL here, so a cross-origin frame of a paused page
    // still receives the sheets; its content script then revokes them through
    // the root attribute. about:blank frames keep today's coverage: none.
    const sheet = (id, excluded, css, js) => ({ id, matches: ["http://*/*", "https://*/*"], excludeMatches: sitesPatterns(excluded),
      js, css: [css], runAt: "document_start", world: "ISOLATED", allFrames: true });
    // The companion script tells the frame's content script that the sheets are present.
    scripts.push(sheet(GENERIC_SCRIPT_ID, generic.base, "rules/community-generic.css", ["src/blocking/generic-static.js"]));
    scripts.push(sheet(GENERIC_EXCEPTED_SCRIPT_ID, generic.excepted, "rules/community-generic-excepted.css", []));
  }
  return scripts;
}

// Browsers differ in which defaults and URL forms they echo back.
function normalizeScript(script) {
  const base = api.runtime.getURL("");
  const files = list => (list || []).map(file => file.startsWith(base) ? file.slice(base.length) : file.replace(/^\//, ""));
  return {
    id: script.id,
    matches: script.matches || [],
    excludeMatches: script.excludeMatches || [],
    js: files(script.js),
    css: files(script.css),
    runAt: script.runAt || "document_idle",
    world: script.world || "ISOLATED",
    allFrames: Boolean(script.allFrames)
  };
}

// A value as JSON text with object keys sorted and arrays compared as unordered:
// each array's items are sorted by their own text, computed once. As JSON does,
// an undefined property is left out and an undefined item reads as null.
function canonicalText(value) {
  if (Array.isArray(value)) return `[${value.map(item => item === undefined ? "null" : canonicalText(item)).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonicalText(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const same = (a, b) => canonicalText(a) === canonicalText(b);

async function readRules() {
  const dynamic = await api.declarativeNetRequest.getDynamicRules();
  return {
    enabled: await api.declarativeNetRequest.getEnabledRulesets(),
    // Firefox returns null for absent optional fields; Chromium omits them.
    // Strip only absent fields, retaining every actual condition for verification.
    dynamic: JSON.parse(JSON.stringify(dynamic, (_key, value) => value === null ? undefined : value)),
    scripts: (await api.scripting.getRegisteredContentScripts()).map(normalizeScript),
    // Bundled community rules a filter-list update switched off.
    disabled: typeof api.declarativeNetRequest.getDisabledRuleIds === "function"
      ? [...await api.declarativeNetRequest.getDisabledRuleIds({ rulesetId: "community_ruleset" })].sort((a, b) => a - b) : []
  };
}

async function applyRules(target, threatStatus) {
  const current = await readRules();
  if (!same(current.dynamic, target.dynamic)) {
    dynamicBlockIds = null;
    await changeNetworkRules(() => api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.dynamic.map(rule => rule.id), addRules: target.dynamic
    }));
  }
  if (!same(current.scripts, target.scripts)) {
    const existing = new Map(current.scripts.map(script => [script.id, script]));
    const desired = new Set(target.scripts.map(script => script.id));
    const removed = current.scripts.filter(script => !desired.has(script.id)).map(script => script.id);
    const changed = target.scripts.filter(script => existing.has(script.id) && !same(existing.get(script.id), script));
    const added = target.scripts.filter(script => !existing.has(script.id));
    // Preserve document_start coverage while other protections change. Updates
    // retain the registration; an explicit [] clears a previous site exclusion.
    // applyRules is also used by rollback, so partially completed writes reconcile.
    // A script lists only the file types it has.
    const files = ({ js, css, ...script }) => ({ ...script, ...(js.length ? { js } : {}), ...(css.length ? { css } : {}) });
    if (removed.length) await api.scripting.unregisterContentScripts({ ids: removed });
    if (changed.length) await api.scripting.updateContentScripts(changed.map(script => ({ ...files(script), persistAcrossSessions: true })));
    if (added.length) {
      await api.scripting.registerContentScripts(added.map(({ excludeMatches, ...script }) => ({
        ...files(script), ...(excludeMatches.length ? { excludeMatches } : {}), persistAcrossSessions: true
      })));
    }
  }
  if (!same(current.disabled, target.disabled)) {
    // After the dynamic rules, so replacement rules exist before their bundled
    // originals are switched off. Browsers persist this until an extension update.
    const before = new Set(current.disabled), after = new Set(target.disabled);
    await changeNetworkRules(() => api.declarativeNetRequest.updateStaticRules({ rulesetId: "community_ruleset",
      disableRuleIds: target.disabled.filter(id => !before.has(id)), enableRuleIds: current.disabled.filter(id => !after.has(id)) }));
  }
  target = constrainThreatRules(target, threatStatus);
  if (!same(current.enabled, target.enabled)) {
    await changeNetworkRules(() => api.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: target.enabled,
      disableRulesetIds: RULESET_IDS.filter(id => !target.enabled.includes(id))
    }));
  }
  // A slow browser write may cross the expiry boundary. Never restore expired
  // threats during rollback, even if an unrelated settings write failed.
  await retireInactiveThreats(threatStatus);
  target = constrainThreatRules(target, threatStatus);
  if (!same(await readRules(), target)) throw new Error("The browser did not apply the requested rules.");
}

async function updateBadge(settings, failed = false) {
  try {
    if (api.declarativeNetRequest.setExtensionActionOptions) {
      await api.declarativeNetRequest.setExtensionActionOptions({
        displayActionCountAsBadgeText: !failed && settings.enabled
      });
    }
    await api.action.setBadgeBackgroundColor({ color: failed ? "#b91c1c" : settings.enabled ? "#059669" : "#6b7280" });
    await api.action.setBadgeText({ text: failed ? "!" : settings.enabled ? "" : "OFF" });
  } catch (error) {
    // A toolbar capability failure does not change verified network rules.
    console.warn("[Module Engine] Could not update toolbar badge:", error);
  }
}

function editSettings(current, message) {
  const next = { ...current };
  if (message.type === "UPDATE_SETTINGS") {
    const patch = message.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some(key => !SETTING_KEYS.includes(key) || ["customCosmeticFilters", "customNetworkFilters"].includes(key))) {
      throw new Error("Invalid settings update.");
    }
    if (patch.rulesets !== undefined && (!patch.rulesets || typeof patch.rulesets !== "object" ||
        Array.isArray(patch.rulesets) || Object.keys(patch.rulesets).some(id => !RULESET_IDS.includes(id)))) {
      throw new Error("Invalid ruleset update.");
    }
    Object.assign(next, patch, { rulesets: { ...current.rulesets, ...patch.rulesets } });
  } else if (message.type === "SAVE_NETWORK_FILTERS") {
    if (message.previous !== current.customNetworkFilters) throw new Error("Custom network filters changed in another window. Discard this draft to load them before saving again.");
    customNetworkRules(message.text);
    next.customNetworkFilters = message.text;
  } else if (message.type === "SAVE_COSMETIC_FILTERS") {
    if (message.previous !== current.customCosmeticFilters) throw new Error("Custom filters changed in another window. Discard this draft to load them before saving again.");
    customCosmeticRules(message.text);
    next.customCosmeticFilters = message.text;
  } else if (message.type === "SET_SITE_COSMETICS") {
    const domain = normalizeDomain(message.domain);
    if (typeof message.paused !== "boolean") throw new Error("Invalid cosmetic pause setting.");
    next.cosmeticPausedDomains = message.paused
      ? [...current.cosmeticPausedDomains, domain]
      : current.cosmeticPausedDomains.filter(item => !domainMatches(domain, item));
  } else if (message.type === "REMOVE_COSMETIC_SITE") {
    const domain = normalizeDomain(message.domain);
    next.cosmeticPausedDomains = current.cosmeticPausedDomains.filter(item => item !== domain);
  } else if (message.type === "SET_SITE_PROMPTS") {
    const domain = normalizeDomain(message.domain);
    if (typeof message.allowed !== "boolean") throw new Error("Invalid prompt permission setting.");
    next.promptAllowedDomains = message.allowed
      ? [...current.promptAllowedDomains, domain]
      : current.promptAllowedDomains.filter(item => !domainMatches(domain, item));
  } else if (message.type === "REMOVE_PROMPT_SITE") {
    const domain = normalizeDomain(message.domain);
    next.promptAllowedDomains = current.promptAllowedDomains.filter(item => item !== domain);
  } else if (message.type === "ADD_CUSTOM_DOMAIN") {
    next.customBlockedDomains = [...current.customBlockedDomains, normalizeDomain(message.domain)];
  } else if (message.type === "REMOVE_CUSTOM_DOMAIN") {
    const domain = normalizeDomain(message.domain);
    next.customBlockedDomains = current.customBlockedDomains.filter(item => item !== domain);
  } else if (message.type === "REMOVE_PAUSED_SITE" || message.type === "REMOVE_POPUP_SITE") {
    // Exact removal for the lists page; the popup's Resume/switch also removes covering parents.
    const key = message.type === "REMOVE_PAUSED_SITE" ? "whitelistedDomains" : "popupBlockedDomains";
    const domain = normalizeDomain(message.domain);
    next[key] = current[key].filter(item => item !== domain);
  } else if (message.type === "ADD_ALLOWED_DOMAIN") {
    next.allowedDomains = [...current.allowedDomains, normalizeDomain(message.domain)];
  } else if (message.type === "REMOVE_ALLOWED_DOMAIN") {
    const domain = normalizeDomain(message.domain);
    next.allowedDomains = current.allowedDomains.filter(item => item !== domain);
  } else if (message.type === "SET_SITE_POPUPS") {
    const domain = normalizeDomain(message.domain);
    if (typeof message.blocked !== "boolean") throw new Error("Invalid pop-up blocking setting.");
    // Turning it off removes every entry that covers this site, like Resume.
    next.popupBlockedDomains = message.blocked
      ? [...current.popupBlockedDomains, domain]
      : current.popupBlockedDomains.filter(item => !domainMatches(domain, item));
  } else if (message.type === "SET_SITE_PAUSED") {
    const domain = normalizeDomain(message.domain);
    if (typeof message.paused !== "boolean") throw new Error("Invalid site pause setting.");
    next.whitelistedDomains = message.paused
      ? [...current.whitelistedDomains, domain]
      : current.whitelistedDomains.filter(item => !domainMatches(domain, item));
  }
  return validateSettings(next);
}

async function processRequest(message, transaction) {
  let loaded;
  let beforeRules;
  let beforeExtra;
  let saveAttempted = false;
  let threatStatus = { available: false, count: 0, expiresAt: null, error: "Evidence has not been checked." };
  try {
    const threats = await loadThreats();
    threatStatus = threats.status;
    loaded = await loadSettings();
    // Expired rules leave the browser before anything else can fail, when the
    // saved choice says so. This request may change that choice.
    applyThreatExpiryChoice(threatStatus, loaded.settings);
    await retireInactiveThreats(threatStatus);
    const desired = transaction ? validateSettings(transaction.settings) : editSettings(loaded.settings, message);
    if (transaction) beforeExtra = await api.storage.local.get(transaction.keys);
    applyThreatExpiryChoice(threatStatus, desired);
    // The generic stylesheets' exclusions come from the bundled exceptions.
    const cosmeticLoaded = desired.enabled && desired.cosmeticFiltering && desired.rulesets.community_ruleset && desired.genericCosmeticFiltering;
    const cosmetic = cosmeticLoaded ? await loadCommunityCosmetic() : {};
    // An installed update replaces the bundled threats_ruleset with its own
    // dynamic rules; expired ones are removed by applyRules.
    const updatedThreats = desired.enabled && desired.rulesets.threats_ruleset && threats.rules ? threats.rules : [];
    const own = makeDynamicRules(desired, updatedThreats.length);
    // An installed filter-list update switches off the bundled community rules it
    // dropped and adds its own while that layer is on. If its rules no longer fit
    // beside the person's own, the bundled network rules are used instead.
    const community = await loadCommunity(desired);
    let listChange = community.update;
    const listRules = listChange && desired.enabled && desired.rulesets.community_ruleset ? listChange.add : [];
    if (listChange && own.length + updatedThreats.length + listRules.length > dynamicRuleLimit()) {
      community.status.networkApplied = false;
      community.status.updates.notice = `The installed filter-list update needs ${listRules.length.toLocaleString("en")} dynamic rules, more than this browser ` +
        `has left beside your own rules. Its network rules are not used; its site hiding still is.`;
      listChange = null;
    }
    const target = {
      enabled: RULESET_IDS.filter(id => desired.enabled && desired.rulesets[id] && !(id === "threats_ruleset" && threats.rules)),
      dynamic: [...own, ...updatedThreats, ...(listChange ? listRules : [])],
      scripts: makePageScripts(desired, cosmetic),
      disabled: listChange ? [...listChange.disable].sort((a, b) => a - b) : []
    };
    beforeRules = await readRules();
    await applyRules(target, threatStatus);
    const communityStatus = community.status;
    const extra = transaction ? { ...transaction.extra, ...await transaction.prepare() } : {};
    const commit = { ...desired, quarantinedDomains: loaded.quarantined, protectionError: null, threatStatus, communityStatus, ...extra };
    if (!same(await api.storage.local.get(Object.keys(commit)), commit)) {
      saveAttempted = true;
      await api.storage.local.set(commit);
    }
    if (transaction && !same(await api.storage.local.get(Object.keys(commit)), commit)) throw new Error('Restored data could not be verified after saving.');
    await updateBadge(desired, Boolean(threatStatus.error));
    // Scriptlets start per frame without the registration, so a failure here is
    // reported in their status and never undoes the verified network rules.
    try { await syncScriptlets(desired, cosmeticLoaded ? cosmetic : null); }
    catch (error) { scriptletStatus = { ...scriptletStatus, error: error?.message || String(error) }; console.warn("[Module Engine] Scriptlet filters were not synchronized:", error); }
    for (const change of describeChanges(loaded.settings, desired)) await addLog({ kind: "event", message: change });
    // Not awaited: the check queues its own installation after this request.
    if (threatCheckDue(desired, threatStatus)) {
      void checkThreatUpdate().catch(error => console.warn("[Module Engine] Reported-threat update check failed:", error));
    }
    if (communityCheckDue(desired, communityStatus)) {
      void checkCommunityLists().catch(error => console.warn("[Module Engine] Filter-list update check failed:", error));
    }
    return { ok: true, settings: desired, quarantinedDomains: loaded.quarantined, threatStatus, communityStatus, scriptletStatus };
  } catch (error) {
    let rollbackFailed = false;
    if (beforeRules) {
      try { await applyRules(beforeRules, threatStatus); } catch { rollbackFailed = true; }
    }
    if (saveAttempted) {
      try {
        const previous = { ...loaded.settings, ...beforeExtra };
        await api.storage.local.set(previous);
        if (transaction) {
          const absent = transaction.keys.filter(key => !Object.hasOwn(beforeExtra, key));
          if (absent.length) await api.storage.local.remove(absent);
          if (!same(await api.storage.local.get([...SETTING_KEYS, ...transaction.keys]), previous)) throw new Error('Storage rollback could not be verified.');
        }
      } catch { rollbackFailed = true; }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const problem = rollbackFailed
      ? `Protection could not be verified. ${detail} Close and reopen this popup to retry.`
      : `Changes were not applied. ${detail}`;
    try { await api.storage.local.set({ protectionError: problem }); }
    catch (storageError) { console.error("[Module Engine] Could not save failure status:", storageError); }
    await updateBadge(loaded?.settings || DEFAULT_SETTINGS, true);
    await addLog({ kind: "error", message: problem });
    return { ok: false, error: problem, settings: loaded?.settings, quarantinedDomains: loaded?.quarantined || [], threatStatus };
  }
}

const reconcile = () => enqueue(() => processRequest({ type: "GET_STATE" }));
api.runtime.onInstalled.addListener(details => {
  void userscriptHost.start();
  void addLog({ kind: "event", message: `Module Engine ${api.runtime.getManifest?.().version ?? ""} ${details?.reason === "update" ? "updated or reloaded" : "installed"}` });
  return reconcile();
});
api.runtime.onStartup.addListener(() => { void userscriptHost.start(); return reconcile(); });
// Userscript access lets scriptlet filters start before the page's own scripts.
for (const event of [api.permissions?.onAdded, api.permissions?.onRemoved]) {
  event?.addListener(change => { if (change?.permissions?.includes("userScripts")) void reconcile(); });
}
api.alarms.onAlarm.addListener(alarm => {
  if ([THREAT_CHECK_ALARM, THREAT_EXPIRY_ALARM].includes(alarm.name)) return reconcile();
});
api.declarativeNetRequest.onRuleMatchedDebug?.addListener(info => { void logRuleMatch(info); void popupRuleMatched(info); });
// Chrome/Edge use native match feedback; Firefox combines a native aborted
// navigation with conservative proof from the extension's actual active rules.
if ((api.declarativeNetRequest.onRuleMatchedDebug || firefoxPopupCleanup) && api.tabs.onCreated && api.tabs.onUpdated &&
    api.tabs.onRemoved && api.webRequest?.onBeforeRequest && api.webRequest.onErrorOccurred) {
  api.tabs.onCreated.addListener(trackPopupTab);
  api.tabs.onUpdated.addListener(popupTabUpdated);
  api.tabs.onRemoved.addListener(id => { blockedPopupTabs.delete(id); });
  api.webRequest.onBeforeRequest.addListener(details => { popupRequest(details, true); }, { urls: ["<all_urls>"], types: ["main_frame"] });
  api.webRequest.onErrorOccurred.addListener(popupNavigationFailed, { urls: ["<all_urls>"], types: ["main_frame"] });
}
api.webRequest?.onResponseStarted.addListener(details => { popupResponseStarted(details); void flagRequest(details); }, { urls: ["<all_urls>"] });
api.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && SETTING_KEYS.some(key => key in changes)) flagSettings = null;
});
const fromExtensionPage = sender => sender.id === api.runtime.id && Boolean(sender.url?.startsWith(api.runtime.getURL("")));
const backupHost = ModuleEngineBackupRuntime.create(api, { userscripts: userscriptHost, loadSettings, validateSettings, describeChanges,
  settingKeys: SETTING_KEYS, restoreSettings: transaction => processRequest({ type: 'RESTORE_BACKUP' }, transaction) });
let backupPending = 0;
const PICKER_SESSION_KEY = 'elementPickerSessions';
const PICKER_TTL = 10 * 60 * 1000;
let pickerStartQueue = Promise.resolve();
async function pickerSessions() {
  const stored = (await api.storage.session.get(PICKER_SESSION_KEY))[PICKER_SESSION_KEY] || {};
  const live = Object.fromEntries(Object.entries(stored).filter(([, session]) => session.expiresAt > Date.now()));
  if (Object.keys(live).length !== Object.keys(stored).length) await savePickerSessions(live);
  return live;
}
const savePickerSessions = sessions => api.storage.session.set({ [PICKER_SESSION_KEY]: sessions });
async function pickerSettings(url) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('The picker is available on ordinary HTTP(S) pages.');
  const domain = parsed.hostname.toLowerCase().replace(/\.$/, '');
  BlockAdsCosmetic.parse(domain + '##.validation-only');
  const { settings } = await loadSettings();
  const paused = [...settings.whitelistedDomains, ...settings.cosmeticPausedDomains].some(site => domainMatches(domain, site));
  const data = settings.rulesets.community_ruleset ? await loadCommunityCosmetic() : {};
  if (!settings.enabled || !settings.cosmeticFiltering || paused || BlockAdsCosmetic.resolve(data, domain).disableAll) {
    throw new Error('Enable cosmetic filtering for this site before opening the picker.');
  }
  return { domain, settings, data };
}
async function startPicker(message) {
  if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('A current page is required.');
  const session = await enqueue(async () => {
    const tab = await api.tabs.get(message.tabId);
    const { domain } = await pickerSettings(tab.url);
    const sessions = await pickerSessions();
    const session = { token: crypto.randomUUID(), url: tab.url, domain, expiresAt: Date.now() + PICKER_TTL, used: false };
    delete sessions[message.tabId];
    // Keep only the most recent 20 user-opened sessions in volatile storage.
    const recent = Object.fromEntries(Object.entries(sessions).sort((a,b) => a[1].expiresAt-b[1].expiresAt).slice(-19));
    recent[message.tabId] = session;
    await savePickerSessions(recent);
    return session;
  });
  try {
    // Injection must run outside the settings queue: startup asks that queue for
    // its capability. Only packaged files run, in the top frame's isolated world.
    const results = await api.scripting.executeScript({ target: { tabId: message.tabId, frameIds: [0] }, files: ['src/blocking/cosmetic.js', 'src/blocking/picker-core.js', 'src/blocking/picker.js'] });
    if (!results.some(result => result.frameId === 0 && result.result === true)) throw new Error('The picker did not open. Reload this page and try again.');
    await api.tabs.update(message.tabId, { active: true });
    return { ok: true };
  } catch (error) {
    await enqueue(async () => {
      const sessions = await pickerSessions();
      if (sessions[message.tabId]?.token === session.token) { delete sessions[message.tabId]; await savePickerSessions(sessions); }
    });
    throw error;
  }
}
async function pickerRequest(message, sender) {
  if (sender.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) throw new Error('The picker requires its original top-frame context.');
  const sessions = await pickerSessions(), session = sessions[sender.tab.id];
  if (!session || sender.url !== session.url ||
      (session.documentId && session.documentId !== sender.documentId)) throw new Error('This picker session expired or the page changed. Open the picker again.');
  if (message.type === 'CLOSE_PICKER') {
    if (message.token !== session.token) throw new Error('The picker session does not match.');
    delete sessions[sender.tab.id]; await savePickerSessions(sessions); return { ok: true };
  }
  if ((await api.tabs.get(sender.tab.id)).url !== session.url) throw new Error('The page changed. Open the picker again.');
  if (message.type === 'GET_PICKER_SESSION') {
    if (session.used) throw new Error('This picker session has already finished.');
    await pickerSettings(session.url);
    if (sender.documentId) { session.documentId = sender.documentId; await savePickerSessions(sessions); }
    return { ok: true, token: session.token, domain: session.domain, expiresAt: session.expiresAt };
  }
  if (message.token !== session.token) throw new Error('The picker session does not match.');
  const selector = BlockAdsCosmetic.safeSelector(message.selector);
  const { settings, data } = await pickerSettings(session.url);
  const rule = session.domain + '##' + selector;
  const existing = customCosmeticRules(settings.customCosmeticFilters);
  const duplicate = existing.some(item => !item.exception && item.include.length === 1 && item.include[0] === session.domain && !item.exclude.length && item.selector === selector);
  if (session.used) {
    if (duplicate && session.selector === selector) return { ok: true, rule, alreadySaved: true };
    throw new Error('This picker session has already finished.');
  }
  const resolved = BlockAdsCosmetic.resolve(data, session.domain, { custom: existing });
  if (resolved.exceptions.includes(selector)) throw new Error('An existing exception allows this selector. Review that exception in My lists first.');
  const text = settings.customCosmeticFilters + (settings.customCosmeticFilters && !settings.customCosmeticFilters.endsWith('\n') ? '\n' : '') + rule;
  if (!duplicate) BlockAdsCosmetic.parse(text);
  // Consume authority before committing. A failed write cannot create a rule.
  session.used = true; session.selector = selector;
  await savePickerSessions(sessions);
  if (duplicate) return { ok: true, rule, alreadySaved: true };
  const result = await processRequest({ type: 'SAVE_COSMETIC_FILTERS', previous: settings.customCosmeticFilters, text });
  if (!result.ok) { session.used = false; await savePickerSessions(sessions); }
  return { ok: result.ok, error: result.error, rule };
}
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the private offscreen document answers this worker-to-document call.
  if (message?.type === 'ME_CLIPBOARD_WRITE') return false;
  if (['BACKUP_EXPORT', 'BACKUP_PREVIEW', 'BACKUP_RESTORE'].includes(message?.type)) {
    if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL('src/ui/backup/backup.html')) {
      sendResponse({ ok: false, error: 'Open Backup & restore in the extension to manage backups.' }); return false;
    }
    if (backupPending >= 2) { sendResponse({ ok: false, error: 'A backup operation is already waiting. Try again shortly.' }); return false; }
    backupPending++;
    enqueue(() => backupHost.request(message)).then(sendResponse, error => sendResponse({ ok: false, error: error.message || String(error) }))
      .finally(() => { backupPending--; });
    return true;
  }
  if (message?.type === 'SAVE_APPEARANCE') {
    if (!fromExtensionPage(sender)) { sendResponse({ ok: false, error: 'Change appearance from the extension interface.' }); return false; }
    enqueue(async () => {
      const theme = ModuleEngineAppearance, next = theme.normalize(message.value);
      const saved = theme.normalize((await api.storage.local.get(theme.KEY))[theme.KEY]);
      if (!theme.same(saved, theme.normalize(message.previous))) throw new Error('Appearance changed in another page. Try your choice again.');
      if (theme.same(next, theme.DEFAULT)) await api.storage.local.remove(theme.KEY);
      else await api.storage.local.set({ [theme.KEY]: next });
      if (!theme.same(theme.normalize((await api.storage.local.get(theme.KEY))[theme.KEY]), next)) throw new Error('Appearance could not be verified after saving.');
      return { ok: true };
    }).then(sendResponse, error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (['MODULES_GET', 'MODULE_SET', 'US_LIST', 'US_SAVE', 'US_ENABLE', 'US_DELETE', 'US_MENU_LIST', 'US_MENU_RUN', 'US_PREPARE_ASSETS', 'US_CANCEL_ASSETS', 'US_ASSET_READ',
    'US_FETCH_SOURCE', 'US_CHECK_UPDATE', 'US_CANCEL_SOURCE', 'US_APPLY_SOURCE', 'US_TAGS', 'US_MOVE',
    'US_UPDATE_STATE', 'US_UPDATE_SETTINGS', 'US_STAGED_REVIEW', 'US_CHECK_ALL', 'US_LINK_BYPASS'].includes(message?.type)) {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: 'Modules and scripts can only be managed from the extension interface.' });
      return false;
    }
    const work = message.type === 'MODULES_GET' ? moduleHost.state()
      : message.type === 'MODULE_SET' ? moduleHost.set(message.id, message.enabled)
      // Passage applies only to the review page's own tab, never a tab it names.
      : message.type === 'US_LINK_BYPASS' ? Promise.resolve().then(() => userscriptHost.allowNavigation(sender.tab?.id, message.url))
      : userscriptHost.request(message);
    work.then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || String(error),
      ...(typeof error?.code === 'string' && /^[A-Z_]{1,32}$/.test(error.code) ? { code: error.code } : {}) }));
    return true;
  }
  if (message?.type === 'START_PICKER') {
    if (!fromExtensionPage(sender)) { sendResponse({ ok: false, error: 'Open the picker from the extension popup.' }); return false; }
    // Keep complete launches ordered without holding the settings queue across
    // injection, whose content script must call back into that queue.
    const launched = pickerStartQueue.then(() => startPicker(message));
    pickerStartQueue = launched.catch(() => {});
    launched.then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (['GET_PICKER_SESSION', 'SAVE_PICKER_FILTER', 'CLOSE_PICKER'].includes(message?.type)) {
    enqueue(() => pickerRequest(message, sender)).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "GET_LOG" || message?.type === "CLEAR_LOG") {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: "The log is only available to the extension interface." });
      return false;
    }
    const work = message.type === "CLEAR_LOG" ? clearLog().then(() => []) : loadLog().then(entries => entries.slice());
    work.then(async entries => sendResponse({ ok: true, entries, blockLogging: Boolean(api.declarativeNetRequest.onRuleMatchedDebug),
      // The log must stay readable even when settings cannot be loaded.
      allowedDomains: await loadSettings().then(({ settings }) => settings.allowedDomains, () => []) }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "LOG_EVENT") {
    // Content scripts report only fixed event names; the site comes from the browser.
    if (sender.id === api.runtime.id && sender.tab?.incognito === false && Number.isInteger(sender.tab.id) && Object.hasOwn(CONTENT_EVENTS, message.event)) {
      const site = urlParts(sender.tab.url).host;
      void (async () => {
        await addLog({ kind: "event", message: CONTENT_EVENTS[message.event](message), site, tabId: sender.tab.id });
      })().catch(() => {});
    }
    return false;
  }
  if (message?.type === "GET_FLAGS" || message?.type === "FLAG_ACTION") {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: "Flags are only available to the extension interface." });
      return false;
    }
    const work = message.type === "FLAG_ACTION" ? editFlag(message.site, message.action) : loadFlags();
    work.then(flags => sendResponse({ ok: true, flags: Object.values(flags), reasons: BlockAdsFlags.REASONS }))
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "FLAG_CANDIDATES") {
    // Signals a content script saw on its page. The page can influence them, so
    // only fixed reason codes, http(s) addresses and third-party hosts count.
    if (sender.id === api.runtime.id && Number.isInteger(sender.tab?.id) && sender.tab.incognito === false && /^https?:\/\//i.test(sender.tab.url || "") &&
        Array.isArray(message.items)) {
      const pageHost = urlParts(sender.tab.url).host;
      for (const item of message.items.slice(0, 20)) {
        if (!BlockAdsFlags.PAGE_REASONS.has(item?.reason) || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) continue;
        const { host, path } = urlParts(item.url);
        if (!host || sameSite(host, pageHost)) continue;
        void recordFlag({ host, pageHost, reasons: [item.reason], path, tabId: sender.tab.id })
          .catch(error => console.warn("[Module Engine] Could not record a page signal:", error));
      }
    }
    return false;
  }
  if (message?.type === "WEBSITE_THEME_TOP") {
    // Website theme exceptions follow the tab's site. A cross-origin frame cannot
    // read it, so answer from the browser's tab record, never from page data.
    const valid = sender.id === api.runtime.id && Number.isInteger(sender.tab?.id);
    sendResponse(valid ? { ok: true, host: urlParts(sender.tab.url).host } : { ok: false, error: "A content-script context is required." });
    return false;
  }
  if (message?.type === "GET_COSMETIC_STATE") {
    // A frame cannot read its cross-origin top page directly. Use browser-provided
    // sender metadata, never a page-supplied hostname, for the parent exception.
    if (sender.id !== api.runtime.id || !Number.isInteger(sender.tab?.id)) {
      sendResponse({ ok: false, error: "A content-script context is required." });
      return false;
    }
    loadSettings().then(async ({ settings }) => {
      const hosts = [sender.url, sender.tab.url].filter(url => /^https?:\/\//i.test(url || ""))
        .map(url => { try { return normalizeDomain(url); } catch { return ""; } });
      const paused = hosts.some(host => settings.whitelistedDomains.some(domain => domainMatches(host, domain)));
      const active = settings.enabled && !paused;
      const promptsActive = active && !hosts.some(host => settings.promptAllowedDomains.some(domain => domainMatches(host, domain)));
      const enabled = active && settings.cosmeticFiltering &&
        !hosts.some(host => settings.cosmeticPausedDomains.some(domain => domainMatches(host, domain)));
      const popupGuard = message.installPopupGuard === true && await injectPopupFrame(sender, settings, active);
      // Site rules follow this frame's own host, including a leading "www.".
      const frameHost = /^https?:\/\//i.test(sender.url || "") ? urlParts(sender.url).host : "";
      const data = enabled && frameHost && settings.rulesets.community_ruleset ? await loadCommunityCosmetic() : {};
      // A frame's first request starts its scriptlets, leaving out the calls the
      // document-start registration already ran. They follow the frame's own
      // host, and its top page's pauses as hiding does.
      const plan = message.installScriptlets === true && enabled && frameHost &&
        !(settings.rulesets.community_ruleset ? data.disableAll || [] : []).some(domain => domainMatches(frameHost, domain))
        ? scriptletPlanFor(settings, data) : null;
      let scriptletCalls = plan ? BlockAdsScriptlets.select(plan.rules, frameHost) : [];
      const earlyCalls = scriptletCalls.length ? BlockAdsScriptlets.select(plan.early, frameHost) : [];
      if (earlyCalls.length && await scriptletsRegistered(frameHost)) {
        const ran = new Set(earlyCalls.map(call => JSON.stringify([call.name, ...call.args])));
        scriptletCalls = scriptletCalls.filter(call => !ran.has(JSON.stringify([call.name, ...call.args])));
      }
      const scriptlets = scriptletCalls.length > 0 && await injectScriptlets(sender, scriptletCalls);
      // The frame reports whether the bundled generic stylesheets reached it once
      // their companion script has run. Until then, judge from the registration.
      const staticSheets = typeof message.staticGeneric === "boolean" ? message.staticGeneric
        : genericSheetsExpected(settings, data, sender.url);
      const cosmetic = enabled && frameHost ? BlockAdsCosmetic.resolve(data, frameHost,
        { generic: settings.genericCosmeticFiltering, custom: customCosmeticRules(settings.customCosmeticFilters), staticSheets }
      ) : { siteSelectors: [], genericSelectors: [], exceptions: [], proceduralRules: [], genericStatic: false };
      // When generic hiding applies, the selectors sent depend on that judgement;
      // the frame asks again if its stylesheets turn out otherwise.
      const sheetsMatter = Boolean(cosmetic.genericStatic || (enabled && frameHost && BlockAdsCosmetic.staticBundle(data) &&
        !cosmetic.disableGeneric && !cosmetic.disableAll));
      sendResponse({ ok: true, ...cosmetic, staticAssumed: sheetsMatter ? staticSheets : null,
        procedural: settings.proceduralFiltering, enabled: enabled && !cosmetic.disableAll, ads: active && settings.rulesets.ads_ruleset,
        notificationPrompts: promptsActive && settings.notificationPromptBlocking, installPrompts: promptsActive && settings.deceptivePromptBlocking,
        deceptiveButtons: promptsActive && settings.deceptiveButtonBlocking,
        flag: active && settings.flagSuspects, ...(popupGuard ? { popupGuard: true } : {}), ...(scriptlets ? { scriptlets: true } : {}) });
    }).catch(() => sendResponse({ ok: false, error: "Could not read cosmetic filtering settings." }));
    return true;
  }
  if (message?.type === "CHECK_LIST_UPDATES") {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: "Filter-list updates can only be checked from the extension interface." });
      return false;
    }
    // Answers with the verified state after the check, like GET_STATE.
    checkCommunityLists().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "CHECK_THREAT_UPDATE") {
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: "Updates can only be checked from the extension interface." });
      return false;
    }
    // Answers with the verified state after the check, like GET_STATE.
    checkThreatUpdate().then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }
  if (!message || !["GET_STATE", "UPDATE_SETTINGS", "ADD_CUSTOM_DOMAIN", "REMOVE_CUSTOM_DOMAIN",
    "ADD_ALLOWED_DOMAIN", "REMOVE_ALLOWED_DOMAIN", "SET_SITE_PAUSED", "SET_SITE_POPUPS",
    "REMOVE_PAUSED_SITE", "REMOVE_POPUP_SITE", "SET_SITE_COSMETICS", "REMOVE_COSMETIC_SITE", "SET_SITE_PROMPTS", "REMOVE_PROMPT_SITE", "SAVE_COSMETIC_FILTERS", "SAVE_NETWORK_FILTERS"].includes(message.type)) return false;
  if (!fromExtensionPage(sender)) {
    sendResponse({ ok: false, error: "Settings can only be changed from the extension interface." });
    return false;
  }
  enqueue(() => processRequest(message)).then(sendResponse);
  return true;
});
// Restore expiry alarms and enforce saved pause intent on service-worker wake.
void reconcile();
void userscriptHost.start();
