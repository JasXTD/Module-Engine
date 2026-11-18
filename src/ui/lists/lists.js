/* Module Engine lists page: view and edit the person's own domain lists in tables.
 * Every change goes through the background's verified settings update; values
 * are only ever set as text. */
"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const byId = id => document.getElementById(id);
// Removal is exact here: one row removes one entry, never a covering parent.
const LISTS = {
  promptAllowedDomains: { add: domain => ({ type: "SET_SITE_PROMPTS", domain, allowed: true }), remove: domain => ({ type: "REMOVE_PROMPT_SITE", domain }), removeLabel: "Protect" },
  cosmeticPausedDomains: { add: domain => ({ type: "SET_SITE_COSMETICS", domain, paused: true }), remove: domain => ({ type: "REMOVE_COSMETIC_SITE", domain }), removeLabel: "Enable hiding" },
  allowedDomains: { add: domain => ({ type: "ADD_ALLOWED_DOMAIN", domain }), remove: domain => ({ type: "REMOVE_ALLOWED_DOMAIN", domain }), removeLabel: "Remove" },
  customBlockedDomains: { add: domain => ({ type: "ADD_CUSTOM_DOMAIN", domain }), remove: domain => ({ type: "REMOVE_CUSTOM_DOMAIN", domain }), removeLabel: "Unblock" },
  whitelistedDomains: { add: domain => ({ type: "SET_SITE_PAUSED", domain, paused: true }), remove: domain => ({ type: "REMOVE_PAUSED_SITE", domain }), removeLabel: "Resume" },
  popupBlockedDomains: { add: domain => ({ type: "SET_SITE_POPUPS", domain, blocked: true }), remove: domain => ({ type: "REMOVE_POPUP_SITE", domain }), removeLabel: "Turn off" }
};
let settings = null;
let siteHosts = [];
let siteHostsError = "";
let flags = [];
let reasonText = {};
let busy = false;
let filterDraftDirty = false;
let filterDraftBase = "";
let networkDraftDirty = false;
let networkDraftBase = "";
let networkDraftValid = true;
let threatEvidence = null;
let threatEvidenceError = '';
// Which list the evidence on screen came from: 'bundled', or 'update:<review date>'.
let threatEvidenceKey = '';
let threatExpiryTimer = null;
let threatStatus = null;
let protectionVerified = false;
let checkingThreats = false;
let communityStatus = null;
let checkingLists = false;

// The EasyList snapshots in use, bundled or updated, and the last check.
function renderFilterLists() {
  const status=communityStatus, updates=status?.updates;
  byId('communityListUpdates').checked=Boolean(settings?.communityListUpdates);
  byId('communityListUpdates').disabled=busy || !settings;
  byId('checkFilterLists').disabled=busy || checkingLists || !status?.lists.length;
  if (!status) { byId('filterListsStatus').textContent='Reading list details…'; byId('filterListsCheck').textContent=''; return; }
  const lists=status.lists.map(list => `${list.title} ${list.version || ''}`.trim()).join(' and ');
  byId('filterListsStatus').textContent=!status.lists.length ? `List details are unavailable. ${updates.notice}`.trim()
    : `${lists} · ${(status.networkRules ?? 0).toLocaleString()} network rules · ${status.source === 'update'
      ? `updated: ${status.changed.disabled.toLocaleString()} bundled rules switched off, ${status.changed.added.toLocaleString()} added`
      : 'bundled with this version'}.`;
  const when=updates.checkedAt ? new Date(updates.checkedAt).toLocaleString() : '';
  const last=checkingLists ? 'Checking now…' : !updates.checkedAt ? 'Not checked yet.'
    : updates.result === 'error' ? `The last check, ${when}, failed: ${updates.error}`
    : updates.result === 'installed' ? `The last check, ${when}, installed newer lists.`
    : `Last checked ${when}: up to date.`;
  const off=!updates.enabled ? ' Automatic updates are off.' : !settings?.rulesets.community_ruleset ? ' Automatic updates wait while the Community lists layer is off.' : '';
  byId('filterListsCheck').textContent=`${last}${off}${updates.notice && status.lists.length ? ' '+updates.notice : ''}`;
}

