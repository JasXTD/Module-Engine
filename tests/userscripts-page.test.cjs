const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js'); require('../src/userscripts/userscripts-page.js');
require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-actions.js');
const page = BlockAdsUserScriptPage, core = BlockAdsUserScriptCore;
const id = '12345678-1234-1234-1234-123456789abc', token = 'f'.repeat(64);
const tick = () => new Promise(setImmediate);
// The event name the compiled MAIN bootstrap listens for.
const startEvent = records => JSON.parse(/\)\(("me-page-start-[^"]*")\);$/.exec(records[0].js[0].code)[1]);
// A small two-realm transport fixture, not a browser/CSP emulation. The native
// suites separately verify actual MAIN/USER_SCRIPT realms, policy and messaging.
function transport({ mode = 'page', launch = true, appendError = false, textError = false, parentReady = true, sendMessage, compiled, event = 'me-page-start-fixture', run = 'function(runtime){globalThis.rpc=runtime;}' } = {}) {
  const nodes = [], messages = [], connections = [], payloads = [], packets = [], errors = [], lifecycle = new Map();
  let mutation;
  class Element extends EventTarget {
    constructor() { super(); this.localName = 'script'; this._text = ''; }
    get textContent() { return this._text; }
    set textContent(value) { if (textError) throw new Error('Owned Trusted Types refusal'); this._text = value; }
    remove() { this.attached = false; }
    replaceChildren() { this._text = ''; }
    removeAttribute(name) { delete this[name]; }
    // Site code can read every bridge packet in both directions. The host adds
    // its listener and sends replies through these methods; the page client
    // uses the captured base methods, so its packets reach the extra listener.
    addEventListener(type, listener) { super.addEventListener(type, item => packets.push(item.detail)); super.addEventListener(type, listener); }
    dispatchEvent(item) { packets.push(item.detail); return super.dispatchEvent(item); }
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
  const globals = { document, EventTarget, CustomEvent, setTimeout, clearTimeout, queueMicrotask, URL, TextEncoder, TextDecoder,
    console: { error: (...args) => errors.push(args) }, location: { href: 'https://example.test/page' },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    addEventListener(name, callback) { if (!lifecycle.has(name)) lifecycle.set(name, new Set()); lifecycle.get(name).add(callback); },
    removeEventListener(name, callback) { lifecycle.get(name)?.delete(callback); } };
  const shared = vm.createContext({ ...globals }), isolated = vm.createContext({ ...globals, crypto, chrome: { runtime } });
  // Stands in for the MAIN bootstrap, which listens for exactly this name.
  document.addEventListener(event, start => {
    const node = document.getElementById(start.detail); payloads.push(node.textContent);
    if (launch) { try { vm.runInContext(node.textContent, shared); } catch (error) { errors.push(error); } }
  });
  const options = { id, token, mode, event, sourceName: 'blockads-userscript-fixture.0000000000000000.user.js' };
  vm.runInContext(compiled || '(' + page.host + ')(' + JSON.stringify(options) + ',' + run + ',' + JSON.stringify(page.client.toString()) + ',function(){globalThis.fallbacks=(globalThis.fallbacks||0)+1;});', isolated);
  // Native lifecycle delivery is explicit; DOM bridge events above remain real
  // EventTarget events. Synthetic lifecycle probes set isTrusted to false.
  const fire = (name, persisted = false, isTrusted = true) => { for (const callback of [...lifecycle.get(name) || []]) callback({ persisted, isTrusted }); };
  return { shared, isolated, nodes, messages, connections, payloads, packets, errors, fire,
    mount: () => { document.head = parent; mutation?.(); }, mutate: () => mutation?.(), close: () => fire('pagehide') };
}
test('compiled page GM code never exports native capability bytes into the page or DOM', async () => {
  const source = '// ==UserScript==\n// @name Owned\n// @match https://example.test/*\n// @inject-into page\n// @grant GM.getValue\n// ==/UserScript==\nglobalThis.readOwned=()=>GM.getValue("key");';
  const records = core.registrations({ id, token, source });
  assert.deepEqual(records.map(record => record.world), ['MAIN', 'USER_SCRIPT']);
  assert.ok(!records[0].js[0].code.includes(token));
  const h = transport({ compiled: records[1].js[0].code, event: startEvent(records) });
  try {
    assert.equal(await h.shared.readOwned(), 'owned');
    assert.equal(h.messages[0].token, token); assert.equal(h.messages[0].id, id);
    assert.ok(h.payloads[0].includes('readOwned')); assert.ok(!h.payloads[0].includes(token));
    assert.ok(h.nodes.every(node => !node.attached && !node.id && node.textContent === ''));
    assert.equal(h.isolated.readOwned, undefined);
  } finally { h.close(); }
});
test('source names never carry the install ID, in any world or the page bridge payload', async () => {
  const otherId = 'abcdef01-2345-4678-9abc-def012345678';
  const text = (metadata, body = 'void 0;', name = 'Owned stack', namespace = 'owned.test') => '// ==UserScript==\n// @name ' + name + '\n// @namespace ' + namespace +
    '\n// @match https://example.test/*\n' + metadata + '// ==/UserScript==\n' + body;
  const names = (record, autoPageApproved) => core.registrations({ id: record.id || id, token, source: record.source, autoPageApproved })
    .flatMap(item => item.js.map(js => js.code)).flatMap(code => [...code.matchAll(/^\/\/# sourceURL=(.*)$/gm)].map(match => match[1]));
  const variants = { content: '// @grant GM_info\n', native: '// @inject-into page\n// @grant none\n', bridge: '// @inject-into page\n// @grant GM.getValue\n',
    auto: '// @inject-into auto\n// @grant GM_info\n', rawPage: '// @unwrap\n// @inject-into page\n// @exclude *private*\n', rawContent: '// @unwrap\n' };
  const expected = names({ source: text(variants.content) })[0];
  assert.match(expected, /^blockads-userscript-Owned-stack\.[0-9a-f]{16}\.user\.js$/);
  for (const [kind, metadata] of Object.entries(variants)) for (const approved of [false, true]) {
    const found = names({ source: text(metadata) }, approved);
    assert.equal(found.length, 1, kind + ': one named runner; bootstraps and guards carry no sourceURL');
    assert.equal(found[0], expected, kind + ': every world uses the same identity-derived name');
    assert.ok(!found[0].includes('12345678') && !found[0].includes(id), kind);
    assert.deepEqual(names({ id: otherId, source: text(metadata) }, approved), found, kind + ': the name does not depend on the installation');
  }
  assert.deepEqual(names({ source: text(variants.native, 'void "edited";') }), [expected], 'edits keep the name, so DevTools breakpoints still apply');
  assert.notDeepEqual(names({ source: text(variants.native, '', 'Owned stack', 'other.test') }), [expected], 'scripts sharing a @name stay distinguishable');
  for (const [name, slug] of [['Quote " and \' */ <b>&amp;', 'Quote-and-b-amp'], ['Ünïcode 名前 ✓ é', 'Ünïcode-名前-é'], ['!!!', 'script'], ['x'.repeat(160), 'x'.repeat(64)]]) {
    const [found] = names({ source: text(variants.native, '', name) });
    assert.equal(found.slice(0, -'.0123456789abcdef.user.js'.length), 'blockads-userscript-' + slug, name);
    assert.match(found, /^blockads-userscript-[\p{L}\p{M}\p{N}_-]+\.[0-9a-f]{16}\.user\.js$/u, 'one whitespace- and quote-free token: ' + name);
  }
  // The bridge's inline page script names itself the same way.
  const records = core.registrations({ id, token, source: text(variants.bridge, 'globalThis.ownedReady=true;') });
  const h = transport({ compiled: records[1].js[0].code, event: startEvent(records) });
  try {
    assert.equal(h.shared.ownedReady, true);
    assert.equal(h.payloads[0].split('\n').at(-1), '//# sourceURL=' + expected);
  } finally { h.close(); }
});
test('page-world code and bridge packets never carry the install ID or capability', async () => {
  // Site code can read the inline script text (document.currentScript) while it
  // runs, and every packet after replacing JSON or CustomEvent beforehand.
  const source = injection => '// ==UserScript==\n// @name Owned identity\n// @namespace owned.test\n// @match https://example.test/*\n// @inject-into ' + injection +
    '\n// @grant GM_info\n// @grant GM.getValue\n// @grant GM.setValue\n// @grant GM_registerMenuCommand\n// ==/UserScript==\n' +
    'GM_registerMenuCommand("Owned", () => {});\nglobalThis.ownedInfo = GM_info;\nglobalThis.ownedWrite = () => GM.setValue("key", 1).then(() => GM.getValue("key"));';
  const native = core.registrations({ id, token, source: source('page').replace(/\/\/ @grant [^\n]+\n/g, '') + '\n// @grant none' });
  assert.deepEqual(native.map(record => record.world), ['MAIN']);
  assert.ok(!native[0].js[0].code.includes(id), 'a native page script holds no install ID');
  // Page-world GM_info.uuid is a UUID-shaped hash of @name and @namespace.
  const uuidOf = code => /"uuid":"([^"]+)"/.exec(code)[1], pageUuid = uuidOf(native[0].js[0].code);
  assert.match(pageUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'an RFC 9562 version 8 UUID');
  assert.equal(uuidOf(core.registrations({ id: 'abcdef01-2345-4678-9abc-def012345678', token, source: source('page') })[1].js[0].code), pageUuid, 'every installation shares it');
  assert.notEqual(uuidOf(core.registrations({ id, token, source: source('page').replace('owned.test', 'other.test') })[1].js[0].code), pageUuid, 'scripts differ by identity');
  // Site code cannot read content worlds, so they and the auto fallback keep the install ID.
  assert.equal(uuidOf(core.registrations({ id, token, source: source('content') })[0].js[0].code), id);
  assert.deepEqual([...core.registrations({ id, token, source: source('auto'), autoPageApproved: true })[1].js[0].code.matchAll(/"uuid":"([^"]+)","injectInto":"(\w+)"/g)]
    .map(match => match.slice(1)), [[pageUuid, 'page'], [id, 'content']]);
  for (const injection of ['page', 'auto']) {
    const records = core.registrations({ id, token, source: source(injection), autoPageApproved: true });
    assert.deepEqual(records.map(record => record.world), ['MAIN', 'USER_SCRIPT'], injection);
    assert.ok(!records[0].js[0].code.includes(id) && !records[0].js[0].code.includes(token), injection + ': the MAIN bootstrap names no install');
    const h = transport({ compiled: records[1].js[0].code, event: startEvent(records),
      sendMessage: message => message.operation === 'menus' ? { ok: false, error: 'Owned menu refusal' } : { ok: true, exists: true, value: 1, revision: 2 } });
    try {
      assert.equal(await h.shared.ownedWrite(), 1);
      assert.equal(h.shared.ownedInfo.injectInto, 'page'); assert.equal(h.shared.ownedInfo.uuid, pageUuid, injection);
      await tick();
      // Ready lets the menu publish; its refusal also sends a diagnostic.
      h.connections[0].onMessage.fire({ type: 'ready', connectionId: 'owned-connection', revision: 1 });
      await tick(); await tick();
      assert.deepEqual([...new Set(h.messages.map(message => message.operation))].sort(), ['diagnostic', 'get', 'menus', 'set'], injection);
      assert.ok(h.messages.every(message => message.id === id && message.token === token), injection + ': the isolated host adds the identity');
      assert.equal(h.connections[0].name, 'US_CHANNEL:' + id + ':' + token);
      assert.ok(h.payloads[0].includes('ownedWrite'), injection + ': the captured page text is the script');
      assert.ok(['"operation":"set"', '"operation":"menus"', '"operation":"diagnostic"', '"kind":"connect"', '"kind":"reply"', '"kind":"event"']
        .every(part => h.packets.some(packet => packet.includes(part))), injection + ': packets in both directions were captured');
      for (const text of [...h.payloads, ...h.packets]) {
        assert.ok(!text.includes(id), injection + ': page-visible text names the install: ' + text.slice(0, 200));
        assert.ok(!text.includes(token), injection + ': page-visible text holds the capability');
      }
    } finally { h.close(); }
  }
});
test('page bridge fixes identity, capability, native router and connection name', async () => {
  const h = transport();
  try {
    // A page packet that names any script, even this one, is refused.
    for (const message of [
      { type: 'US_ENABLE' }, { type: 'US_VALUE', id: 'other', operation: 'get' }, { type: 'US_VALUE', id, operation: 'get' },
      { type: 'US_VALUE', token, operation: 'get' }, { type: 'US_VALUE', operation: 'connect' }
    ]) assert.equal((await h.shared.rpc.sendMessage(message)).ok, false);
    assert.equal(h.messages.length, 0);
    assert.equal((await h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get', key: 'x' })).ok, true);
    assert.equal(h.messages[0].id, id); assert.equal(h.messages[0].token, token);
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
  const calls = Array.from({ length: 8 }, () => h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' }));
  const settled = Promise.allSettled(calls);
  await assert.rejects(h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' }), /Too many pending/);
  await tick(); assert.equal(h.messages.length, 8);
  h.close();
  assert.ok((await settled).every(result => result.status === 'rejected' && /may still complete/.test(result.reason.message)));
  for (const finish of finishes) finish({ ok: true }); await tick();
  assert.equal(h.messages.length, 8);
  await assert.rejects(h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' }), /closed/);
});
test('pagehide suspends native ports and pageshow allows a fresh connection without re-execution', async () => {
  const h = transport();
  try {
    let disconnected = 0;
    const first = h.shared.rpc.connect(); first.onDisconnect.addListener(() => disconnected++); await tick();
    h.fire('pagehide', true); assert.equal(disconnected, 1); assert.equal(h.connections[0].ended, true);
    await assert.rejects(h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' }), /suspended/);
    h.fire('pageshow', true); h.shared.rpc.connect(); await tick();
    assert.equal(h.connections.length, 2); assert.equal(h.payloads.length, 1);
    assert.equal((await h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' })).ok, true);
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
    assert.equal((await h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' })).ok, true);
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
    const call = h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'set', key: 'queued', value: 1 });
    const result = Promise.allSettled([call]);
    h.fire('pagehide', true); h.fire('pageshow', true); await tick();
    assert.equal((await result)[0].value.ok, false, 'the GM adapter receives an explicit pre-submission failure');
    assert.equal(h.messages.length, 0);
  } finally { h.close(); }
});

test('suspension rejects in-flight page calls, suppresses late replies and does not replay them on restore', async () => {
  let finish; const h = transport({ sendMessage: () => new Promise(resolve => { finish = resolve; }) });
  try {
    const result = Promise.allSettled([h.shared.rpc.sendMessage({ type: 'US_VALUE', operation: 'get' })]);
    await tick(); h.fire('pagehide', true); h.fire('pageshow', true);
    finish({ ok: true, value: 'stale' }); await tick();
    assert.equal((await result)[0].status, 'rejected'); assert.equal(h.messages.length, 1); assert.equal(h.payloads.length, 1);
  } finally { h.close(); }
});

for (const message of [{ operation: 'set', key: 'x', value: 1 }, { operation: 'cookie', method: 'set', details: { name: 'owned', value: 'fixture' } }]) {
  test('suspended ' + message.operation + ' preserves submitted completion without returning stale data', async () => {
    let finish; const h = transport({ sendMessage: () => new Promise(resolve => { finish = resolve; }) });
    try {
      const result = h.shared.rpc.sendMessage({ type: 'US_VALUE', ...message });
      await tick(); h.fire('pagehide', true); h.fire('pageshow', true);
      finish({ ok: true, values: { secret: 'old snapshot' }, cookies: [{ value: 'old data' }] });
      assert.deepEqual(JSON.parse(JSON.stringify(await result)), { ok: true });
      assert.equal(h.messages.length, 1);
    } finally { h.close(); }
  });
}
