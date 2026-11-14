const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js'); require('../src/userscripts/userscripts-page.js');
require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-actions.js');
const page = BlockAdsUserScriptPage, core = BlockAdsUserScriptCore;
const id = '12345678-1234-1234-1234-123456789abc', token = 'f'.repeat(64);
const tick = () => new Promise(setImmediate);
// A small two-realm transport fixture, not a browser/CSP emulation. The native
// suites separately verify actual MAIN/USER_SCRIPT realms, policy and messaging.
function transport({ mode = 'page', launch = true, appendError = false, textError = false, parentReady = true, sendMessage, compiled, run = 'function(runtime){globalThis.rpc=runtime;}' } = {}) {
  const nodes = [], messages = [], connections = [], payloads = [], errors = [], lifecycle = new Map();
  let mutation;
  class Element extends EventTarget {
    constructor() { super(); this.localName = 'script'; this._text = ''; }
    get textContent() { return this._text; }
    set textContent(value) { if (textError) throw new Error('Owned Trusted Types refusal'); this._text = value; }
    remove() { this.attached = false; }
    replaceChildren() { this._text = ''; }
    removeAttribute(name) { delete this[name]; }
  }
  const parent = { appendChild(node) { if (appendError) throw new Error('Owned append refusal'); node.attached = true; } };
  const document = Object.assign(new EventTarget(), {
    head: parentReady ? parent : null,
    createElement() { const node = new Element(); nodes.push(node); return node; },
    getElementById(value) { return nodes.find(node => node.attached && node.id === value); }
  });
  const events = () => { const callbacks = []; return { addListener: callback => callbacks.push(callback), fire: value => callbacks.forEach(fn => fn(value)) }; };
  const runtime = {
    sendMessage: async message => { messages.push(message); return sendMessage ? sendMessage(message) : { ok: true, exists: true, value: 'owned' }; },
    connect({ name }) {
      const port = { name, onMessage: events(), onDisconnect: events(), ended: false, disconnect() { this.ended = true; } };
      connections.push(port); return port;
    }
  };
  const globals = { document, EventTarget, CustomEvent, setTimeout, clearTimeout, URL, TextEncoder, TextDecoder,
    console: { error: (...args) => errors.push(args) }, location: { href: 'https://example.test/page' },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    addEventListener(name, callback) { if (!lifecycle.has(name)) lifecycle.set(name, new Set()); lifecycle.get(name).add(callback); },
    removeEventListener(name, callback) { lifecycle.get(name)?.delete(callback); } };
  const shared = vm.createContext({ ...globals }), isolated = vm.createContext({ ...globals, crypto, chrome: { runtime } });
  document.addEventListener('me-page-start-' + id, event => {
    const node = document.getElementById(event.detail); payloads.push(node.textContent);
    if (launch) { try { vm.runInContext(node.textContent, shared); } catch (error) { errors.push(error); } }
  });
  const options = { id, token, mode, event: 'me-page-start-' + id };
  vm.runInContext(compiled || '(' + page.host + ')(' + JSON.stringify(options) + ',' + run + ',' + JSON.stringify(page.client.toString()) + ',function(){globalThis.fallbacks=(globalThis.fallbacks||0)+1;});', isolated);
  // Native lifecycle delivery is explicit; DOM bridge events above remain real
  // EventTarget events. Synthetic lifecycle probes set isTrusted to false.
  const fire = (name, persisted = false, isTrusted = true) => { for (const callback of [...lifecycle.get(name) || []]) callback({ persisted, isTrusted }); };
  return { shared, isolated, nodes, messages, connections, payloads, errors, fire,
    mount: () => { document.head = parent; mutation?.(); }, mutate: () => mutation?.(), close: () => fire('pagehide') };
}
test('compiled page GM code never exports native capability bytes into the page or DOM', async () => {
  const source = '// ==UserScript==\n// @name Owned\n// @match https://example.test/*\n// @inject-into page\n// @grant GM.getValue\n// ==/UserScript==\nglobalThis.readOwned=()=>GM.getValue("key");';
  const records = core.registrations({ id, token, source });
  assert.deepEqual(records.map(record => record.world), ['MAIN', 'USER_SCRIPT']);
  assert.ok(!records[0].js[0].code.includes(token));
  const h = transport({ compiled: records[1].js[0].code });
  try {
    assert.equal(await h.shared.readOwned(), 'owned');
    assert.equal(h.messages[0].token, token); assert.equal(h.messages[0].id, id);
    assert.ok(h.payloads[0].includes('readOwned')); assert.ok(!h.payloads[0].includes(token));
    assert.ok(h.nodes.every(node => !node.attached && !node.id && node.textContent === ''));
    assert.equal(h.isolated.readOwned, undefined);
  } finally { h.close(); }
});
test('page bridge fixes identity, capability, native router and connection name', async () => {
  const h = transport();
  try {
    for (const message of [
      { type: 'US_ENABLE', id }, { type: 'US_VALUE', id: 'other', operation: 'get' },
      { type: 'US_VALUE', id, token, operation: 'get' }, { type: 'US_VALUE', id, operation: 'connect' }
    ]) assert.equal((await h.shared.rpc.sendMessage(message)).ok, false);
    assert.equal(h.messages.length, 0);
    assert.equal((await h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get', key: 'x' })).ok, true);
    assert.equal(h.messages[0].token, token);
    const port = h.shared.rpc.connect({ name: 'other' }); await tick();
    assert.equal(h.connections[0].name, 'US_CHANNEL:' + id + ':' + token);
    const values = []; port.onMessage.addListener(value => values.push(value));
    h.connections[0].onMessage.fire({ type: 'owned' }); assert.equal(values[0].type, 'owned');
    port.disconnect(); assert.equal(h.connections[0].ended, true);
    h.connections[0].onMessage.fire({ type: 'late' }); assert.equal(values.length, 1);
  } finally { h.close(); }
});
test('pending page calls stay bounded and shutdown rejects without retrying submitted operations', async () => {
  const finishes = [], h = transport({ sendMessage: () => new Promise(resolve => finishes.push(resolve)) });
  const calls = Array.from({ length: 8 }, () => h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' }));
  const settled = Promise.allSettled(calls);
  await assert.rejects(h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' }), /Too many pending/);
  await tick(); assert.equal(h.messages.length, 8);
  h.close();
  assert.ok((await settled).every(result => result.status === 'rejected' && /may still complete/.test(result.reason.message)));
  for (const finish of finishes) finish({ ok: true }); await tick();
  assert.equal(h.messages.length, 8);
  await assert.rejects(h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' }), /closed/);
});
test('pagehide suspends native ports and pageshow allows a fresh connection without re-execution', async () => {
  const h = transport();
  try {
    let disconnected = 0;
    const first = h.shared.rpc.connect(); first.onDisconnect.addListener(() => disconnected++); await tick();
    h.fire('pagehide', true); assert.equal(disconnected, 1); assert.equal(h.connections[0].ended, true);
    await assert.rejects(h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' }), /suspended/);
    h.fire('pageshow', true); h.shared.rpc.connect(); await tick();
    assert.equal(h.connections.length, 2); assert.equal(h.payloads.length, 1);
    assert.equal((await h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' })).ok, true);
  } finally { h.close(); }
});
test('fallback occurs only before startup claim, never after user side effects or errors', () => {
  for (const mode of ['auto', 'page']) for (const refusal of ['policy', 'append', 'text']) {
    const h = transport({ mode, launch: false, appendError: refusal === 'append', textError: refusal === 'text' });
    assert.equal(h.isolated.fallbacks || 0, mode === 'auto' ? 1 : 0);
    assert.equal(h.shared.rpc, undefined); h.close();
  }
  const h = transport({ mode: 'auto', run: 'function(){globalThis.runs=(globalThis.runs||0)+1;throw new Error("Owned failure");}' });
  assert.equal(h.shared.runs, 1); assert.equal(h.isolated.fallbacks, undefined); assert.equal(h.errors.length, 1); h.close();
});

test('synthetic lifecycle events cannot close or suspend the page bridge', async () => {
  const h = transport();
  try {
    h.shared.rpc.connect(); await tick();
    h.fire('pagehide', false, false); h.fire('pageshow', true, false);
    assert.equal((await h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' })).ok, true);
    assert.equal(h.connections[0].ended, false);
  } finally { h.close(); }
});

test('page startup waits through suspension and resumes exactly once when the DOM root is ready', () => {
  const h = transport({ parentReady: false });
  try {
    h.fire('pagehide', true); h.mount();
    assert.equal(h.shared.rpc, undefined, 'hidden document must not start');
    h.fire('pageshow', true); assert.ok(h.shared.rpc);
    h.mutate(); h.fire('pageshow', true);
    assert.equal(h.payloads.length, 1, 'old observer deliveries and duplicate show events cannot start again');
  } finally { h.close(); }
});

test('a bridge call queued before navigation is canceled before reaching native messaging', async () => {
  const h = transport();
  try {
    const call = h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'set', key: 'queued', value: 1 });
    const result = Promise.allSettled([call]);
    h.fire('pagehide', true); h.fire('pageshow', true); await tick();
    assert.equal((await result)[0].value.ok, false, 'the GM adapter receives an explicit pre-submission failure');
    assert.equal(h.messages.length, 0);
  } finally { h.close(); }
});

test('suspension rejects in-flight page calls, suppresses late replies and does not replay them on restore', async () => {
  let finish; const h = transport({ sendMessage: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const result = Promise.allSettled([h.shared.rpc.sendMessage({ type: 'US_VALUE', id, operation: 'get' })]);
    await tick(); h.fire('pagehide', true); h.fire('pageshow', true);
    finish({ ok: true, value: 'stale' }); await tick();
    assert.equal((await result)[0].status, 'rejected'); assert.equal(h.messages.length, 1); assert.equal(h.payloads.length, 1);
  } finally { h.close(); }
});

for (const message of [{ operation: 'set', key: 'x', value: 1 }, { operation: 'cookie', method: 'set', details: { name: 'owned', value: 'fixture' } }]) {
  test('suspended ' + message.operation + ' preserves submitted completion without returning stale data', async () => {
    let finish; const h = transport({ sendMessage: () => new Promise(resolve => { finish = resolve; }) });
    try {
      const result = h.shared.rpc.sendMessage({ type: 'US_VALUE', id, ...message });
      await tick(); h.fire('pagehide', true); h.fire('pageshow', true);
      finish({ ok: true, values: { secret: 'old snapshot' }, cookies: [{ value: 'old data' }] });
      assert.deepEqual(JSON.parse(JSON.stringify(await result)), { ok: true });
      assert.equal(h.messages.length, 1);
    } finally { h.close(); }
  });
}
