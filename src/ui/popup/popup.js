/* Module Engine popup: render verified state and keep unsuccessful input available. */
"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const { normalizeDomain, whitelistScope, domainMatches } = BlockAds;
const byId = id => document.getElementById(id);
const masterToggle = byId("masterToggle");
const statusText = byId("statusText");
const currentDomainEl = byId("currentDomain");
const siteWhitelistBtn = byId("siteWhitelistBtn");
// The button also holds its icons, so only its label text is replaced.
const siteWhitelistLabel = byId("siteWhitelistLabel");
const siteBadge = byId("siteBadge");
const masterState = byId("masterState");
const siteScope = byId("siteScope");
const errorPanel = byId("errorPanel");
const savedWarning = byId("savedWarning");
const retryButton = byId("retryButton");
const toggleAds = byId("toggleAds");
const toggleTrackers = byId("toggleTrackers");
const toggleThreats = byId("toggleThreats");
const threatStatusEl = byId("threatStatus");
const toggleCosmetic = byId("toggleCosmetic");
const toggleGenericCosmetic = byId("toggleGenericCosmetic");
const toggleProcedural = byId("toggleProcedural");
const toggleNotificationPrompts = byId("toggleNotificationPrompts");
const toggleInstallPrompts = byId("toggleInstallPrompts");
const toggleDeceptiveButtons = byId("toggleDeceptiveButtons");
const toggleSitePrompts = byId("toggleSitePrompts");
const togglePopups = byId("togglePopups");
const toggleCommunity = byId("toggleCommunity");
const communityStatusEl = byId("communityStatus");
let communityInfo = null;
const toggleFlags = byId("toggleFlags");
const flagStatusEl = byId("flagStatus");
let flagCount = null;
const popupScopeEl = byId("popupScope");
const scriptStatusEl = byId("scriptStatus");
const domainCountEl = byId("domainCount");
const tabs = [...document.querySelectorAll('[role="tab"]')];
const customBlockForm = byId("customBlockForm");
const customDomainInput = byId("customDomainInput");
const customDomainList = byId("customDomainList");
const allowForm = byId("allowForm");
const allowDomainInput = byId("allowDomainInput");
const allowDomainList = byId("allowDomainList");
let currentSettings = null;
let activeHostname = "";
let activeTabId = null;
let pickerError = '';
let busy = false;
let lastError = "";
let quarantinedDomains = [];
let refreshPending = false;
let threatStatus = null;

async function detectActiveTabDomain() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:\/\//i.test(tab.url)) {
    try { activeHostname = normalizeDomain(tab.url); } catch { activeHostname = ""; }
    activeTabId = tab.id;
  }
  currentDomainEl.textContent = activeHostname || "Browser / unsupported page";
  currentDomainEl.title = activeHostname;
}

// The website theme belongs to Appearance, not protection: its switch follows
// that setting and stays usable whatever the blocker's state.
const theme = globalThis.ModuleEngineTheme;
const websiteThemeRow = byId("websiteThemeRow");
const toggleWebsiteTheme = byId("toggleWebsiteTheme");
const websiteThemeScope = byId("websiteThemeScope");
let themeReady = false, themeSaving = false, themeError = "";
function renderWebsiteTheme() {
  const value = theme.current();
  const scope = activeHostname ? whitelistScope(activeHostname, value.websiteExceptions) : "";
  websiteThemeRow.hidden = !themeReady || !value.websites;
  toggleWebsiteTheme.checked = Boolean(activeHostname) && !scope;
  toggleWebsiteTheme.disabled = !themeReady || themeSaving || !activeHostname;
  websiteThemeScope.textContent = themeError || (!activeHostname ? "Available on HTTP(S) pages"
    : scope ? `Off for ${scope} and its subdomains. Turning it on removes that exception.`
    : value.mode === "light" ? "Applies when the theme is dark" : "Turn off to keep this site's own colours");
}
toggleWebsiteTheme.addEventListener("change", async () => {
  const value = theme.current();
  if (!themeReady || !activeHostname) return;
  // On removes every exception covering this site, as Resume does for site pauses.
  const websiteExceptions = toggleWebsiteTheme.checked
    ? value.websiteExceptions.filter(domain => !domainMatches(activeHostname, domain))
    : [...value.websiteExceptions, activeHostname];
  themeSaving = true; themeError = ""; renderWebsiteTheme();
  try { await theme.save({ ...value, websiteExceptions }); }
  catch (error) { themeError = "Could not save: " + (error?.message || error); }
  themeSaving = false; renderWebsiteTheme();
});
theme.subscribe(renderWebsiteTheme);
void theme.ready.then(result => {
  themeReady = result.ok;
  if (!result.ok) themeError = "Appearance unavailable: " + result.error;
  renderWebsiteTheme();
});

