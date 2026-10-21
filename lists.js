/* BlockAds lists page: view and edit the person's own domain lists in tables.
 * Every change goes through the background's verified settings update; values
 * are only ever set as text. */
"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const byId = id => document.getElementById(id);
// Removal is exact here: one row removes one entry, never a covering parent.
const LISTS = {
  allowedDomains: { add: domain => ({ type: "ADD_ALLOWED_DOMAIN", domain }), remove: domain => ({ type: "REMOVE_ALLOWED_DOMAIN", domain }), removeLabel: "Remove" },
  customBlockedDomains: { add: domain => ({ type: "ADD_CUSTOM_DOMAIN", domain }), remove: domain => ({ type: "REMOVE_CUSTOM_DOMAIN", domain }), removeLabel: "Unblock" },
  whitelistedDomains: { add: domain => ({ type: "SET_SITE_PAUSED", domain, paused: true }), remove: domain => ({ type: "REMOVE_PAUSED_SITE", domain }), removeLabel: "Resume" },
  popupBlockedDomains: { add: domain => ({ type: "SET_SITE_POPUPS", domain, blocked: true }), remove: domain => ({ type: "REMOVE_POPUP_SITE", domain }), removeLabel: "Turn off" }
};
let settings = null;
let siteHosts = [];
let busy = false;
let refreshPending = false;

function showNotice(text, isError = false) {
  const notice = byId("notice");
  notice.textContent = text;
  notice.classList.toggle("error", isError);
  notice.hidden = !text;
}

const covers = domain => /^[0-9.]+$/.test(domain) || !domain.includes(".") ? "This host only" : "This domain and its subdomains";
const matches = (values, filter) => !filter || values.some(value => String(value).toLowerCase().includes(filter));

function addCell(row, text) {
  const cell = document.createElement("td");
  cell.textContent = text;
  row.append(cell);
  return cell;
}

function render() {
  const filter = byId("filter").value.trim().toLowerCase();
  for (const section of document.querySelectorAll("section[data-list]")) {
    const key = section.dataset.list;
    const entries = settings?.[key] || [];
    const shown = entries.filter(domain => matches([domain], filter));
    const body = section.querySelector("tbody");
    body.replaceChildren();
    for (const domain of shown) {
      const row = document.createElement("tr");
      addCell(row, domain);
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
    section.querySelector(".empty").hidden = shown.length > 0;
    for (const control of section.querySelectorAll("input, button")) control.disabled = busy || !settings;
  }
  const hostSection = byId("siteHosts");
  const hostBody = hostSection.querySelector("tbody");
  hostBody.replaceChildren();
  const shownHosts = siteHosts.filter(item => matches([item.domain, item.site, item.role], filter));
  for (const item of shownHosts) {
    const row = document.createElement("tr");
    for (const value of [item.domain, item.site, item.role, item.observedOnUtc]) addCell(row, value);
    hostBody.append(row);
  }
  hostSection.querySelector(".count").textContent = `(${siteHosts.length})`;
  hostSection.querySelector(".empty").hidden = shownHosts.length > 0;
}

async function run(message) {
  if (busy) return false;
  busy = true;
  render();
  let ok = false;
  try {
    const response = await api.runtime.sendMessage(message);
    if (response?.settings) settings = response.settings;
    if (!response?.ok) throw new Error(response?.error || "The extension did not return a verified state.");
    showNotice("");
    ok = true;
  } catch (error) {
    showNotice(error.message || String(error), true);
  } finally {
    busy = false;
    render();
    if (refreshPending) {
      refreshPending = false;
      void run({ type: "GET_STATE" });
    }
  }
  return ok;
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
// Changes made in the popup or another page appear here too.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(LISTS).some(key => key in changes)) return;
  if (busy) refreshPending = true;
  else void run({ type: "GET_STATE" });
});
(async () => {
  render();
  try {
    const response = await fetch(api.runtime.getURL("rules/site-ad-hosts-info.json"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error("unexpected format");
    siteHosts = data;
  } catch (error) {
    siteHosts = [];
    // Say so, rather than presenting a read failure as an empty list.
    byId("siteHosts").querySelector(".empty").textContent = `Could not read the site-check hosts (${error.message || error}). Rebuild the rules and reload BlockAds.`;
  }
  await run({ type: "GET_STATE" });
})();