// Automatic updates: where they come from, the last check and the Check button.
function renderThreatUpdates() {
  const updates=threatStatus?.updates, text=byId('threatUpdateStatus');
  byId('threatUpdateTools').hidden=!updates?.configured;
  byId('checkThreatUpdate').disabled=busy || checkingThreats;
  if (!updates) { text.textContent=''; return; }
  if (!updates.configured) {
    text.textContent=updates.error || 'This version has no update address, so it uses the list bundled with it.';
    return;
  }
  const when=updates.checkedAt ? new Date(updates.checkedAt).toLocaleString() : '';
  const last=checkingThreats ? 'Checking now…' : !updates.checkedAt ? 'Not checked yet.'
    : updates.result === 'error' ? `The last check, ${when}, failed: ${updates.error}`
    : updates.result === 'installed' ? `The last check, ${when}, installed a newer list.`
    : `Last checked ${when}: up to date.`;
  text.textContent=`Signed updates from ${updates.host}, checked daily while Reported Threats is on. ${last}${updates.notice ? ' '+updates.notice : ''}`;
}

function renderThreatEvidence(filter) {
  const section=byId('threatEvidence'), body=section.querySelector('tbody');
  body.replaceChildren();
  renderThreatUpdates();
  const status=byId('threatEvidenceStatus');
  if (!threatEvidence) {
    status.textContent=threatEvidenceError || 'Reading bundled evidence…';
    section.querySelector('details').hidden=true;
    return;
  }
  section.querySelector('details').hidden=false;
  const {catalog,policy}=threatEvidence;
  section.querySelector('.count').textContent=`(${catalog.domains.length})`;
  const expired=Date.parse(policy.expiresAt) <= Date.now();
  if (expired) status.textContent=protectionVerified && threatStatus && !threatStatus.available
    ? 'Evidence expired. Reported-threat filtering is inactive.'
    : 'Evidence expired. The reported-threat layer is retired at the next protection check.';
  // An update can share the bundled list's expiry, so match the review date too.
  else if (!protectionVerified || !threatStatus || threatStatus.error || threatStatus.expiresAt !== policy.expiresAt ||
      threatStatus.reviewedAt !== policy.reviewedAt) status.textContent='Protection status is unavailable or not verified. Evidence remains visible for review.';
  else if (!settings.rulesets.threats_ruleset) status.textContent='Reported Threats is off. Turn it on in the popup to block these hosts; the evidence stays visible for review.';
  else if (!settings.enabled || !threatStatus.available) status.textContent='Reported-threat filtering is inactive. Evidence remains visible for review.';
  else status.textContent='Reported-threat rules are enabled; individual site pauses still apply.';
  byId('threatEvidenceDates').textContent=`Reviewed ${catalog.reviewedOn} · expires ${policy.expiresAt.replace('T',' ').replace('Z',' UTC')} · ${threatEvidence.source === 'update' ? 'signed update' : 'bundled with this version'}. Observation dates retain the precision of the reports.`;
  const sources=new Map(catalog.sources.map(source=>[source.id,source]));
  const shown=catalog.domains.filter(item=>matches([item.host,item.host.replaceAll('.','[.]'),item.observedOn,item.role,item.section,sources.get(item.sourceId).publisher],filter));
  for (const item of shown) {
    const row=document.createElement('tr'), source=sources.get(item.sourceId);
    addCell(row,item.host.replaceAll('.','[.]'));
    addCell(row,item.observedOn); addCell(row,item.role);
    const cell=addCell(row,''), link=document.createElement('a');
    link.textContent=source.publisher; link.href=source.url; link.target='_blank'; link.rel='noopener noreferrer';
    cell.append(link,document.createTextNode(' · '+source.publishedOn));
    addCell(row,item.section); body.append(row);
  }
  section.querySelector('.empty').hidden=shown.length > 0;
}

