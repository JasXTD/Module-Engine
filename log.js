/* BlockAds activity log page: a read-only view of the background's session log.
 * Entries contain page-controlled URLs, so they are only ever set as text. */
"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;
const byId = id => document.getElementById(id);
const KIND_LABELS = { blocked: "Blocked", event: "Event", error: "Error" };
let entries = [];
let loading = false;

function addCell(row, text, className) {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  row.append(cell);
  return cell;
}

function showNotice(text, isError = false) {
  const notice = byId("notice");
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

async function request(type) {
  const response = await api.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || "The extension did not return the log.");
  return response;
}

async function refresh() {
  if (loading) return;
  loading = true;
  try {
    const response = await request("GET_LOG");
    entries = response.entries;
    showNotice(response.blockLogging ? "" :
      "This browser does not report individual blocked requests to extensions, so only events are listed. " +
      "Chrome and Edge report them while BlockAds is loaded unpacked; Firefox does not provide this.");
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
  if (!confirm("Clear the BlockAds activity log?")) return;
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
  link.download = `blockads-log-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
setInterval(() => {
  if (byId("liveToggle").checked && document.visibilityState === "visible") void refresh();
}, 2000);
void refresh();