function renderUI() {
  const settings = currentSettings;
  document.body.setAttribute("aria-busy", String(busy));
  // Tabs only change what is on screen, so they stay usable while a command runs.
  for (const element of document.querySelectorAll('input, button:not([role="tab"])')) element.disabled = busy || !settings || element.dataset.commandBusy === 'true';
  renderWebsiteTheme();
  retryButton.disabled = busy;
  errorPanel.textContent = lastError;
  errorPanel.hidden = !lastError;
  byId('pickerError').textContent = pickerError;
  byId('pickerError').hidden = !pickerError;
  retryButton.hidden = !lastError;
  savedWarning.hidden = quarantinedDomains.length === 0;
  savedWarning.textContent = quarantinedDomains.length
    ? `Invalid saved entries were preserved separately and are not active: ${quarantinedDomains.join("; ")}. Add a corrected hostname below.` : "";
  statusText.classList.toggle("failed", Boolean(lastError));
  if (!settings) {
    statusText.textContent = lastError ? "Protection not verified" : "Checking protection…";
    masterState.textContent = "";
    siteBadge.hidden = true;
    return;
  }
  masterToggle.checked = settings.enabled;
  masterState.textContent = settings.enabled ? "On" : "Off";
  toggleAds.checked = settings.rulesets.ads_ruleset;
  toggleTrackers.checked = settings.rulesets.trackers_ruleset;
  toggleThreats.checked = settings.rulesets.threats_ruleset && Boolean(threatStatus?.available);
  toggleThreats.disabled = busy || !settings.enabled || !threatStatus?.available;
  threatStatusEl.textContent = threatStatus?.error ? "Unavailable — retry the protection check" : !threatStatus?.available
    ? "Evidence expired — update required"
    : `${threatStatus.count} exact hosts · expires ${threatStatus.expiresAt.slice(0, 10)} UTC`;
  toggleCosmetic.checked = settings.cosmeticFiltering;
  toggleGenericCosmetic.checked = settings.genericCosmeticFiltering;
  toggleGenericCosmetic.disabled = busy || !settings.enabled || !settings.cosmeticFiltering;
  toggleProcedural.checked = settings.proceduralFiltering;
  toggleNotificationPrompts.checked = settings.notificationPromptBlocking;
  toggleInstallPrompts.checked = settings.deceptivePromptBlocking;
  toggleDeceptiveButtons.checked = settings.deceptiveButtonBlocking;
  toggleProcedural.disabled = busy || !settings.enabled || !settings.cosmeticFiltering;
  toggleCommunity.checked = settings.rulesets.community_ruleset;
  const lists = communityInfo?.lists || [];
  communityStatusEl.textContent = !communityInfo ? "Snapshot details unavailable" : !lists.length ? "No list snapshot is built"
    : `${lists.map(list => list.title).join(" + ")} · ${communityInfo.networkRules.toLocaleString()} rules · ${(lists[0].lastModified || "").replace(/ \d\d:\d\d.*$/, "")}`;
  toggleFlags.checked = settings.flagSuspects;
  flagStatusEl.classList.toggle("has-flags", Boolean(flagCount));
  flagStatusEl.textContent = !settings.flagSuspects ? "Off: ad-like servers that get through are not flagged"
    : flagCount === null ? "Flags ad-like servers that got through, for you to review"
    : flagCount ? `${flagCount} flagged for review: open My lists` : "Nothing flagged for review";
  for (const input of [toggleAds, toggleTrackers, toggleCommunity, toggleCosmetic, toggleFlags, toggleNotificationPrompts, toggleInstallPrompts, toggleDeceptiveButtons]) {
    input.disabled = busy || !settings.enabled;
  }
  const scope = activeHostname ? whitelistScope(activeHostname, settings.whitelistedDomains) : "";
  const promptScope = activeHostname ? whitelistScope(activeHostname, settings.promptAllowedDomains) : "";
  const promptsEnabled = settings.notificationPromptBlocking || settings.deceptivePromptBlocking || settings.deceptiveButtonBlocking;
  toggleSitePrompts.checked = !promptScope;
  toggleSitePrompts.disabled = busy || !settings.enabled || !activeHostname || Boolean(scope) || !promptsEnabled;
  byId('promptScope').textContent = !activeHostname ? "Available on HTTP(S) pages"
    : scope ? "Inactive while this site is paused"
    : !promptsEnabled ? "Enable a prompt or button filter below to use this control"
    : promptScope ? `Prompts and buttons allowed on ${promptScope} and its subdomains. Reload for notification changes.`
    : "Turn off to allow prompts and buttons on a trusted site. Reload for notification changes.";
  // The same "covered by this domain or a parent" lookup as site pauses.
  const popupScope = activeHostname ? whitelistScope(activeHostname, settings.popupBlockedDomains) : "";
  togglePopups.checked = Boolean(popupScope);
  togglePopups.disabled = busy || !settings.enabled || !activeHostname;
  popupScopeEl.textContent = !activeHostname ? "Available on HTTP(S) pages"
    : scope ? "Inactive while this site is paused"
    : popupScope ? `On for ${popupScope} and its subdomains. Reload the page after changing.`
    : "Stops pop-ups, frame takeovers and scripted page changes";
  const customNetworkBlocks = BlockAdsNetwork.parse(settings.customNetworkFilters ?? "").some(rule => rule.action.type === "block");
  const anyFilters = settings.cosmeticFiltering || promptsEnabled && !promptScope || settings.customBlockedDomains.length > 0 || customNetworkBlocks ||
    settings.rulesets.ads_ruleset || settings.rulesets.trackers_ruleset || settings.rulesets.community_ruleset || (settings.rulesets.threats_ruleset && threatStatus?.available);
  statusText.textContent = lastError ? "Check protection status" : busy ? "Applying changes…" :
    !settings.enabled ? "Protection paused" : scope ? "Paused on this site" :
    anyFilters ? "Filtering enabled" : "No filters enabled";
  statusText.classList.toggle("paused", !settings.enabled || Boolean(scope) || !anyFilters);
  // This site's state at a glance; hidden when the state is unverified or there is no site.
  const sitePaused = !settings.enabled || Boolean(scope);
  siteBadge.hidden = !activeHostname || Boolean(lastError);
  siteBadge.textContent = sitePaused ? "Paused" : anyFilters ? "Filtering" : "No filters";
  siteBadge.className = "badge" + (sitePaused ? " paused" : anyFilters ? " active" : "");
  siteWhitelistBtn.disabled = busy || !settings.enabled || !activeHostname;
  byId('pickElement').disabled = busy || !settings.enabled || !settings.cosmeticFiltering || !activeHostname || activeTabId === null || Boolean(scope) || Boolean(whitelistScope(activeHostname, settings.cosmeticPausedDomains));
  siteWhitelistBtn.classList.toggle("whitelisted", Boolean(scope));
  siteWhitelistLabel.textContent = scope
    ? scope.length > 40 ? "Resume site filtering" : `Resume on ${scope}`
    : "Pause on this site";
  siteWhitelistBtn.title = scope ? `Resume filtering for ${scope} and its subdomains` : "Pause filtering for this domain and its subdomains";
  siteScope.textContent = scope
    ? `Paused for ${scope} and its subdomains. Resume removes the matching exceptions for this whole scope. Reload the page after changing this setting.`
    : activeHostname ? "Site settings include subdomains. Reload the page after changing them." : "Site controls are available on supported HTTP(S) pages.";
  renderDomainList(customDomainList, settings.customBlockedDomains, "Unblock", "REMOVE_CUSTOM_DOMAIN");
  renderDomainList(allowDomainList, settings.allowedDomains, "Stop always allowing", "REMOVE_ALLOWED_DOMAIN");
  domainCountEl.textContent = (settings.customBlockedDomains.length + settings.allowedDomains.length) || "";
}

