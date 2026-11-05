/* Module Engine activity log page: a read-only view of the background's session log.
 * Entries contain page-controlled URLs, so they are only ever set as text. */
"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const byId = id => document.getElementById(id);
const KIND_LABELS = { blocked: "Blocked", event: "Event", error: "Error" };
let entries = [];
let allowedDomains = [];
let loading = false;
const isAllowed = host => allowedDomains.some(domain => BlockAds.domainMatches(host, domain));

function addCell(row, text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

// "notice" reflects the latest refresh; "actionNotice" keeps the result of a button.
function showNotice(text, isError = false, id = "notice") {
  const notice = byId(id);
  notice.textContent = text;
  notice.classList.toggle("error", isError);
  notice.hidden = !text;
}

function render() {
  const kind = byId("kindFilter").value;
  const text = byId("textFilter").value.trim().toLowerCase();
  const matchesText = entry => !text || [entry.site, entry.host, entry.path, entry.message, entry.layer]
    .some(value => String(value || "").toLowerCase().includes(text));

  const servers = new Map();
  for (const entry of entries) {
    if (entry.kind !== "blocked" || !matchesText(entry)) continue;
    const item = servers.get(entry.host) || { host: entry.host, count: 0, layers: new Set(), sites: new Set() };
    item.count++;
    item.layers.add(entry.layer);
    if (entry.site) item.sites.add(entry.site);
    servers.set(entry.host, item);
  }
  const summary = byId("summaryTable").tBodies[0];
  summary.replaceChildren();
  for (const item of [...servers.values()].sort((a, b) => b.count - a.count || a.host.localeCompare(b.host))) {
    const row = document.createElement("tr");
    addCell(row, item.host || "(unknown)");
    addCell(row, String(item.count), "count");
    addCell(row, [...item.layers].join(", "));
    addCell(row, [...item.sites].sort().join(", ") || "(unknown)");
    // An allowed domain does not override reported threats or the person's own blocks.
    const action = addCell(row, "");
    if (item.layers.has("Reported threat")) action.textContent = "Reported threat: stays blocked";
    else if (item.layers.has("Custom block")) action.textContent = "Remove it from Custom Blocked Domains";
    else if (item.host && isAllowed(item.host)) action.textContent = "Always allowed now";
    else if (item.host) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Allow";
      button.title = `Never block ${item.host} with the ad, tracker or community lists`;
      button.addEventListener("click", () => allowServer(item.host, button));
      action.append(button);
    }
    summary.append(row);
  }
  byId("summaryCount").textContent = servers.size ? `(${servers.size})` : "";
  byId("summaryEmpty").hidden = servers.size > 0;

  const shown = entries.filter(entry => (!kind || entry.kind === kind) && matchesText(entry)).reverse();
  const body = byId("entryTable").tBodies[0];
  body.replaceChildren();
  for (const entry of shown) {
    const row = document.createElement("tr");
    addCell(row, new Date(entry.time).toLocaleString(), "time");
    addCell(row, KIND_LABELS[entry.kind] || String(entry.kind), `kind kind-${entry.kind}`);
    addCell(row, entry.site || "");
    const details = addCell(row, entry.kind === "blocked" ? entry.host : entry.message || "");
    if (entry.kind === "blocked") {
      const path = document.createElement("span");
      path.className = "path";
      path.textContent = `${entry.path || ""} (${entry.type || "request"})`;
      details.append(path);
    }
    addCell(row, entry.layer || "");
    body.append(row);
  }
  byId("entryCount").textContent = `(${shown.length} of ${entries.length})`;
  byId("entryEmpty").hidden = shown.length > 0;
}

async function request(type, details = {}) {
  const response = await api.runtime.sendMessage({ type, ...details });
  if (!response?.ok) throw new Error(response?.error || "The extension did not complete the request.");
  return response;
}

async function allowServer(host, button) {
  if (!confirm(`Always allow ${host}? The ad, tracker and community lists will no longer block it on any site.`)) return;
  button.disabled = true;
  try {
    await request("ADD_ALLOWED_DOMAIN", { domain: host });
    showNotice(`${host} is now always allowed. Reload the page that needed it. You can undo this in the popup under Always Allowed Domains.`, false, "actionNotice");
    await refresh();
  } catch (error) {
    showNotice(`Could not allow ${host}: ${error.message || error}`, true, "actionNotice");
    button.disabled = false;
  }
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await request("GET_LOG");
    entries = response.entries;
    allowedDomains = Array.isArray(response.allowedDomains) ? response.allowedDomains : [];
    showNotice(response.blockLogging ? "" :
      "This browser does not report individual blocked requests to extensions, so only events are listed. " +
      "Chrome and Edge report them while Module Engine is loaded unpacked; Firefox does not provide this.");
    render();
  } catch (error) {
    showNotice(`Could not read the log: ${error.message || error}`, true);
  } finally {
    loading = false;
  }
}

byId("kindFilter").addEventListener("change", render);
byId("textFilter").addEventListener("input", render);
byId("clearButton").addEventListener("click", async () => {
  if (!confirm("Clear the Module Engine activity log?")) return;
  try {
    entries = (await request("CLEAR_LOG")).entries;
    render();
  } catch (error) {
    showNotice(`Could not clear the log: ${error.message || error}`, true);
  }
});
byId("exportButton").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `module-engine-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
setInterval(() => {
  if (byId("liveToggle").checked && document.visibilityState === "visible") void refresh();
}, 2000);
void refresh();