// Evidence for the list in use: the bundled files, or the installed signed update
// the background chose. Either is checked here again before it is shown.
async function loadThreatEvidence() {
  const key=threatStatus?.source === 'update' ? 'update:'+threatStatus.reviewedAt : 'bundled';
  if (key === threatEvidenceKey) return;
  threatEvidenceKey=key;
  let evidence=null, error='';
  try {
    let files;
    if (key === 'bundled') {
      files=await Promise.all(['threat-evidence.json','threats.json','threat-policy.json'].map(async file=>{
        const response=await fetch(api.runtime.getURL('rules/'+file));
        if (!response.ok) throw new Error(`Could not read ${file}.`);
        return new Uint8Array(await response.arrayBuffer());
      }));
    } else {
      const saved=(await api.storage.local.get('threatUpdate')).threatUpdate;
      if (!saved) throw new Error('The installed update could not be read.');
      files=[saved.evidence,saved.rules,saved.policy].map(text=>new TextEncoder().encode(text));
    }
    evidence={...(await BlockAdsEvidence.verify(...files)),source:key === 'bundled' ? 'bundled' : 'update'};
  } catch (problem) { error='Evidence details unavailable: '+problem.message; }
  // Another list may have been chosen while this one loaded.
  if (key !== threatEvidenceKey) return;
  threatEvidence=evidence; threatEvidenceError=error;
  render();
  // Refresh the display at the evidence deadline, even while this page is idle.
  clearTimeout(threatExpiryTimer);
  const expiry=Date.parse(evidence?.policy.expiresAt);
  if (Number.isFinite(expiry) && expiry > Date.now()) {
    const refreshExpiry=()=>{
      const delay=expiry-Date.now();
      if (delay <= 0) { render(); void run({type:'GET_STATE'}); }
      else threatExpiryTimer=setTimeout(refreshExpiry,Math.min(delay,2147483647));
    };
    refreshExpiry();
  }
}

function validateNetworkDraft() {
  try {
    const rules = BlockAdsNetwork.parse(byId("networkFilters").value);
    const blocks = rules.filter(rule => rule.action.type === "block").length;
    byId("networkStatus").textContent = `Unsaved draft: ${blocks} block rules and ${rules.length - blocks} request exceptions. Save to apply to future requests.`;
    networkDraftValid = true;
  } catch (error) {
    byId("networkStatus").textContent = error.message;
    networkDraftValid = false;
  }
  byId("networkStatus").classList.toggle("filter-error", !networkDraftValid);
}

function showNotice(text, isError = false) {
  const notice = byId("notice");
  notice.textContent = text;
  notice.classList.toggle("error", isError);
  notice.hidden = !text;
}

const covers = domain => /^[0-9.]+$/.test(domain) || !domain.includes(".") ? "This host only" : "Includes subdomains";
const matches = (values, filter) => !filter || values.some(value => String(value).toLowerCase().includes(filter));

// The label names the column when narrow screens stack a table's cells.
function addCell(row, text, label) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (label) cell.dataset.label = label;
  row.append(cell);
  return cell;
}

// Hostnames may wrap after a dot, never in the middle of a label.
function hostText(parent, host) {
  host.split(/(?<=\.)/).forEach((part, index) => {
    if (index) parent.append(document.createElement("wbr"));
    parent.append(part);
  });
  return parent;
}

// One value per line: a server's reasons, or the sites it was seen on.
function linesCell(row, values, label, hosts = false) {
  const cell = addCell(row, "", label);
  cell.className = "lines";
  for (const value of values) {
    const line = document.createElement("span");
    if (hosts) hostText(line, value); else line.textContent = value;
    cell.append(line);
  }
  return cell;
}

// Recent sightings read as "5 min ago"; the cell's tooltip keeps the exact time.
function ago(time) {
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : new Date(time).toLocaleDateString();
}

// An empty table says whether the list is empty or the filter matches nothing in it.
function setEmpty(section, shown, total, filter, noMatch) {
  const empty = section.querySelector(".empty");
  empty.dataset.default ??= empty.textContent;
  empty.textContent = filter && total ? noMatch : empty.dataset.default;
  empty.hidden = shown > 0;
}

function decisionButton(label, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.disabled = busy;
  button.addEventListener("click", onClick);
  return button;
}

// Block and Allow change the person's lists, then drop the flag they answered.
async function decide(site, list) {
  const question = list === "block"
    ? `Block ${site} and its subdomains on every site?`
    : `Always allow ${site}? It will not be flagged again.`;
  if (!confirm(question)) return;
  const added = await run({ type: list === "block" ? "ADD_CUSTOM_DOMAIN" : "ADD_ALLOWED_DOMAIN", domain: site });
  if (added) await run({ type: "FLAG_ACTION", site, action: "remove" });
}

function serverCell(row, flag) {
  const cell = addCell(row, flag.site, "Server");
  const others = flag.hosts.filter(host => host !== flag.site);
  if (others.length) {
    const hosts = document.createElement("div");
    hosts.className = "muted";
    hosts.textContent = others.join(", ");
    cell.append(hosts);
  }
  cell.title = flag.samples.length ? `Examples:\n${flag.samples.join("\n")}` : "";
}