function selectTab(tab, focus = false) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    byId(item.getAttribute("aria-controls")).hidden = !selected;
  }
  if (focus) tab.focus();
}
for (const tab of tabs) {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", event => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    selectTab(tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length], true);
  });
}

function renderDomainList(list, domains, removeLabel, removeType) {
  list.replaceChildren();
  for (const domain of domains) {
    const li = document.createElement("li");
    li.className = "domain-item";
    const span = document.createElement("span");
    span.textContent = domain;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-remove";
    button.textContent = "✕";
    button.title = `${removeLabel} ${domain}`;
    button.setAttribute("aria-label", `${removeLabel} ${domain}`);
    button.disabled = busy;
    button.addEventListener("click", () => runCommand({ type: removeType, domain }));
    li.append(span, button);
    list.appendChild(li);
  }
}

async function runCommand(message, preserveError = false) {
  if (busy) return false;
  busy = true;
  if (!preserveError) lastError = "";
  renderUI();
  let successful = false;
  try {
    const response = await api.runtime.sendMessage(message);
    if (response?.settings) currentSettings = response.settings;
    threatStatus = response?.threatStatus || null;
    quarantinedDomains = response?.quarantinedDomains || [];
    if (!response?.ok) throw new Error(response?.error || "The extension did not return a verified state.");
    if (threatStatus?.error) lastError = threatStatus.error;
    successful = true;
  } catch (error) {
    lastError = error.message || String(error);
  } finally {
    busy = false;
    renderUI();
    if (refreshPending) {
      refreshPending = false;
      // Another popup may have committed while this one was waiting.
      void runCommand({ type: "GET_STATE" }, true);
    }
  }
  return successful;
}
const updateSettings = patch => runCommand({ type: "UPDATE_SETTINGS", patch });
byId('pickElement').addEventListener('click', async () => {
  if (busy || activeTabId === null) return;
  busy = true; pickerError = ''; renderUI();
  try {
    const response = await api.runtime.sendMessage({type:'START_PICKER', tabId:activeTabId});
    if (!response?.ok) throw new Error(response?.error || 'The picker did not open.');
  } catch (error) { pickerError = error.message || String(error); }
  finally { busy = false; renderUI(); if (refreshPending) { refreshPending = false; void runCommand({type:'GET_STATE'}, true); } }
});
masterToggle.addEventListener("change", () => updateSettings({ enabled: masterToggle.checked }));
toggleAds.addEventListener("change", () => updateSettings({ rulesets: { ads_ruleset: toggleAds.checked } }));
toggleTrackers.addEventListener("change", () => updateSettings({ rulesets: { trackers_ruleset: toggleTrackers.checked } }));
toggleThreats.addEventListener("change", () => updateSettings({ rulesets: { threats_ruleset: toggleThreats.checked } }));
toggleCosmetic.addEventListener("change", () => updateSettings({ cosmeticFiltering: toggleCosmetic.checked }));
toggleGenericCosmetic.addEventListener("change", () => updateSettings({ genericCosmeticFiltering: toggleGenericCosmetic.checked }));
toggleProcedural.addEventListener("change", () => updateSettings({ proceduralFiltering: toggleProcedural.checked }));
toggleNotificationPrompts.addEventListener("change", () => updateSettings({ notificationPromptBlocking: toggleNotificationPrompts.checked }));
toggleInstallPrompts.addEventListener("change", () => updateSettings({ deceptivePromptBlocking: toggleInstallPrompts.checked }));
toggleDeceptiveButtons.addEventListener("change", () => updateSettings({ deceptiveButtonBlocking: toggleDeceptiveButtons.checked }));
toggleSitePrompts.addEventListener("change", () => {
  if (currentSettings && activeHostname) runCommand({ type: "SET_SITE_PROMPTS", domain: activeHostname, allowed: !toggleSitePrompts.checked });
});
toggleCommunity.addEventListener("change", () => updateSettings({ rulesets: { community_ruleset: toggleCommunity.checked } }));
toggleFlags.addEventListener("change", () => updateSettings({ flagSuspects: toggleFlags.checked }));

