/* BlockAds Shield: commit settings only after DNR accepts and verifies them. */
"use strict";

if (!globalThis.BlockAds && typeof importScripts === "function") importScripts("shared.js");
const api = typeof browser !== "undefined" ? browser : chrome;
const { normalizeDomain, normalizeDomains, domainMatches } = BlockAds;
const RULESET_IDS = ["ads_ruleset", "trackers_ruleset", "threats_ruleset", "community_ruleset"];
const THREAT_CHECK_ALARM = "reported-threats-check";
const THREAT_EXPIRY_ALARM = "reported-threats-expiry";
const DEFAULT_SETTINGS = {
  enabled: true,
  rulesets: Object.fromEntries(RULESET_IDS.map(id => [id, true])),
  cosmeticFiltering: true,
  whitelistedDomains: [],
  customBlockedDomains: [],
  popupBlockedDomains: [],
  allowedDomains: []
};
const DOMAIN_LIST_KEYS = ["whitelistedDomains", "customBlockedDomains", "popupBlockedDomains", "allowedDomains"];
// Always-allowed domains override every list rule (1-3, including community
// $important) but not reported threats (5) or custom blocks (50).
const ALLOWED_DOMAIN_PRIORITY = 4;
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
let operationQueue = Promise.resolve();

// Activity log: recent blocks and extension events for tracing. Kept in session
// storage (cleared when the browser closes), capped, local only. A logging
// failure must never affect protection, so every path here catches its errors.
const LOG_KEY = "activityLog";
const LOG_LIMIT = 1000;
const LAYER_NAMES = { ads_ruleset: "Ads", trackers_ruleset: "Trackers", threats_ruleset: "Reported threat", community_ruleset: "Community lists", _dynamic: "Custom block" };
// Fixed messages that content scripts may add; they never supply free text.
const CONTENT_EVENTS = {
  "youtube-ad-skipped": () => "Skipped a YouTube video ad that reached the player",
  "popup-blocked": message => {
    let host = "";
    try { host = normalizeDomain(message.host); } catch {}
    return host ? `Blocked a pop-up to ${host}` : "Blocked a pop-up";
  }
};
// Site-specific hiding rules from the community lists, loaded once per worker.
const SITE_SELECTOR_LIMIT = 2000;
let communityCosmetic = null;
let logLoad = null;
let logSaveTimer = null;
let dynamicBlockIds = null;

function loadLog() {
  logLoad ??= (async () => {
    try {
      const stored = (await api.storage.session.get(LOG_KEY))[LOG_KEY];
      return Array.isArray(stored) ? stored.slice(-LOG_LIMIT) : [];
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
      try { await api.storage.session.set({ [LOG_KEY]: await loadLog() }); }
      catch (error) { console.warn("[BlockAds] Could not save the activity log:", error); }
    }, 500);
  } catch (error) {
    console.warn("[BlockAds] Could not record a log entry:", error);
  }
}

async function clearLog() {
  (await loadLog()).length = 0;
  await api.storage.session.remove(LOG_KEY);
}

function loadCommunityCosmetic() {
  communityCosmetic ??= fetch(api.runtime.getURL("rules/community-cosmetic.json"))
    .then(response => {
      if (!response.ok) throw new Error("The bundled site hiding rules could not be read.");
      return response.json();
    })
    .then(data => ({ hide: data?.hide ?? {}, allow: data?.allow ?? {} }))
    .catch(error => {
      communityCosmetic = null;
      console.warn("[BlockAds] Site hiding rules unavailable:", error);
      return { hide: {}, allow: {} };
    });
  return communityCosmetic;
}

// Rules for a host apply to its subdomains; an exception on any level removes a selector.
function siteSelectors(cosmetic, host) {
  const hide = new Set();
  const allow = new Set();
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join(".");
    if (Object.hasOwn(cosmetic.hide, suffix)) for (const selector of cosmetic.hide[suffix]) hide.add(selector);
    if (Object.hasOwn(cosmetic.allow, suffix)) for (const selector of cosmetic.allow[suffix]) allow.add(selector);
  }
  return [...hide].filter(selector => !allow.has(selector)).slice(0, SITE_SELECTOR_LIMIT);
}