function renderFlags(filter) {
  const section = byId("flags");
  const why = flag => flag.reasons.map(reason => reasonText[reason] || reason).join("; ");
  const visible = flags.filter(flag => matches([flag.site, why(flag), ...flag.hosts, ...flag.pages], filter));
  const pending = visible.filter(flag => flag.status !== "ignored").sort((a, b) => b.lastSeen - a.lastSeen);
  const ignored = visible.filter(flag => flag.status === "ignored");
  const body = byId("flagTable").querySelector("tbody");
  body.replaceChildren();
  const reasons = flag => flag.reasons.map(reason => reasonText[reason] || reason);
  const decisions = (...buttons) => { const group = document.createElement("div"); group.className = "decisions"; group.append(...buttons); return group; };
  for (const flag of pending) {
    const row = document.createElement("tr");
    serverCell(row, flag);
    linesCell(row, reasons(flag), "Why flagged");
    linesCell(row, flag.pages, "Seen on", true);
    addCell(row, String(flag.count), "Times");
    addCell(row, ago(flag.lastSeen), "Last seen").title = new Date(flag.lastSeen).toLocaleString();
    addCell(row, "", "Decision").append(decisions(
      decisionButton("Block", `Add ${flag.site} to Custom Blocked Domains`, () => decide(flag.site, "block")),
      decisionButton("Allow", `Add ${flag.site} to Always Allowed Domains`, () => decide(flag.site, "allow")),
      decisionButton("Ignore", `Stop flagging ${flag.site} without blocking it`, () => run({ type: "FLAG_ACTION", site: flag.site, action: "ignore" }))));
    body.append(row);
  }
  const ignoredBody = byId("ignoredFlags").querySelector("tbody");
  ignoredBody.replaceChildren();
  for (const flag of ignored) {
    const row = document.createElement("tr");
    serverCell(row, flag);
    linesCell(row, reasons(flag), "Why flagged");
    linesCell(row, flag.pages, "Seen on", true);
    addCell(row, "", "Decision").append(decisions(decisionButton("Unignore", `Flag ${flag.site} again`, () => run({ type: "FLAG_ACTION", site: flag.site, action: "unignore" }))));
    ignoredBody.append(row);
  }
  const waiting = flags.filter(flag => flag.status !== "ignored").length;
  section.querySelector(".count").textContent = filter ? `(${pending.length} of ${waiting})` : `(${waiting})`;
  setEmpty(section, pending.length, waiting, filter, "No flagged servers match the filter.");
  byId("ignoredFlags").querySelector(".ignored-count").textContent = `(${ignored.length})`;
  byId("clearFlags").disabled = busy || !flags.length;
}

