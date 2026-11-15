/* Network viewer: native extension port, literal rendering and explicit capture. */
'use strict';
const api = typeof browser !== 'undefined' ? browser : chrome;
const byId = id => document.getElementById(id);
const PAGE_SIZE = 100, pending = new Map(), objectURLs = new Set();
const labels = { request: 'Requested', sent: 'Sent', response: 'Receiving', complete: 'Completed', redirect: 'Redirected', error: 'Failed', interrupted: 'Interrupted' };
let port, disconnected = false, requestId = 0, busy = false, reading = false;
let state = null, latest = [], entries = [], pageIndex = 0, selectedId = null, pollTimer;

function notice(text, error = false) {
  const node = byId('notice');
  if (node.textContent !== text) node.textContent = text;
  node.hidden = !text; node.classList.toggle('error', error);
}
function controls() {
  const usable = !disconnected && !busy && state?.available;
  byId('startCapture').disabled = !usable || state.active;
  byId('stopCapture').disabled = !usable || !state.active;
  byId('captureScope').disabled = !usable || state.active;
  byId('refreshTabs').disabled = !usable || state.active;
  byId('clearLog').disabled = !usable || !state.count;
  byId('exportLog').disabled = !filtered().length;
  byId('captureBadge').textContent = disconnected ? 'Disconnected' : state?.active ? 'Recording' : 'Not recording';
  byId('captureBadge').classList.toggle('recording', !disconnected && Boolean(state?.active));
  if (!state) return;
  byId('captureCount').textContent = `${state.count.toLocaleString()} entries · ${(state.bytes / 1024).toFixed(1)} KiB` + (state.dropped ? ` · ${state.dropped.toLocaleString()} older entries discarded` : '');
  byId('captureHint').textContent = state.active
    ? `${state.ownsCapture ? 'This page owns the capture.' : 'Another Network page owns the capture.'} Recording ${state.tabId === null ? 'all browser traffic' : 'tab ' + state.tabId} until ${new Date(state.expiresAt).toLocaleTimeString()}.` + (!byId('liveView').checked ? ' Live view is paused; capture continues.' : '')
    : 'Starting a new capture clears the previous one. Switching sections keeps it running. Capture stops when this tab closes or after 30 minutes.';
}
function apply(result, force = false) {
  state = result.status;
  if (result.entries) latest = result.entries;
  if (force || result.entries && byId('liveView').checked) { entries = latest; render(); }
  controls(); notice(state.error || state.reason, Boolean(state.error));
}
function request(type, details = {}) {
  if (disconnected) return Promise.reject(new Error('Connection closed. Reload this page to reconnect.'));
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => disconnect('The network log did not respond. Reload this page to reconnect.'), 10000);
    pending.set(id, { resolve, reject, timer });
    try { port.postMessage({ type, id, ...details }); }
    catch { disconnect('Connection closed. Reload this page to reconnect.'); }
  });
}
function disconnect(message = 'Connection closed. Reload this page to reconnect.') {
  if (disconnected) return;
  disconnected = true; clearInterval(pollTimer);
  for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error(message)); }
  pending.clear();
  // Chrome does not notify this end of a port when it disconnects itself.
  try { port?.disconnect(); } catch { /* Already closed. */ }
  controls(); notice(message, true);
}
function optionList(select, items) {
  const previous = select.value, signature = JSON.stringify(items);
  if (select.dataset.options === signature) return;
  select.replaceChildren(...items.map(([value, text]) => {
    const option = document.createElement('option'); option.value = String(value); option.textContent = text; return option;
  }));
  if (items.some(([value]) => String(value) === previous)) select.value = previous;
  select.dataset.options = signature;
}
async function tabs() {
  const items = (await api.tabs.query({})).filter(tab => /^https?:\/\//.test(tab.url || '')).map(tab => {
    let host = '(unknown)'; try { host = new URL(tab.url).host; } catch { /* A tab can navigate while queried. */ }
    return [String(tab.id), `Tab ${tab.id} · ${host}`];
  });
  optionList(byId('captureScope'), [['all', 'All browser traffic'], ...items]);
}
function filtered() {
  const query = byId('textFilter').value.trim().toLowerCase(), tab = byId('tabFilter').value;
  const type = byId('typeFilter').value, outcome = byId('outcomeFilter').value;
  return entries.filter(row => (tab === 'all' || String(row.tabId) === tab) && (!type || row.type === type) &&
    (!query || [row.url, row.method, row.error, row.redirectTo, row.initiator].some(value => value.toLowerCase().includes(query))) &&
    (!outcome || (outcome === 'pending' ? ['request', 'sent', 'response'].includes(row.state)
      : outcome === 'http-error' ? row.statusCode >= 400 : row.state === outcome))).slice().reverse();
}
const time = value => value === null ? 'Not observed' : new Date(value).toLocaleString();
const duration = row => row.startedAt !== null && row.endedAt !== null ? `${Math.max(0, row.endedAt - row.startedAt).toFixed(0)} ms` : '—';
function cell(row, text, className = '') {
  const node = document.createElement('td'); node.textContent = text; node.className = className; row.append(node); return node;
}
function secondary(parent, text, className) {
  const node = document.createElement('span'); node.textContent = text; node.className = className; parent.append(node);
}
function details() {
  const entry = entries.find(row => row.id === selectedId);
  byId('requestDetails').hidden = !entry;
  if (!entry) { selectedId = null; return; }
  const fields = [['URL', entry.url], ['Request', `${entry.method} · ${entry.type}`], ['Result', `${entry.statusCode ?? 'No HTTP status'} · ${labels[entry.state]}`],
    ['Initiator origin', entry.initiator || 'Not supplied by browser'], ['Tab / frame', `${entry.tabId < 0 ? 'Background' : entry.tabId} / ${entry.frameId}`],
    ['Browser request ID', entry.requestId], ['First observed', time(entry.observedAt)], ['Request started', time(entry.startedAt)],
    ['Request sent', time(entry.sentAt)], ['Response started', time(entry.responseAt)], ['Request ended', time(entry.endedAt)],
    ['Total duration', duration(entry)], ['From cache', entry.fromCache ? 'Yes' : 'Not reported'],
    ['Redirect destination', entry.redirectTo || 'None recorded'], ['Error', entry.error || 'None recorded'],
    ['Coverage', entry.partial ? 'Partial: capture did not observe the request start.' : 'Request start observed.']];
  byId('detailsFields').replaceChildren(...fields.flatMap(([name, value]) => {
    const term = document.createElement('dt'), description = document.createElement('dd');
    term.textContent = name; description.textContent = value; return [term, description];
  }));
}
function render() {
  optionList(byId('tabFilter'), [['all', 'All captured tabs'], ...[...new Set(entries.map(row => row.tabId))].sort((a,b) => a-b).map(id => [String(id), id < 0 ? 'Background' : `Tab ${id}`])]);
  optionList(byId('typeFilter'), [['', 'All types'], ...[...new Set(entries.map(row => row.type))].sort().map(type => [type, type || 'Unknown'])]);
  const matches = filtered(), pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
  pageIndex = Math.min(pageIndex, pages - 1);
  const shown = matches.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE), body = byId('requestTable').tBodies[0];
  const focused = body.contains(document.activeElement) ? document.activeElement.dataset.requestId : null;
  const fragment = document.createDocumentFragment();
  for (const entry of shown) {
    const row = document.createElement('tr'); row.dataset.requestId = String(entry.id); row.setAttribute('aria-selected', String(selectedId === entry.id));
    cell(row, new Date(entry.observedAt).toLocaleTimeString(), 'time').title = time(entry.observedAt);
    const requestCell = cell(row, ''), button = document.createElement('button'), url = new URL(entry.url);
    button.type = 'button'; button.className = 'request-url'; button.dataset.requestId = String(entry.id); button.textContent = url.host;
    secondary(button, url.pathname, 'path'); button.title = 'Inspect ' + entry.url;
    button.addEventListener('click', () => { selectedId = entry.id; render(); byId('requestDetails').scrollIntoView({ block: 'nearest' }); });
    requestCell.append(button);
    const method = cell(row, entry.method || '—', 'method'); secondary(method, entry.type, 'resource-type');
    const result = cell(row, `${entry.statusCode ? entry.statusCode + ' · ' : ''}${labels[entry.state]}`, 'result-' + (entry.statusCode >= 400 ? 'error' : entry.state));
    if (entry.error) secondary(result, entry.error, 'request-error');
    else if (entry.fromCache) secondary(result, 'From cache', 'resource-type');
    else if (entry.partial) secondary(result, 'Start not observed', 'resource-type');
    cell(row, duration(entry), 'duration'); cell(row, entry.tabId < 0 ? 'BG' : String(entry.tabId), 'tab-id'); fragment.append(row);
  }
  body.replaceChildren(fragment);
  if (focused) body.querySelector(`button[data-request-id="${focused}"]`)?.focus({ preventScroll: true });
  byId('emptyState').hidden = matches.length > 0;
  byId('emptyState').textContent = entries.length ? 'No requests match these filters.' : state?.active ? 'Waiting for traffic. Browse or reload the page you want to inspect.' : 'Start a capture, then browse or reload the page you want to inspect.';
  byId('resultCount').textContent = `(${matches.length.toLocaleString()} of ${entries.length.toLocaleString()})`;
  byId('pageLabel').textContent = matches.length ? `Page ${pageIndex + 1} of ${pages} · ${shown.length} shown` : 'No entries';
  byId('previousPage').disabled = pageIndex === 0; byId('nextPage').disabled = pageIndex + 1 >= pages;
  byId('exportLog').disabled = !matches.length;
  details();
}
async function act(type, data = {}) {
  if (busy) return;
  busy = true; controls();
  try { const result = await request(type, data); pageIndex = 0; selectedId = null; apply(result, true); }
  catch (error) { notice(error.message, true); }
  finally { busy = false; controls(); }
}
async function refresh() {
  if (reading || busy || disconnected) return;
  reading = true;
  try { apply(await request('read', state ? { after: state.revision } : {})); }
  catch (error) { notice(error.message, true); }
  finally { reading = false; }
}
byId('startCapture').addEventListener('click', event => { if (event.isTrusted) void act('start', { tabId: byId('captureScope').value === 'all' ? null : Number(byId('captureScope').value) }); });
byId('stopCapture').addEventListener('click', event => { if (event.isTrusted) void act('stop'); });
byId('clearLog').addEventListener('click', event => { if (event.isTrusted) void act('clear'); });
byId('refreshTabs').addEventListener('click', () => { void tabs().catch(error => notice('Could not refresh tabs: ' + error.message, true)); });
for (const id of ['textFilter', 'tabFilter', 'typeFilter', 'outcomeFilter']) byId(id).addEventListener(id === 'textFilter' ? 'input' : 'change', () => { pageIndex = 0; render(); });
byId('liveView').addEventListener('change', () => { if (byId('liveView').checked) { entries = latest; render(); } controls(); });
byId('previousPage').addEventListener('click', () => { pageIndex--; render(); });
byId('nextPage').addEventListener('click', () => { pageIndex++; render(); });
byId('closeDetails').addEventListener('click', () => {
  const previous = selectedId; selectedId = null; render();
  byId('requestTable').querySelector(`button[data-request-id="${previous}"]`)?.focus();
});
byId('exportLog').addEventListener('click', event => {
  if (!event.isTrusted) return;
  const data = { schemaVersion: 1, exportedAt: new Date().toISOString(),
    scope: state?.tabId ?? 'all', redaction: 'URL credentials, query strings and fragments omitted. No headers or bodies.', entries: filtered() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  objectURLs.add(url); const link = document.createElement('a'); link.href = url;
  link.download = 'module-engine-network-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'; link.click();
  setTimeout(() => { URL.revokeObjectURL(url); objectURLs.delete(url); }, 1000);
});
try {
  port = api.runtime.connect({ name: 'ME_NETWORK_LOG' });
  port.onMessage.addListener(message => {
    const job = pending.get(message.id); if (!job) return;
    pending.delete(message.id); clearTimeout(job.timer);
    if (message.ok) job.resolve(message); else job.reject(new Error(message.error || 'Network-log request failed.'));
  });
  port.onDisconnect.addListener(() => disconnect());
  void tabs().catch(error => notice('Could not list tabs: ' + error.message, true));
  void refresh(); pollTimer = setInterval(() => { if (document.documentElement.dataset.meSectionActive !== 'false') void refresh(); }, 1000);
} catch (error) { disconnected = true; controls(); notice('Could not connect: ' + error.message, true); }
addEventListener('pagehide', () => {
  clearInterval(pollTimer); port?.disconnect();
  for (const url of objectURLs) URL.revokeObjectURL(url); objectURLs.clear();
}, { once: true });
addEventListener('module-engine-section-change', () => { if (document.documentElement.dataset.meSectionActive === 'true') void refresh(); });