function urlParts(value) {
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname.slice(0, 150) };
  } catch {
    return { host: "", path: "" };
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
// Firefox has no such event, so only events are logged there.
async function logRuleMatch({ rule, request }) {
  try {
    if (rule.rulesetId === "_dynamic" && !(await isDynamicBlock(rule.ruleId))) return;
    const { host, path } = urlParts(request.url);
    const source = request.initiator || request.documentUrl || request.originUrl || "";
    await addLog({
      kind: "blocked", layer: LAYER_NAMES[rule.rulesetId] || rule.rulesetId, ruleId: rule.ruleId,
      host, path, type: request.type, site: urlParts(source).host, tabId: request.tabId
    });
  } catch (error) {
    console.warn("[BlockAds] Could not log a blocked request:", error);
  }
}

function describeChanges(before, after) {
  const changes = [];
  const onOff = value => value ? "on" : "off";
  if (before.enabled !== after.enabled) changes.push(`Protection turned ${onOff(after.enabled)}`);
  for (const id of RULESET_IDS) {
    if (before.rulesets[id] !== after.rulesets[id]) changes.push(`${LAYER_NAMES[id]} layer turned ${onOff(after.rulesets[id])}`);
  }
  if (before.cosmeticFiltering !== after.cosmeticFiltering) changes.push(`Cosmetic hiding turned ${onOff(after.cosmeticFiltering)}`);
  const lists = [["customBlockedDomains", "Custom block added", "Custom block removed"],
    ["whitelistedDomains", "Paused on", "Resumed on"],
    ["popupBlockedDomains", "Pop-up blocking turned on for", "Pop-up blocking turned off for"],
    ["allowedDomains", "Always allowed", "No longer always allowed"]];
  for (const [key, added, removed] of lists) {
    for (const domain of after[key].filter(item => !before[key].includes(item))) changes.push(`${added} ${domain}`);
    for (const domain of before[key].filter(item => !after[key].includes(item))) changes.push(`${removed} ${domain}`);
  }
  return changes;
}

async function loadThreatStatus() {
  try {
    // This is a packaged extension file, never a network feed or candidate host.
    const response = await fetch(api.runtime.getURL("rules/threat-policy.json"), { redirect: "error" });
    if (!response.ok) throw new Error("The bundled evidence policy could not be read.");
    const text = await response.text();
    if (text.length > 4096) throw new Error("The bundled evidence policy is oversized.");
    const policy = JSON.parse(text);
    const keys = ["schemaVersion", "ruleCount", "evidenceFrom", "reviewedAt", "expiresAt"];
    if (!policy || Object.keys(policy).length !== keys.length || keys.some(key => !(key in policy)) ||
        policy.schemaVersion !== 1 || !Number.isInteger(policy.ruleCount) || policy.ruleCount < 1 || policy.ruleCount > 100) {
      throw new Error("The bundled evidence policy is invalid.");
    }
    const dates = [policy.evidenceFrom, policy.reviewedAt, policy.expiresAt].map(value => {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
          !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace("Z", ".000Z")) {
        throw new Error("The bundled evidence dates are invalid.");
      }
      return Date.parse(value);
    });
    const [observed, reviewed, expires] = dates;
    if (observed > reviewed || reviewed > Date.now() || expires <= reviewed || expires - observed > 90 * 86400000) {
      throw new Error("The bundled evidence dates violate the 90-day review policy.");
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
    return { available: expires > Date.now(), count: policy.ruleCount, expiresAt: policy.expiresAt, error: "" };
  } catch (error) {
    return { available: false, count: 0, expiresAt: null, error: `Reported threats are inactive. ${error.message || String(error)}` };
  }
}

function constrainThreatRules(target, status) {
  if (status?.available && Date.parse(status.expiresAt) <= Date.now()) status.available = false;
  return { ...target, enabled: target.enabled.filter(id => id !== "threats_ruleset" || status?.available) };
}

async function retireInactiveThreats(status) {
  if (status.available && Date.parse(status.expiresAt) > Date.now()) return;
  status.available = false;
  if ((await api.declarativeNetRequest.getEnabledRulesets()).includes("threats_ruleset")) {
    await api.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [], disableRulesetIds: ["threats_ruleset"] });
    if ((await api.declarativeNetRequest.getEnabledRulesets()).includes("threats_ruleset")) {
      throw new Error("The browser did not disable inactive reported-threat rules.");
    }
  }
}

function enqueue(operation) {
  const result = operationQueue.then(operation);
  // Failure must not prevent a later request from repairing state.
  operationQueue = result.catch(() => {});
  return result;
}