function render() {
  const filter = byId("filter").value.trim().toLowerCase();
  renderThreatEvidence(filter);
  renderFilterLists();
  if (settings && !networkDraftDirty) {
    networkDraftBase = settings.customNetworkFilters;
    if (byId("networkFilters").value !== networkDraftBase) byId("networkFilters").value = networkDraftBase;
  }
  byId("networkCount").textContent = settings ? `(${BlockAdsNetwork.parse(settings.customNetworkFilters).length})` : "";
  byId("networkActivity").textContent = !settings ? "Reading saved filters…" : settings.enabled
    ? "Saved filters apply to future requests. Reload a page to apply them to resources already loaded."
    : "Custom request filters are paused with the master switch.";
  byId("networkFilters").disabled = busy || !settings;
  byId("saveNetworkFilters").disabled = busy || !settings || !networkDraftDirty || !networkDraftValid;
  byId("discardNetworkFilters").disabled = busy || !settings || !networkDraftDirty;
  if (settings && !filterDraftDirty) {
    filterDraftBase = settings.customCosmeticFilters;
    if (byId("customFilters").value !== filterDraftBase) byId("customFilters").value = filterDraftBase;
  }
  byId("genericCosmetics").checked = Boolean(settings?.genericCosmeticFiltering);
  byId("proceduralFiltering").checked = Boolean(settings?.proceduralFiltering);
  for (const id of ["genericCosmetics", "proceduralFiltering", "customFilters"]) byId(id).disabled = busy || !settings;
  for (const id of ["saveFilters", "discardFilters"]) byId(id).disabled = busy || !settings || !filterDraftDirty;
  renderFlags(filter);
  for (const section of document.querySelectorAll("section[data-list]")) {
    const key = section.dataset.list;
    const entries = settings?.[key] || [];
    const shown = entries.filter(domain => matches([domain], filter));
    const body = section.querySelector("tbody");
    body.replaceChildren();
    for (const domain of shown) {
      const row = document.createElement("tr");
      hostText(addCell(row, ""), domain);
      addCell(row, covers(domain));
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = LISTS[key].removeLabel;
      button.setAttribute("aria-label", `${LISTS[key].removeLabel} ${domain}`);
      button.disabled = busy;
      button.addEventListener("click", () => run(LISTS[key].remove(domain)));
      addCell(row, "").append(button);
      body.append(row);
    }
    section.querySelector(".count").textContent = filter ? `(${shown.length} of ${entries.length})` : `(${entries.length})`;
    setEmpty(section, shown.length, entries.length, filter, "No entries match the filter.");
    for (const control of section.querySelectorAll("input, button")) control.disabled = busy || !settings;
  }
  const hostSection = byId("siteHosts");
  const hostBody = hostSection.querySelector("tbody");
  hostBody.replaceChildren();
  const shownHosts = siteHosts.filter(item => matches([item.domain, item.site, item.role], filter));
  for (const item of shownHosts) {
    const row = document.createElement("tr");
    [item.domain, item.site, item.role, item.observedOnUtc].forEach((value, index) => addCell(row, value, ["Domain", "Found on", "What it did", "Date (UTC)"][index]));
    hostBody.append(row);
  }
  hostSection.querySelector(".count").textContent = `(${siteHosts.length})`;
  // A read failure is reported as such, never presented as an empty list.
  const hostEmpty = hostSection.querySelector(".empty");
  hostEmpty.textContent = siteHostsError || (filter && siteHosts.length ? "No site-check hosts match the filter." : "No hosts from site checks.");
  hostEmpty.hidden = shownHosts.length > 0;
}

// Commands run one at a time, in order. They queue rather than being dropped, so
// a two-step decision (block, then remove the flag) survives a refresh that a
// list change triggers in between.
let pending = 0;
let queue = Promise.resolve();
function run(message) {
  pending++;
  busy = true;
  render();
  const result = queue.then(() => execute(message)).finally(() => {
    busy = --pending > 0;
    render();
  });
  queue = result.catch(() => {});
  return result;
}

async function execute(message) {
  try {
    const response = await api.runtime.sendMessage(message);
    if (response?.settings) settings = response.settings;
    if (response?.communityStatus) communityStatus = response.communityStatus;
    if (response?.threatStatus) {
      threatStatus = response.threatStatus;
      void loadThreatEvidence();
    }
    if (response?.threatStatus || !response?.ok) protectionVerified = Boolean(response?.ok);
    if (response?.flags) {
      flags = response.flags;
      flagRefresh++; // a refresh started before this change would be stale
    }
    if (response?.reasons) reasonText = response.reasons;
    if (!response?.ok) throw new Error(response?.error || "The extension did not return a verified state.");
    showNotice("");
    return true;
  } catch (error) {
    protectionVerified = false;
    showNotice(error.message || String(error), true);
    return false;
  }
}

// Flags change about once a second while browsing. Refresh them without the busy
// state, so buttons never flicker disabled and swallow a click; newest result wins.
let flagRefresh = 0;
async function refreshFlags() {
  const id = ++flagRefresh;
  try {
    const response = await api.runtime.sendMessage({ type: "GET_FLAGS" });
    if (!response?.ok) throw new Error(response?.error || "The extension did not return the flags.");
    if (id !== flagRefresh) return;
    flags = response.flags;
    reasonText = response.reasons;
    render();
  } catch (error) {
    if (id === flagRefresh) showNotice(`Could not read the flags: ${error.message || error}`, true);
  }
}

