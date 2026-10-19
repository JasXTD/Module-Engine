/* BlockAds popup: render verified state and keep unsuccessful input available. */
"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const { normalizeDomain, whitelistScope } = BlockAds;
const byId = id => document.getElementById(id);
const masterToggle = byId("masterToggle");
const statusText = byId("statusText");
const currentDomainEl = byId("currentDomain");
const siteWhitelistBtn = byId("siteWhitelistBtn");
const siteScope = byId("siteScope");
const errorPanel = byId("errorPanel");
const savedWarning = byId("savedWarning");
const retryButton = byId("retryButton");
const toggleAds = byId("toggleAds");
const toggleTrackers = byId("toggleTrackers");
const toggleThreats = byId("toggleThreats");
const threatStatusEl = byId("threatStatus");
const toggleCosmetic = byId("toggleCosmetic");
const customBlockForm = byId("customBlockForm");
const customDomainInput = byId("customDomainInput");
const customDomainList = byId("customDomainList");
let currentSettings = null;
let activeHostname = "";
let busy = false;
let lastError = "";
let quarantinedDomains = [];
let refreshPending = false;
let threatStatus = null;

async function detectActiveTabDomain() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && /^https?:\/\//i.test(tab.url)) {
    try { activeHostname = normalizeDomain(tab.url); } catch { activeHostname = ""; }
  }
  currentDomainEl.textContent = activeHostname || "Browser / unsupported page";
  currentDomainEl.title = activeHostname;
}

function renderUI() {
  const settings = currentSettings;
  document.body.setAttribute("aria-busy", String(busy));
  for (const element of document.querySelectorAll("input, button")) element.disabled = busy || !settings;
  retryButton.disabled = busy;
  errorPanel.textContent = lastError;
  errorPanel.hidden = !lastError;
  retryButton.hidden = !lastError;
  savedWarning.hidden = quarantinedDomains.length === 0;
  savedWarning.textContent = quarantinedDomains.length
    ? `Invalid saved entries were preserved separately and are not active: ${quarantinedDomains.join("; ")}. Add a corrected hostname below.` : "";
  statusText.classList.toggle("failed", Boolean(lastError));
  if (!settings) {
    statusText.textContent = lastError ? "Protection not verified" : "Checking protection…";
    return;
  }
  masterToggle.checked = settings.enabled;
  toggleAds.checked = settings.rulesets.ads_ruleset;
  toggleTrackers.checked = settings.rulesets.trackers_ruleset;
  toggleThreats.checked = settings.rulesets.threats_ruleset && Boolean(threatStatus?.available);
  toggleThreats.disabled = busy || !settings.enabled || !threatStatus?.available;
  threatStatusEl.textContent = threatStatus?.error ? "Unavailable — retry the protection check" : !threatStatus?.available
    ? "Evidence expired — update required"
    : `${threatStatus.count} exact hosts · expires ${threatStatus.expiresAt.slice(0, 10)} UTC`;
  toggleCosmetic.checked = settings.cosmeticFiltering;
  for (const input of [toggleAds, toggleTrackers, toggleCosmetic]) {
    input.disabled = busy || !settings.enabled;
  }
  const scope = activeHostname ? whitelistScope(activeHostname, settings.whitelistedDomains) : "";
  const anyFilters = settings.cosmeticFiltering || settings.customBlockedDomains.length > 0 ||
    settings.rulesets.ads_ruleset || settings.rulesets.trackers_ruleset || (settings.rulesets.threats_ruleset && threatStatus?.available);
  statusText.textContent = lastError ? "Check protection status" : busy ? "Applying changes…" :
    !settings.enabled ? "Protection paused" : scope ? "Paused on this site" :
    anyFilters ? "Filtering enabled" : "No filters enabled";
  statusText.classList.toggle("paused", !settings.enabled || Boolean(scope) || !anyFilters);
  siteWhitelistBtn.disabled = busy || !settings.enabled || !activeHostname;
  siteWhitelistBtn.classList.toggle("whitelisted", Boolean(scope));
  siteWhitelistBtn.textContent = scope
    ? scope.length > 40 ? "Resume site filtering" : `Resume on ${scope}`
    : "Pause on this site";
  siteWhitelistBtn.title = scope ? `Resume filtering for ${scope} and its subdomains` : "Pause filtering for this domain and its subdomains";
  siteScope.textContent = scope
    ? `Paused for ${scope} and its subdomains. Resume removes the matching exceptions for this whole scope. Reload the page after changing this setting.`
    : activeHostname ? "Site settings include subdomains. Reload the page after changing them." : "Site controls are available on supported HTTP(S) pages.";
  customDomainList.replaceChildren();
  for (const domain of settings.customBlockedDomains) {
    const li = document.createElement("li");
    li.className = "domain-item";
    const span = document.createElement("span");
    span.textContent = domain;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-remove";
    button.textContent = "✕";
    button.title = `Unblock ${domain}`;
    button.setAttribute("aria-label", `Unblock ${domain}`);
    button.disabled = busy;
    button.addEventListener("click", () => runCommand({ type: "REMOVE_CUSTOM_DOMAIN", domain }));
    li.append(span, button);
    customDomainList.appendChild(li);
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
masterToggle.addEventListener("change", () => updateSettings({ enabled: masterToggle.checked }));
toggleAds.addEventListener("change", () => updateSettings({ rulesets: { ads_ruleset: toggleAds.checked } }));
toggleTrackers.addEventListener("change", () => updateSettings({ rulesets: { trackers_ruleset: toggleTrackers.checked } }));
toggleThreats.addEventListener("change", () => updateSettings({ rulesets: { threats_ruleset: toggleThreats.checked } }));
toggleCosmetic.addEventListener("change", () => updateSettings({ cosmeticFiltering: toggleCosmetic.checked }));
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
retryButton.addEventListener("click", () => runCommand({ type: "GET_STATE" }));
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !["enabled", "rulesets", "cosmeticFiltering", "whitelistedDomains", "customBlockedDomains", "threatStatus"].some(key => key in changes)) return;
  if (busy) refreshPending = true;
  else void runCommand({ type: "GET_STATE" }, true);
});
(async () => {
  renderUI();
  try { await detectActiveTabDomain(); }
  catch { currentDomainEl.textContent = "Current page unavailable"; }
  await runCommand({ type: "GET_STATE" });
})();