// Count of servers waiting for a decision; a read failure leaves the generic text.
async function refreshFlagCount() {
  try {
    const response = await api.runtime.sendMessage({ type: "GET_FLAGS" });
    if (!response?.ok) throw new Error(response?.error || "No flags returned.");
    flagCount = response.flags.filter(flag => flag.status !== "ignored").length;
  } catch (error) {
    flagCount = null;
    console.warn("[Module Engine] Could not read flags:", error);
  }
  renderUI();
}
// A read-only summary: the userscript switch lives on the Modules & scripts page.
// A read failure leaves the generic text.
async function refreshScriptStatus() {
  try {
    const [state, library] = await Promise.all([api.runtime.sendMessage({ type: "MODULES_GET" }), api.runtime.sendMessage({ type: "US_LIST" })]);
    if (!state?.ok || !library?.ok) throw new Error(state?.error || library?.error || "No script status returned.");
    const module = state.modules.find(item => item.id === "userscripts");
    const label = !module || module.enabled === null || (module.enabled && module.error) ? "Needs attention" : module.active ? "Active" : "Off";
    scriptStatusEl.textContent = `${label} · ${library.scripts.filter(script => script.enabled).length} enabled · ${library.scripts.length} saved`;
  } catch (error) {
    console.warn("[Module Engine] Could not read script status:", error);
  }
}