for (const section of document.querySelectorAll("section[data-list]")) {
  const form = section.querySelector("form");
  const input = form.querySelector("input");
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (await run(LISTS[section.dataset.list].add(input.value))) input.value = "";
  });
}
byId("filter").addEventListener("input", render);
byId("networkFilters").addEventListener("input", () => {
  networkDraftDirty = true;
  validateNetworkDraft(); render();
});
byId("discardNetworkFilters").addEventListener("click", () => {
  networkDraftDirty = false; networkDraftValid = true;
  byId("networkStatus").classList.remove("filter-error");
  byId("networkStatus").textContent = "Loaded the saved network filters.";
  render();
});
byId("saveNetworkFilters").addEventListener("click", async () => {
  if (busy || !settings || !networkDraftDirty) return;
  validateNetworkDraft();
  if (!networkDraftValid) { render(); return; }
  const text = byId("networkFilters").value;
  if (await run({ type: "SAVE_NETWORK_FILTERS", text, previous: networkDraftBase })) {
    networkDraftDirty = false;
    byId("networkStatus").textContent = "Network filters saved and verified. Reload affected pages.";
    byId("networkStatus").classList.remove("filter-error");
    render();
  } else {
    byId("networkStatus").textContent = byId("notice").textContent;
    byId("networkStatus").classList.add("filter-error");
  }
});
byId("genericCosmetics").addEventListener("change", () => run({ type: "UPDATE_SETTINGS", patch: { genericCosmeticFiltering: byId("genericCosmetics").checked } }));
byId("proceduralFiltering").addEventListener("change", () => run({ type: "UPDATE_SETTINGS", patch: { proceduralFiltering: byId("proceduralFiltering").checked } }));
byId("customFilters").addEventListener("input", () => {
  filterDraftDirty = true;
  byId("filterStatus").textContent = "Unsaved draft. Save to apply it to open pages.";
  render();
});
byId("discardFilters").addEventListener("click", () => {
  filterDraftDirty = false;
  byId("filterStatus").textContent = "Loaded the saved filters.";
  render();
});
byId("saveFilters").addEventListener("click", async () => {
  const text = byId("customFilters").value;
  try {
    const probe = document.createDocumentFragment();
    const rules = BlockAdsCosmetic.parse(text, selector => {
      try { probe.querySelector(selector); return true; } catch { return false; }
    });
    if (await run({ type: "SAVE_COSMETIC_FILTERS", text, previous: filterDraftBase })) {
      filterDraftDirty = false;
      byId("filterStatus").textContent = `Saved ${rules.length} rules. Open pages update automatically.`;
      render();
    } else byId("filterStatus").textContent = byId("notice").textContent;
  } catch (error) { byId("filterStatus").textContent = error.message; }
});
byId("communityListUpdates").addEventListener("change", event => {
  void run({ type: "UPDATE_SETTINGS", patch: { communityListUpdates: event.target.checked } });
});
byId("checkFilterLists").addEventListener("click", async () => {
  checkingLists = true;
  render();
  try { await run({ type: "CHECK_LIST_UPDATES" }); }
  finally { checkingLists = false; render(); }
});
byId("checkThreatUpdate").addEventListener("click", async () => {
  checkingThreats = true;
  render();
  try { await run({ type: "CHECK_THREAT_UPDATE" }); }
  finally { checkingThreats = false; render(); }
});
byId("clearFlags").addEventListener("click", () => {
  if (confirm("Clear every flag, including ignored servers? Nothing is blocked or allowed by this.")) void run({ type: "FLAG_ACTION", action: "clear" });
});
// Changes made in the popup, another page or by browsing appear here too.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ("adFlags" in changes) void refreshFlags();
  if (changes.protectionError?.newValue) { protectionVerified=false; render(); }
  if ([...Object.keys(LISTS), "enabled", "rulesets", "threatStatus", "communityStatus", "communityListUpdates", "genericCosmeticFiltering", "proceduralFiltering", "customCosmeticFilters", "customNetworkFilters"].some(key => key in changes)) void run({ type: "GET_STATE" });
});
(async () => {
  render();
  await loadThreatEvidence();
  try {
    const response = await fetch(api.runtime.getURL("rules/community-info.json"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    byId("cosmeticSummary").textContent = `${(info.genericCosmeticSelectors || 0).toLocaleString()} generic selectors · ${(info.cosmeticSelectors || 0).toLocaleString()} site selectors · ${(info.proceduralCosmeticRules || 0).toLocaleString()} advanced rules. Site exceptions are respected.`;
  } catch { byId("cosmeticSummary").textContent = "Bundled coverage details are unavailable. Rebuild the rules and reload Module Engine."; }
  try {
    const response = await fetch(api.runtime.getURL("rules/site-ad-hosts-info.json"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("unexpected format");
    siteHosts = data;
  } catch (error) {
    siteHosts = [];
    // Say so, rather than presenting a read failure as an empty list.
    siteHostsError = `Could not read the site-check hosts (${error.message || error}). Rebuild the rules and reload Module Engine.`;
  }
  await run({ type: "GET_STATE" });
  await refreshFlags();
})();