function validateSettings(settings) {
  for (const key of ["enabled", "cosmeticFiltering"]) {
    if (typeof settings[key] !== "boolean") throw new Error(`${key} must be true or false.`);
  }
  for (const id of RULESET_IDS) {
    if (typeof settings.rulesets?.[id] !== "boolean") throw new Error(`Invalid setting for ${id}.`);
  }
  const valid = {
    enabled: settings.enabled,
    rulesets: Object.fromEntries(RULESET_IDS.map(id => [id, settings.rulesets[id]])),
    cosmeticFiltering: settings.cosmeticFiltering,
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

function makeDynamicRules(settings) {
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
  const limit = api.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_RULES ??
    api.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES ?? 5000;
  if (rules.length > limit) throw new Error(`Too many domain rules for this browser (limit ${limit}).`);
  return rules;
}

// Match patterns cannot put a wildcard before an IPv4 address or bare name.
const sitePatterns = domain => /^[0-9.]+$/.test(domain) || !domain.includes(".")
  ? [`*://${domain}/*`] : [`*://*.${domain}/*`];

function makePageScripts(settings) {
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
      js: ["youtube.js"],
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
      js: ["popups.js"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true
    });
  }
  return scripts;
}

// Browsers differ in which defaults and URL forms they echo back.
function normalizeScript(script) {
  const base = api.runtime.getURL("");
  return {
    id: script.id,
    matches: script.matches || [],
    excludeMatches: script.excludeMatches || [],
    js: (script.js || []).map(file => file.startsWith(base) ? file.slice(base.length) : file.replace(/^\//, "")),
    runAt: script.runAt || "document_idle",
    world: script.world || "ISOLATED",
    allFrames: Boolean(script.allFrames)
  };
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

async function readRules() {
  const dynamic = await api.declarativeNetRequest.getDynamicRules();
  return {
    enabled: await api.declarativeNetRequest.getEnabledRulesets(),
    // Firefox returns null for absent optional fields; Chromium omits them.
    // Strip only absent fields, retaining every actual condition for verification.
    dynamic: JSON.parse(JSON.stringify(dynamic, (_key, value) => value === null ? undefined : value)),
    scripts: (await api.scripting.getRegisteredContentScripts()).map(normalizeScript)
  };
}

async function applyRules(target, threatStatus) {
  const current = await readRules();
  if (!same(current.dynamic, target.dynamic)) {
    dynamicBlockIds = null;
    await api.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: current.dynamic.map(rule => rule.id), addRules: target.dynamic
    });
  }
  if (!same(current.scripts, target.scripts)) {
    if (current.scripts.length) {
      await api.scripting.unregisterContentScripts({ ids: current.scripts.map(script => script.id) });
    }
    if (target.scripts.length) {
      await api.scripting.registerContentScripts(target.scripts.map(({ excludeMatches, ...script }) => ({
        ...script, ...(excludeMatches.length ? { excludeMatches } : {}), persistAcrossSessions: true
      })));
    }
  }
  target = constrainThreatRules(target, threatStatus);
  if (!same(current.enabled, target.enabled)) {
    await api.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: target.enabled,
      disableRulesetIds: RULESET_IDS.filter(id => !target.enabled.includes(id))
    });
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
    console.warn("[BlockAds] Could not update toolbar badge:", error);
  }
}

function editSettings(current, message) {
  const next = { ...current };
  if (message.type === "UPDATE_SETTINGS") {
    const patch = message.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch) ||
        Object.keys(patch).some(key => !SETTING_KEYS.includes(key))) {
      throw new Error("Invalid settings update.");
    }
    if (patch.rulesets !== undefined && (!patch.rulesets || typeof patch.rulesets !== "object" ||
        Array.isArray(patch.rulesets) || Object.keys(patch.rulesets).some(id => !RULESET_IDS.includes(id)))) {
      throw new Error("Invalid ruleset update.");
    }
    Object.assign(next, patch, { rulesets: { ...current.rulesets, ...patch.rulesets } });
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

