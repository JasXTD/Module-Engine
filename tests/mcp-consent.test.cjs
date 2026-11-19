/* Exercise the real MCP page's consent, cancellation and transmission boundary. */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const protocol = require('../src/shared/debug-protocol.js');
const source = fs.readFileSync(path.join(__dirname, '../src/ui/mcp/debug.js'), 'utf8');
const DATA = ['browsingActivity', 'websiteContent', 'technicalAndInteraction'];
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t, { supported = true, getAll, request } = {}) {
  const elements = new Map(), events = new Map(), removed = new Set();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: true, disabled: false, textContent: '', children: [],
      addEventListener(name, callback) { events.set(id + ':' + name, callback); }, replaceChildren() {}, querySelectorAll() { return []; },
      prepend(child) { this.children.unshift(child); } });
    return elements.get(id);
  };
  element('shareNetwork').checked = element('shareChanges').checked = false;
  element('pairingCode').value = 'ME1.12345.' + 'a'.repeat(43);
  const state = { grants: [], requests: [], calls: [], ports: 0, nativeMessages: [] };
  const api = { permissions: {
    getAll: getAll || (async () => supported ? { data_collection: state.grants } : {}),
    async request(value) { state.requests.push(value); const approved = request ? await request() : true; if (approved) state.grants = [...DATA]; return approved; },
    async contains(value) { return value.data_collection.every(type => state.grants.includes(type)); },
    onRemoved: { addListener(callback) { removed.add(callback); } }
  }, runtime: { connect() {
    state.ports++;
    let message, closed;
    return { onMessage: { addListener(callback) { message = callback; state.deliver = callback; } }, onDisconnect: { addListener(callback) { closed = callback; } },
      postMessage(value) { state.nativeMessages.push(value); if (value.type === 'approve') queueMicrotask(() => message({ type: 'ready', expiresAt: Date.now() + 60000 })); },
      disconnect() { closed?.(); } };
  } } };
  vm.runInNewContext(source, { browser: api, ModuleEngineDebugProtocol: protocol, BlockAdsScriptReview: {},
    document: { title: 'MCP', getElementById: element, createElement: () => ({ textContent: '' }) }, navigator: { userAgent: supported ? 'Firefox/160' : 'Chromium' },
    addEventListener(name, callback) { events.set(name, callback); }, AbortController, AbortSignal, TextDecoder, Uint8Array,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, options) => {
      state.calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/poll') && state.nextRequest) {
        const request = state.nextRequest; state.nextRequest = null; return new Response(JSON.stringify({ request }));
      }
      if (url.endsWith('/poll')) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return new Response(JSON.stringify(url.endsWith('/pair') ? { token: 'b'.repeat(43), expiresAt: Date.now() + 60000,
        scopes: JSON.parse(options.body).scopes } : {}));
    }
  }, { filename: 'debug.js' });
  const fire = (name, value) => events.get(name)?.(value);
  t.after(() => fire('pagehide'));
  return { state, element, fire,
    submit: (isTrusted = true) => fire('connectForm:submit', { isTrusted, preventDefault() {} }),
    revoke: () => { state.grants = []; for (const callback of removed) callback({ data_collection: DATA }); }
  };
}

test('MCP waits for browser capability detection and refuses a failed permission check', async t => {
  const pending = deferred(), h = fixture(t, { getAll: () => pending.promise });
  assert.equal(h.element('connect').disabled, true);
  await h.submit(); assert.equal(h.state.calls.length, 0);
  pending.resolve({ data_collection: [] }); await flush();
  assert.equal(h.element('connect').disabled, false);
  const failed = fixture(t, { getAll: async () => { throw new Error('permission service failed'); } });
  await flush(); await failed.submit();
  assert.equal(failed.element('connect').disabled, true);
  assert.equal(failed.state.calls.length, 0);
  assert.match(failed.element('status').textContent, /permission/i);
});

test('denied or synthetic MCP consent sends no data and opens no native port', async t => {
  const h = fixture(t, { request: async () => false }); await flush();
  await h.submit(false); assert.equal(h.state.requests.length, 0);
  await h.submit();
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.requests)), [{ data_collection: DATA }]);
  assert.equal(h.state.calls.length, 0); assert.equal(h.state.ports, 0);
  assert.match(h.element('status').textContent, /not granted/i);
  assert.equal(h.element('connect').disabled, false);
});

test('Disconnect or page unload cancels a pending permission prompt without pairing later', async t => {
  for (const event of ['disconnect:click', 'pagehide']) {
    const pending = deferred(), h = fixture(t, { request: () => pending.promise }); await flush();
    const submit = h.submit(); await flush();
    assert.equal(h.state.calls.length, 0);
    h.fire(event); pending.resolve(true); await submit;
    assert.equal(h.state.calls.length, 0, event); assert.equal(h.state.ports, 0, event);
  }
});

test('granted data consent allows pairing and revocation immediately disconnects', async t => {
  const h = fixture(t); await flush(); await h.submit(); await flush();
  assert.equal(h.state.ports, 1);
  assert.ok(h.state.calls.some(call => call.url.endsWith('/pair')));
  assert.match(h.element('connectionBadge').textContent, /^Connected/);
  h.revoke(); await flush();
  assert.equal(h.element('connectionBadge').textContent, 'Disconnected');
  assert.match(h.element('status').textContent, /permission.*removed/i);
  assert.deepEqual(h.state.calls.filter(call => call.url.endsWith('/result')), []);
});

test('browsers without data-collection permissions retain the existing explicit MCP approval', async t => {
  const h = fixture(t, { supported: false }); await flush(); await h.submit(); await flush();
  assert.equal(h.state.requests.length, 0);
  assert.equal(h.state.ports, 1);
  assert.match(h.element('connectionBadge').textContent, /^Connected/);
});

test('a completed browser read is not delivered after consent changes, even before the removal event', async t => {
  const h = fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  h.state.nextRequest = { id, name: 'module_engine_status', arguments: {} };
  await flush(); await h.submit(); await flush();
  assert.ok(h.state.nativeMessages.some(message => message.type === 'read' && message.id === id));
  h.state.grants = [];
  h.state.deliver({ type: 'result', id, result: { ok: true, privateData: 'must stay local' } });
  await flush();
  assert.equal(h.state.calls.filter(call => call.url.endsWith('/result')).length, 0);
  assert.match(h.element('status').textContent, /permission.*removed/i);
});