async function refreshScriptCommands() {
  const section = byId('scriptCommands'), list = byId('scriptCommandList'), error = byId('scriptCommandError');
  section.hidden = activeTabId === null;
  if (section.hidden) return;
  error.textContent = '';
  try {
    const response = await api.runtime.sendMessage({ type: 'US_MENU_LIST', tabId: activeTabId });
    if (!response?.ok) throw new Error(response?.error || 'Script commands unavailable.');
    list.replaceChildren();
    section.hidden = !response.active;
    if (section.hidden) return;
    for (const command of response.commands) {
      const button = document.createElement('button'), label = document.createElement('span'), script = document.createElement('small');
      button.type = 'button'; button.title = command.title; button.accessKey = command.accessKey;
      label.textContent = command.caption;
      if (command.icon) { const icon = document.createElement('img'); icon.src = command.icon; icon.alt = ''; icon.width = 16; icon.height = 16; label.prepend(icon); }
      script.textContent = command.scriptName + (command.frameId ? ' · frame ' + command.frameId : '');
      button.append(label, script);
      button.addEventListener('click', async event => {
        button.disabled = true; button.dataset.commandBusy = 'true'; error.textContent = '';
        try {
          const result = await api.runtime.sendMessage({ type: 'US_MENU_RUN', tabId: activeTabId,
            connectionId: command.connectionId, menuId: command.id,
            event: { altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey } });
          if (!result?.ok) throw new Error(result?.error || 'Script command unavailable.');
          if (result.autoClose) window.close();
        } catch (failure) { error.textContent = failure.message; }
        finally { button.dataset.commandBusy = 'false'; button.disabled = busy || !currentSettings; }
      });
      list.append(button);
    }
    if (!response.commands.length) error.textContent = 'No script commands on this page.';
  } catch (failure) { list.replaceChildren(); error.textContent = failure.message; }
}
byId('refreshScriptCommands').addEventListener('click', refreshScriptCommands);
togglePopups.addEventListener("change", () => {
  if (!currentSettings || !activeHostname) return;
  runCommand({ type: "SET_SITE_POPUPS", domain: activeHostname, blocked: togglePopups.checked });
});
siteWhitelistBtn.addEventListener("click", () => {
  if (!currentSettings || !activeHostname) return;
  runCommand({
    type: "SET_SITE_PAUSED", domain: activeHostname,
    paused: !whitelistScope(activeHostname, currentSettings.whitelistedDomains)
  });
});
customBlockForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (await runCommand({ type: "ADD_CUSTOM_DOMAIN", domain: customDomainInput.value })) {
    customDomainInput.value = "";
  }
});
allowForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (await runCommand({ type: "ADD_ALLOWED_DOMAIN", domain: allowDomainInput.value })) {
    allowDomainInput.value = "";
  }
});
retryButton.addEventListener("click", () => runCommand({ type: "GET_STATE" }));
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !["enabled", "rulesets", "cosmeticFiltering", "genericCosmeticFiltering", "proceduralFiltering", "cosmeticPausedDomains", "customCosmeticFilters", "customNetworkFilters", "flagSuspects", "whitelistedDomains", "customBlockedDomains", "popupBlockedDomains", "allowedDomains", "threatStatus", "notificationPromptBlocking", "deceptivePromptBlocking", "deceptiveButtonBlocking", "promptAllowedDomains"].some(key => key in changes)) return;
  if (busy) refreshPending = true;
  else void runCommand({ type: "GET_STATE" }, true);
});
(async () => {
  renderUI();
  try { await detectActiveTabDomain(); }
  catch { currentDomainEl.textContent = "Current page unavailable"; }
  try { communityInfo = await (await fetch(api.runtime.getURL("rules/community-info.json"))).json(); }
  catch { communityInfo = null; }
  await runCommand({ type: "GET_STATE" });
  await Promise.all([refreshFlagCount(), refreshScriptStatus(), refreshScriptCommands()]);
})();