async function processRequest(message) {
  let loaded;
  let beforeRules;
  let saveAttempted = false;
  let threatStatus = { available: false, count: 0, expiresAt: null, error: "Evidence has not been checked." };
  try {
    threatStatus = await loadThreatStatus();
    await retireInactiveThreats(threatStatus);
    loaded = await loadSettings();
    const desired = editSettings(loaded.settings, message);
    const target = {
      enabled: RULESET_IDS.filter(id => desired.enabled && desired.rulesets[id]),
      dynamic: makeDynamicRules(desired),
      scripts: makePageScripts(desired)
    };
    beforeRules = await readRules();
    await applyRules(target, threatStatus);
    const commit = { ...desired, quarantinedDomains: loaded.quarantined, protectionError: null, threatStatus };
    if (!same(await api.storage.local.get(Object.keys(commit)), commit)) {
      saveAttempted = true;
      await api.storage.local.set(commit);
    }
    await updateBadge(desired, Boolean(threatStatus.error));
    for (const change of describeChanges(loaded.settings, desired)) await addLog({ kind: "event", message: change });
    return { ok: true, settings: desired, quarantinedDomains: loaded.quarantined, threatStatus };
  } catch (error) {
    let rollbackFailed = false;
    if (beforeRules) {
      try { await applyRules(beforeRules, threatStatus); } catch { rollbackFailed = true; }
    }
    if (saveAttempted) {
      try { await api.storage.local.set(loaded.settings); } catch { rollbackFailed = true; }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const problem = rollbackFailed
      ? `Protection could not be verified. ${detail} Close and reopen this popup to retry.`
      : `Changes were not applied. ${detail}`;
    try { await api.storage.local.set({ protectionError: problem }); }
    catch (storageError) { console.error("[BlockAds] Could not save failure status:", storageError); }
    await updateBadge(loaded?.settings || DEFAULT_SETTINGS, true);
    await addLog({ kind: "error", message: problem });
    return { ok: false, error: problem, settings: loaded?.settings, quarantinedDomains: loaded?.quarantined || [], threatStatus };
  }
}

const reconcile = () => enqueue(() => processRequest({ type: "GET_STATE" }));
api.runtime.onInstalled.addListener(details => {
  void addLog({ kind: "event", message: `BlockAds ${api.runtime.getManifest?.().version ?? ""} ${details?.reason === "update" ? "updated or reloaded" : "installed"}` });
  return reconcile();
});
api.runtime.onStartup.addListener(reconcile);
api.alarms.onAlarm.addListener(alarm => {
  if ([THREAT_CHECK_ALARM, THREAT_EXPIRY_ALARM].includes(alarm.name)) return reconcile();
});
api.declarativeNetRequest.onRuleMatchedDebug?.addListener(info => { void logRuleMatch(info); });
const fromExtensionPage = sender => sender.id === api.runtime.id && Boolean(sender.url?.startsWith(api.runtime.getURL("")));
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    if (sender.id === api.runtime.id && Number.isInteger(sender.tab?.id) && Object.hasOwn(CONTENT_EVENTS, message.event)) {
      const site = urlParts(sender.tab.url).host;
      void (async () => {
        // Any page can fire the pop-up event; accept it only where pop-up blocking is on.
        if (message.event === "popup-blocked") {
          const { settings } = await loadSettings();
          if (!settings.popupBlockedDomains.some(domain => domainMatches(site, domain))) return;
        }
        await addLog({ kind: "event", message: CONTENT_EVENTS[message.event](message), site, tabId: sender.tab.id });
      })().catch(() => {});
    }
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
      const enabled = active && settings.cosmeticFiltering;
      // Site rules follow this frame's own host, including a leading "www.".
      const frameHost = /^https?:\/\//i.test(sender.url || "") ? urlParts(sender.url).host : "";
      const selectors = enabled && settings.rulesets.community_ruleset && frameHost
        ? siteSelectors(await loadCommunityCosmetic(), frameHost) : [];
      sendResponse({ ok: true, enabled, ads: active && settings.rulesets.ads_ruleset, siteSelectors: selectors });
    }).catch(() => sendResponse({ ok: false, error: "Could not read cosmetic filtering settings." }));
    return true;
  }
  if (!message || !["GET_STATE", "UPDATE_SETTINGS", "ADD_CUSTOM_DOMAIN", "REMOVE_CUSTOM_DOMAIN",
    "ADD_ALLOWED_DOMAIN", "REMOVE_ALLOWED_DOMAIN", "SET_SITE_PAUSED", "SET_SITE_POPUPS",
    "REMOVE_PAUSED_SITE", "REMOVE_POPUP_SITE"].includes(message.type)) return false;
  if (!fromExtensionPage(sender)) {
    sendResponse({ ok: false, error: "Settings can only be changed from the extension interface." });
    return false;
  }
  enqueue(() => processRequest(message)).then(sendResponse);
  return true;
});
// Restore expiry alarms and enforce saved pause intent on service-worker wake.
void reconcile();
