const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js'); require('../src/userscripts/userscripts-page.js'); require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-network.js'); require('../src/userscripts/userscripts-updates.js'); require('../src/userscripts/userscripts-offscreen.js'); require('../src/userscripts/userscripts-xhr.js'); require('../src/userscripts/clipboard.js'); require('../src/userscripts/userscripts-actions.js'); require('../src/userscripts/userscripts-runtime.js'); require('../src/background/modules.js');
const core = globalThis.BlockAdsUserScriptCore;
const clone = value => structuredClone(value);
// The browser runs each registered js entry as its own script, in order. Out of
// scope, the scope guard makes the script's top-level `let` fail before it runs.
const inject = (registration, context, options) => {
  for (const { code } of registration.js) {
    try { vm.runInContext(code, context, options); }
    catch (error) { if (!(error?.name === 'SyntaxError' && /__moduleEngineScope_/.test(error.message))) throw error; }
  }
};
const sortedKeys = value => Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortedKeys(value[key])])) : value;
const source = (name = 'Example', metadata = '', body = 'document.body.dataset.script = "ran";') =>
  '// ==UserScript==\n// @name ' + name + '\n// @namespace tests\n// @match https://example.test/*\n' + metadata + '// ==/UserScript==\n' + body;
function harness(initial, options = {}) {
  const state = { data: initial ? clone(initial) : {}, scripts: [], worlds: [], faults: {}, granted: options.granted ?? true, apiOn: true, hooks: {}, writes: 0 };
  state.tabs = new Map([[7, { id: 7, windowId: 2, index: 3 }], [8, { id: 8, windowId: 2, index: 4 }]]);
  state.frames = new Map();
  state.createdTabs = []; state.removedTabs = []; state.nextTab = 100;
  state.helperPermissions = new Set(options.helperPermissions ?? ['clipboardWrite', 'offscreen', 'notifications', 'downloads']);
  state.copies = []; state.notifications = new Map(); state.downloads = new Map(); state.nextDownload = 1; state.downloadCancels = [];
  state.cookieCalls = []; state.cookieJar = []; state.cookieStores = [{ id: 'owned', tabIds: [7, 8] }, { id: 'other', tabIds: [99] }];
  const fault = name => { if (state.faults[name]) { state.faults[name]--; throw new Error('Injected ' + name + ' failure'); } };
  const event = key => ({ addListener: callback => { const previous = state.hooks[key]; state.hooks[key] = (...args) => { previous?.(...args); callback(...args); }; } });
  const api = {
    cookies: Object.fromEntries(['getAllCookieStores', 'getAll', 'set', 'remove'].map(method => [method, async details => {
      state.cookieCalls.push({ method, details: clone(details) }); fault('cookie');
      if (options.cookieCall) await options.cookieCall(method, details);
      if (method === 'getAllCookieStores') return clone(state.cookieStores);
      if (method === 'getAll') return clone(state.cookieJar);
      if (method === 'set') { const cookie = { ...details, domain: new URL(details.url).hostname }; state.cookieJar.push(cookie); return clone(cookie); }
      state.cookieJar = state.cookieJar.filter(cookie => cookie.name !== details.name); return clone(details);
    }])),
    scripting: { async executeScript({ target, world, func, injectImmediately }) {
      fault('frameProbe'); assert.equal(world, 'ISOLATED');
      assert.equal(injectImmediately, true);
      if (options.frameProbe) return options.frameProbe(target);
      return target.frameIds.map(frameId => ({ frameId, ...state.frames.get(target.tabId + ':' + frameId),
        result: vm.runInNewContext('(' + func.toString() + ')()', { location: { href: state.frames.get(target.tabId + ':' + frameId)?.url || 'https://example.test/page' } }) }));
    } },
    runtime: { id: 'test', onUserScriptMessage: event('message'), onUserScriptConnect: event('connect'),
      ...(options.firefox ? { getBrowserInfo: async () => ({ name: 'Firefox' }) } : {}),
      getURL: value => 'chrome-extension://test/' + value, async getContexts() { return state.offscreen ? [{}] : []; },
      async sendMessage(message) { fault('clipboard'); if (options.clipboard) await options.clipboard(); state.copies.push(clone(message.details)); return { ok: true }; } },
    offscreen: { async createDocument() { fault('offscreen'); state.offscreen = true; }, async closeDocument() { state.offscreen = false; } },
    notifications: { onClicked: event('notificationClicked'), onClosed: event('notificationClosed'),
      async getAll() { return Object.fromEntries(state.notifications); },
      async create(id, data) { fault('notification'); if (options.notificationCreate) await options.notificationCreate(); state.notifications.set(id, clone(data)); return id; },
      async clear(id) { const exists = state.notifications.delete(id); if (exists) state.hooks.notificationClosed?.(id, false); return exists; } },
    downloads: { onChanged: event('downloadChanged'),
      async download(data) { fault('download'); if (options.downloadCreate) await options.downloadCreate(); const id = state.nextDownload++; state.downloads.set(id, { id, ...clone(data), state: 'in_progress' }); return id; },
      async search({ id }) { fault('downloadSearch'); return state.downloads.has(id) ? [clone(state.downloads.get(id))] : []; },
      async cancel(id) { state.downloadCancels.push(id); const item = state.downloads.get(id); if (item) { item.state = 'interrupted'; state.hooks.downloadChanged?.({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } }); } } },
    tabs: { onRemoved: event('tabRemoved'), onUpdated: event('tabUpdated'),
      async query(filter = {}) { fault('tabQuery'); return [...state.tabs.values()].filter(tab => filter.windowId === undefined || tab.windowId === filter.windowId).map(clone); },
      async get(id) { fault('tabGet'); if (options.tabGet) await options.tabGet(id); if (!state.tabs.has(id)) throw new Error('No tab'); return clone(state.tabs.get(id)); },
      async create(properties) { fault('tabCreate'); if (options.tabCreate) await options.tabCreate(); const tab = { id: state.nextTab++, ...clone(properties) };
        state.tabs.set(tab.id, tab); state.createdTabs.push(tab); return clone(tab); },
      async remove(id) { fault('tabRemove'); if (!state.tabs.delete(id)) throw new Error('No tab'); state.removedTabs.push(id); state.hooks.tabRemoved?.(id); }
    },
    permissions: { contains: async ({ permissions }) => permissions.every(permission => permission === 'userScripts' ? state.granted : state.helperPermissions.has(permission)), onAdded: event('added'), onRemoved: event('removed') },
    storage: { local: {
      // Chromium returns object keys sorted, including nested values.
      async get() { fault('read'); return options.insertionOrderStorage ? clone(state.data) : sortedKeys(clone(state.data)); },
      async set(patch) { fault('save'); Object.assign(state.data, clone(patch)); state.writes++; fault('afterSave'); }
    } },
    userScripts: {
      async getScripts() { fault('getScripts'); if (!state.apiOn) throw new Error(options.unavailableError || 'The userScripts API is not available.'); return clone(state.scripts); },
      async getWorldConfigurations() { return clone(state.worlds); },
      async configureWorld(world) { fault('world'); state.worlds = [...state.worlds.filter(item => item.worldId !== world.worldId), clone(world)]; },
      async resetWorldConfiguration(id) { fault('reset'); state.worlds = state.worlds.filter(world => world.worldId !== id); },
      async unregister({ ids }) { fault('unregister'); state.scripts = state.scripts.filter(script => !ids.includes(script.id)); },
      async register(scripts) {
        fault('register');
        for (const script of scripts) {
          assert.ok(!state.scripts.some(item => item.id === script.id), 'no duplicate native IDs');
          for (const entry of script.js) new vm.Script(entry.code); // The mock never executes untrusted code.
          state.scripts.push(clone(script));
        }
        fault('afterRegister');
        if (state.faults.ignoredRegister) { state.faults.ignoredRegister--; state.scripts.pop(); }
      }
    }
  };
  const host = BlockAdsUserScripts.create(api, { log: options.log }), ready = host.start();
  const command = async message => { await ready; return host.request(message); };
  const save = async (name, metadata = '', body) => {
    const response = await command({ type: 'US_SAVE', source: source(name, metadata, body) });
    return response.scripts.find(script => script.id === response.selectedId);
  };
  const enable = async script => {
    await host.setEnabled(true);
    const response = await command({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true });
    return response.scripts.find(item => item.id === script.id);
  };
  const sender = () => ({ id: 'test', tab: { id: 7 }, frameId: 0, url: 'https://example.test/page' });
  const value = (id, operation, args = {}, from = sender()) => new Promise(resolve => {
    const script = state.data.userscriptManager?.scripts.find(item => item.id === id);
    state.hooks.message({ type: 'US_VALUE', id, token: script?.token, operation, ...args }, from, resolve);
  });
  function realm(id, tabId = 7, extra = {}) {
    const from = { ...sender(), tab: { id: tabId }, documentId: crypto.randomUUID(), ...extra.sender };
    state.frames.set(from.tab.id + ':' + from.frameId, { url: from.url });
    const events = new Map(), errors = [], ports = [], messages = [];
    const listeners = () => {
      const callbacks = new Set();
      return { addListener: callback => callbacks.add(callback), fire: value => { for (const callback of callbacks) callback(value); } };
    };
    const runtime = {
      sendMessage: message => new Promise(resolve => state.hooks.message(clone(message), from, response => resolve(extra.reply ? extra.reply(clone(response), message) : clone(response)))),
      connect({ name }) {
        const incoming = listeners(), disconnected = listeners(), nativeDisconnected = listeners(); let closed = false;
        const disconnect = side => { if (!closed) { closed = true;
          if (side !== 'native') nativeDisconnected.fire();
          if (side !== 'client') queueMicrotask(() => disconnected.fire());
        } };
        const native = { name, sender: from, onDisconnect: nativeDisconnected,
          postMessage: message => { if (closed) throw new Error('Disconnected'); const payload = clone(message); messages.push(payload); queueMicrotask(() => incoming.fire(payload)); }, disconnect: () => disconnect('native') };
        const client = { onMessage: incoming, onDisconnect: disconnected, disconnect: () => disconnect('client'), loseConnection: () => disconnect('transport') };
        ports.push(client); queueMicrotask(() => state.hooks.connect(native)); return client;
      }
    };
    const context = vm.createContext({ URL, URLSearchParams, TextEncoder, TextDecoder, Blob, FormData, atob, btoa, setTimeout, clearTimeout, queueMicrotask,
      console: { error: (...args) => errors.push(args.map(String).join(' ')) }, chrome: { runtime }, location: { href: from.url },
      addEventListener: (name, callback) => { const list = events.get(name) || []; list.push(callback); events.set(name, list); },
      removeEventListener: (name, callback) => { const list = events.get(name) || []; if (list.includes(callback)) list.splice(list.indexOf(callback), 1); },
      MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
      document: { body: {}, documentElement: {} }, ...extra.globals });
    const record = state.data.userscriptManager.scripts.find(item => item.id === id);
    inject(core.registration(record), context);
    return { context, run: code => vm.runInContext(code, context), errors, ports, messages, from,
      event: (name, event = {}) => { for (const callback of events.get(name) || []) callback({ isTrusted: true, ...event }); } };
  }
  return { state, api, host, ready, command, save, enable, sender, value, realm };
}
const eventually = async predicate => {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Condition did not become true.');
};
const json = value => JSON.parse(JSON.stringify(value));
test('debug inspection detects drift without repairing registrations or writing storage', async () => {
  const h = harness(), s = await h.enable(await h.save('Inspect', '// @grant GM.getValue\n'));
  h.state.scripts = []; const writes = h.state.writes, stored = clone(h.state.data);
  const result = await h.host.inspect(); assert.equal(result.active, false); assert.match(result.error, /differ/);
  assert.equal(result.scripts[0].id, s.id); assert.deepEqual(h.state.scripts, []); assert.equal(h.state.writes, writes); assert.deepEqual(h.state.data, stored);
});
test('enabling direction controls requires explicit acknowledgment of the current saved revision', async () => {
  const h = harness(), script = await h.save('Bidi', '', '// \u202e inert comment');
  const before = JSON.stringify(h.state.data), writes = h.state.writes;
  const enable = { type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true };
  await assert.rejects(h.command(enable), /direction controls.*acknowledge/i);
  await assert.rejects(h.command({ ...enable, acknowledgeBidi: 'true' }), /direction controls.*acknowledge/i);
  assert.equal(JSON.stringify(h.state.data), before); assert.equal(h.state.writes, writes);
  const on = (await h.command({ ...enable, acknowledgeBidi: true })).scripts.find(item => item.id === script.id);
  assert.equal(on.enabled, true); assert.equal(on.source, script.source);
  const off = (await h.command({ ...enable, revision: on.revision, enabled: false })).scripts.find(item => item.id === script.id);
  const edit = await h.command({ type: 'US_SAVE', id: script.id, revision: off.revision, source: script.source + '\n// changed' });
  const updated = edit.scripts.find(item => item.id === script.id);
  await assert.rejects(h.command({ ...enable, acknowledgeBidi: true }), /changed/);
  await assert.rejects(h.command({ ...enable, revision: updated.revision }), /direction controls.*acknowledge/i);
});

test('diagnostics require active capture, current capability, matching native world and messaging grants', async () => {
  const h = harness(), s = await h.enable(await h.save('Debug', '// @grant GM.getValue\n'));
  const payload = { message: 'owned error', stack: 'owned stack' }, entries = [];
  assert.equal((await h.value(s.id, 'diagnostic', payload)).ok, false);
  h.host.setDiagnosticSink(entry => entries.push(entry));
  assert.equal((await h.value(s.id, 'diagnostic', { ...payload, token: '0'.repeat(64) })).ok, false);
  assert.equal((await h.value(s.id, 'diagnostic', payload, { ...h.sender(), userScriptWorldId: 'other' })).ok, false);
  assert.equal((await h.value(s.id, 'diagnostic', payload)).ok, true); assert.equal(entries[0].scriptId, s.id);
  assert.equal((await h.value(s.id, 'diagnostic', { ...payload, message: 'x'.repeat(2049) })).ok, false);
  h.host.setDiagnosticSink(null); assert.equal((await h.value(s.id, 'diagnostic', payload)).ok, false); assert.equal(entries.length, 1);
  const noGrant = await h.enable(await h.save('No messaging', '// @grant none\n')); h.host.setDiagnosticSink(entry => entries.push(entry));
  assert.equal((await h.value(noGrant.id, 'diagnostic', payload)).ok, false);
});
test('diagnostic flood stays bounded and does not prevent disabling scripts', async () => {
  const h = harness(), s = await h.enable(await h.save('Debug flood', '// @grant GM.getValue\n')), entries = [];
  h.host.setDiagnosticSink(entry => entries.push(entry));
  const pending = Array.from({ length: 32 }, () => h.value(s.id, 'diagnostic', { message: 'error', stack: '' }));
  const disabled = await h.host.setEnabled(false); assert.equal(disabled.enabled, false);
  const results = await Promise.all(pending); assert.ok(results.some(r => /limit/.test(r.error))); assert.ok(entries.length <= 8);
});
test('synchronous script errors preserve their native throw and publish diagnostics only to active capture', async () => {
  const h = harness(), s = await h.enable(await h.save('Throwing', '// @grant GM.getValue\n', 'throw new Error("owned runtime error");')), entries = [];
  h.host.setDiagnosticSink(entry => entries.push(entry));
  assert.throws(() => h.realm(s.id), /owned runtime error/);
  await eventually(() => entries.length === 1); assert.equal(entries[0].message, 'owned runtime error'); assert.match(entries[0].stack, /owned runtime error/);
});
test('a diagnostic awaiting native frame verification cannot leak into a later approval', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let probing = false;
  const h = harness(undefined, { frameProbe: async () => { probing = true; await gate; return [{ frameId: 0, result: 'https://example.test/page' }]; } });
  const s = await h.enable(await h.save('Queued diagnostic', '// @grant GM.getValue\n')), old = [], next = [];
  h.host.setDiagnosticSink(entry => old.push(entry));
  const pending = h.value(s.id, 'diagnostic', { message: 'previous approval', stack: '' }); await eventually(() => probing);
  h.host.setDiagnosticSink(null); h.host.setDiagnosticSink(entry => next.push(entry)); release();
  assert.equal((await pending).ok, false); assert.equal(old.length, 0); assert.equal(next.length, 0);
  assert.equal((await h.value(s.id, 'diagnostic', { message: 'current approval', stack: '' })).ok, true); assert.equal(next.length, 1);
});
const cookieGrants = '// @grant GM_cookie\n// @grant GM.cookie\n';
async function cookieRealm(options = {}, metadata = '') {
  const h = harness(undefined, options), script = await h.enable(await h.save('Cookies', cookieGrants + metadata, 'globalThis.cookie={legacy:GM_cookie,modern:GM.cookie};'));
  const r = h.realm(script.id); await eventually(() => r.context.cookie);
  return { h, script, r };
}
test('GM cookies require optional permission, preserve callback shapes and bind the native store', async () => {
  const { h, r } = await cookieRealm();
  await assert.rejects(r.run('cookie.modern.list({})'), /Allow cookie access/); assert.equal(h.state.cookieCalls.length, 0);
  h.state.helperPermissions.add('cookies');
  assert.equal(await r.run('cookie.modern.set({name:"owned",value:"value",httpOnly:true})'), undefined);
  const result = await r.run('new Promise(resolve=>{globalThis.callbackReturn=cookie.legacy.list({},(...args)=>resolve(args));})');
  assert.equal(r.context.callbackReturn, undefined); assert.equal(result[0][0].httpOnly, true); assert.equal(result[1], undefined);
  assert.equal(h.state.cookieCalls.find(call => call.method === 'set').details.storeId, 'owned');
  const deleted = await r.run('new Promise(resolve=>cookie.legacy.delete({name:"owned"},(...args)=>resolve(args)))');
  assert.deepEqual(json(deleted), [null]); assert.equal(h.state.cookieJar.length, 0);
  h.state.faults.cookie = 1;
  const failure = await r.run('new Promise(resolve=>cookie.modern.list({},(...args)=>resolve(args)))');
  assert.equal(failure[0], undefined); assert.match(failure[1], /Injected cookie/);
});
test('cookie authorization rejects foreign stores, undeclared destinations, parent scope and partition options', async () => {
  const { h, r } = await cookieRealm({ helperPermissions: ['cookies'] });
  for (const code of [
    'cookie.modern.list({url:"https://unrelated.test/"})', 'cookie.modern.list({storeId:"other"})',
    'cookie.modern.list({partitionKey:{topLevelSite:"https://other.test"}})', 'cookie.modern.list({partitionKey:{}})',
    'cookie.modern.list({partitionKey:{topLevelSite:"http://example.test"}})', 'cookie.modern.list({partitionKey:{topLevelSite:"https://example.test",extra:1}})',
    'cookie.modern.list({partitionKey:{topLevelSite:"https://example.test",hasCrossSiteAncestor:1}})',
    'cookie.modern.list({firstPartyDomain:"example.test"})',
    'cookie.modern.set({url:"javascript:alert(1)",name:"bad"})', 'cookie.modern.delete({})',
    'cookie.modern.set({domain:"test",name:"bad"})', 'cookie.modern.set({name:"bad",httpOnly:1})',
    'cookie.modern.set({url:"https://user:pass@example.test/",name:"bad"})'
  ]) await assert.rejects(r.run(code));
  assert.ok(h.state.cookieCalls.every(call => call.method === 'getAllCookieStores'));
  const other = await cookieRealm({ helperPermissions: ['cookies'] }, '// @connect other.test\n');
  await other.r.run('cookie.modern.set({url:"https://child.other.test/",domain:"other.test",name:"explicit",value:"local fixture"})');
  assert.equal(other.h.state.cookieCalls.at(-1).details.url, 'https://child.other.test/');
  assert.equal(other.h.state.cookieCalls.at(-1).details.storeId, 'owned');
});
test('partitioned cookies are addressable only within the calling tab’s own top-level site', async () => {
  const { h, r } = await cookieRealm({ helperPermissions: ['cookies'] });
  h.state.cookieJar = [{ name: 'plain' }, { name: 'own', partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false } },
    { name: 'foreign', partitionKey: { topLevelSite: 'https://other.test' } }];
  assert.deepEqual(json(await r.run('cookie.modern.list({})')).map(cookie => cookie.name), ['plain'], 'no partition unless requested');
  assert.deepEqual(json(await r.run('cookie.modern.list({partitionKey:{topLevelSite:"https://example.test"}})')).map(cookie => cookie.name), ['plain', 'own']);
  assert.deepEqual(h.state.cookieCalls.at(-1).details.partitionKey, { topLevelSite: 'https://example.test' });
  await r.run('cookie.modern.set({name:"chip",value:"1",secure:true,partitionKey:{topLevelSite:"https://example.test",hasCrossSiteAncestor:false}})');
  assert.deepEqual(h.state.cookieCalls.at(-1).details.partitionKey, { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false });
  const { cookieOptions } = BlockAdsUserScriptActions, meta = core.parse(source('Partition', '// @grant GM_cookie\n'));
  // A subframe uses its tab's top-level site, including registrable-domain folding.
  assert.equal(cookieOptions('list', { partitionKey: { topLevelSite: 'https://example.co.uk' } }, meta, 'https://example.test/frame',
    { topURL: 'https://www.shop.example.co.uk/page' }).partitionKey.topLevelSite, 'https://example.co.uk');
  assert.throws(() => cookieOptions('list', { partitionKey: { topLevelSite: 'https://example.test' } }, meta, 'https://example.test/frame', { topURL: 'about:invalid' }), /top-level site/);
  assert.equal(cookieOptions('list', { partitionKey: { topLevelSite: 'http://127.0.0.1' } }, meta, 'http://127.0.0.1:8080/', {}).partitionKey.topLevelSite, 'http://127.0.0.1');
  assert.equal(cookieOptions('list', { partitionKey: { topLevelSite: 'https://example.test' } }, meta, 'https://a.b.example.test/', {}).partitionKey.topLevelSite, 'https://example.test',
    'unknown suffixes use the default rule');
  // Firefox first-party isolation: only unisolated ('') or this tab's domain.
  for (const firstPartyDomain of ['', 'example.test']) assert.equal(cookieOptions('list', { firstPartyDomain }, meta, 'https://www.example.test/', { firefox: true }).firstPartyDomain, firstPartyDomain);
  for (const firstPartyDomain of ['other.test', null, 1]) assert.throws(() => cookieOptions('list', { firstPartyDomain }, meta, 'https://www.example.test/', { firefox: true }), /firstPartyDomain/);
  assert.throws(() => cookieOptions('list', { firstPartyDomain: '' }, meta, 'https://www.example.test/', {}), /only in Firefox/);
});
test('cookie grants cannot be borrowed from another script or an unwrapped registration', async () => {
  const h = harness(undefined, { helperPermissions: ['cookies'] });
  for (const [name, metadata] of [['Ungrant', '// @grant GM.getValue\n'], ['Unwrapped', '// @unwrap\n// @grant GM_cookie\n']]) {
    const script = await h.enable(await h.save(name, metadata, 'globalThis.noCookies=typeof GM_cookie;'));
    const result = await h.value(script.id, 'cookie', { method: 'list', details: {} });
    assert.equal(result.ok, false); assert.match(result.error, /not allowed/);
  }
  assert.equal(h.state.cookieCalls.length, 0);
});
test('cookie list filters partitions, bounds output, and loses access after revocation or history scope changes', async () => {
  const { h, r, script } = await cookieRealm({ helperPermissions: ['cookies'] });
  h.state.cookieJar = [{ name: 'owned' }, { name: 'partition', partitionKey: { topLevelSite: 'https://other.test' } }, { name: 'firstParty', firstPartyDomain: 'other.test' }];
  assert.deepEqual(json(await r.run('cookie.modern.list({})')), [{ name: 'owned' }]);
  h.state.cookieJar = Array.from({ length: 257 }, () => ({ name: 'over-limit' }));
  await assert.rejects(r.run('cookie.modern.list({})'), /256/);
  h.state.helperPermissions.delete('cookies'); await assert.rejects(r.run('cookie.modern.list({})'), /Allow cookie/);
  h.state.helperPermissions.add('cookies'); h.state.cookieJar = [];
  h.state.frames.set('7:0', { url: 'https://outside.test/' });
  await assert.rejects(r.run('cookie.modern.list({})'), /scope/);
  h.state.frames.set('7:0', { url: 'https://example.test/page' });
  await h.command({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: false });
  await assert.rejects(r.run('cookie.modern.set({name:"revoked"})'), /inactive|expired/);
  assert.ok(!h.state.cookieJar.some(cookie => cookie.name === 'revoked'));
});
test('a timed-out native cookie lookup cannot perform a late write or stall shutdown indefinitely', async () => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async method => { if (method === 'getAllCookieStores') { entered = true; await gate; } } });
  const result = r.run('cookie.modern.set({name:"too-late"})');
  const rejection = assert.rejects(result, /timed out/);
  await eventually(() => entered);
  const disabled = h.host.setEnabled(false);
  await rejection; await disabled; release(); await new Promise(setImmediate);
  assert.equal(h.state.cookieJar.length, 0); assert.ok(h.state.cookieCalls.every(call => call.method === 'getAllCookieStores'));
});
test('in-flight cookie reads discard results after permission loss, scope exit or document suspension', async () => {
  for (const reason of ['permission', 'scope', 'pagehide']) {
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async method => {
      if (method === 'getAll') { entered = true; await gate; }
    } });
    h.state.cookieJar = [{ name: 'synthetic', value: 'must-not-return' }];
    const rejected = assert.rejects(r.run('cookie.modern.list({})'), /Allow cookie|scope|expired|inactive/);
    await eventually(() => entered);
    if (reason === 'permission') h.state.helperPermissions.delete('cookies');
    else if (reason === 'scope') h.state.frames.set('7:0', { url: 'https://outside.test/' });
    else r.event('pagehide');
    release(); await rejected; await h.host.setEnabled(false);
  }
});
test('submitted cookie writes preserve native success after access is revoked', async t => {
  for (const method of ['set', 'delete']) for (const reason of ['permission', 'scope', 'pagehide', 'navigation']) {
    await t.test(method + ' after ' + reason, async () => {
      let release, entered = false;
      const nativeMethod = method === 'delete' ? 'remove' : 'set', gate = new Promise(resolve => { release = resolve; });
      const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async operation => {
        if (operation === nativeMethod) { entered = true; await gate; }
      } });
      if (method === 'delete') h.state.cookieJar = [{ name: 'submitted', value: 'owned' }];
      const result = r.run(method === 'set'
        ? 'cookie.modern.set({name:"submitted",value:"owned"}).then(()=>({ok:true}),error=>({ok:false,error:error.message}))'
        : 'new Promise(resolve=>{globalThis.cookieCallbacks=0;cookie.legacy.delete({name:"submitted"},error=>{cookieCallbacks++;resolve({ok:!error,error});});})');
      try {
        await eventually(() => entered);
        if (reason === 'permission') h.state.helperPermissions.delete('cookies');
        else if (reason === 'pagehide') r.event('pagehide');
        else {
          h.state.frames.set('7:0', { url: 'https://outside.test/' });
          if (reason === 'navigation') h.state.hooks.tabUpdated(7, { url: 'https://outside.test/' });
        }
        release();
        assert.deepEqual(json(await result), { ok: true });
        assert.equal(h.state.cookieJar.some(cookie => cookie.name === 'submitted'), method === 'set');
        assert.equal(h.state.cookieCalls.filter(call => call.method === nativeMethod).length, 1);
        if (method === 'delete') assert.equal(r.context.cookieCallbacks, 1);
        await assert.rejects(r.run('cookie.modern.set({name:"after-revocation"})'), /Allow cookie|scope|expired|inactive/);
      } finally { release(); r.event('pagehide'); await h.host.setEnabled(false); }
    });
  }
});

test('submitted cookie writes preserve native failures after document suspension', async () => {
  for (const method of ['set', 'delete']) {
    let release, entered = false;
    const nativeMethod = method === 'delete' ? 'remove' : 'set', gate = new Promise(resolve => { release = resolve; });
    const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async operation => {
      if (operation === nativeMethod) { entered = true; await gate; throw new Error('Native cookie write refused'); }
    } });
    const rejected = assert.rejects(r.run('cookie.modern.' + method + '({name:"refused"})'), /Native cookie write refused/);
    await eventually(() => entered); r.event('pagehide'); release();
    await rejected; assert.equal(h.state.cookieJar.length, 0); await h.host.setEnabled(false);
  }
});

test('cookie revocation before write submission prevents the mutation', async () => {
  for (const reason of ['permission', 'scope', 'pagehide']) {
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async operation => {
      if (operation === 'getAllCookieStores') { entered = true; await gate; }
    } });
    const rejected = assert.rejects(r.run('cookie.modern.set({name:"never-submitted"})'), /Allow cookie|scope|expired|inactive/);
    await eventually(() => entered);
    if (reason === 'permission') h.state.helperPermissions.delete('cookies');
    else if (reason === 'scope') h.state.frames.set('7:0', { url: 'https://outside.test/' });
    else r.event('pagehide');
    release(); await rejected; await h.host.setEnabled(false);
    assert.equal(h.state.cookieJar.length, 0); assert.ok(h.state.cookieCalls.every(call => call.method === 'getAllCookieStores'));
  }
});

test('timed-out submitted cookie writes keep capacity until settlement and are never replayed', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async method => { if (method === 'set') await gate; } });
  try {
    await assert.rejects(r.run('cookie.modern.set({name:"first",value:"1"})'), /outcome is unknown/);
    const callbackError = await r.run('new Promise(resolve=>{globalThis.cookieCallbacks=0;cookie.legacy.set({name:"second",value:"2"},error=>{cookieCallbacks++;resolve(error);});})');
    assert.match(callbackError, /outcome is unknown/);
    await assert.rejects(r.run('cookie.modern.set({name:"over-limit"})'), /still pending/);
    assert.equal(h.state.cookieJar.length, 0);
    release(); await eventually(() => h.state.cookieJar.length === 2);
    assert.equal((await r.run('cookie.modern.list({})')).length, 2);
    assert.equal(h.state.cookieCalls.filter(call => call.method === 'set').length, 2);
    assert.equal(r.context.cookieCallbacks, 1);
  } finally { release(); await h.host.setEnabled(false); }
});

test('a revoked submitted cookie write still has a deadline and cannot stall shutdown', async () => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const { h, r } = await cookieRealm({ helperPermissions: ['cookies'], cookieCall: async method => {
    if (method === 'remove') { entered = true; await gate; }
  } });
  h.state.cookieJar = [{ name: 'submitted-delete', value: 'owned' }];
  const rejected = assert.rejects(r.run('cookie.modern.delete({name:"submitted-delete"})'), /outcome is unknown/);
  try {
    await eventually(() => entered); r.event('pagehide');
    const disabled = h.host.setEnabled(false);
    await rejected; await disabled;
    assert.equal(h.state.cookieJar.length, 1);
    release(); await eventually(() => h.state.cookieJar.length === 0);
    assert.equal(h.state.cookieCalls.filter(call => call.method === 'remove').length, 1);
  } finally { release(); await h.host.setEnabled(false); }
});

test('an asynchronous userscript cannot use GM cookies after disabling while it awaits', async () => {
  const h = harness(undefined, { helperPermissions: ['cookies'] });
  const script = await h.enable(await h.save('Await revoke', cookieGrants + '// @top-level-await\n',
    'await new Promise(resolve=>{globalThis.resume=resolve;});try{await GM.cookie.set({name:"late"});globalThis.result="wrong";}catch{globalThis.result="revoked";}'));
  const r = h.realm(script.id); await eventually(() => r.context.resume);
  await h.host.setEnabled(false); r.run('resume()'); await eventually(() => r.context.result);
  assert.equal(r.context.result, 'revoked'); assert.equal(h.state.cookieCalls.length, 0);
});
const compatibilityGrants = core.GRANTS.filter(grant => !['none', 'GM.info', 'GM_info', 'GM.addStyle', 'GM_addStyle'].includes(grant)).map(grant => '// @grant ' + grant + '\n').join('');
test('GM values persist when storage returns keys sorted, as Chromium does', async () => {
  const h = harness(); const script = await h.enable(await h.save('Sorted values', '// @grant GM.setValue\n// @grant GM.setValues\n// @grant GM.deleteValue\n// @grant GM.getValue\n'));
  // Each write is out of alphabetical order: a later key that sorts first, and nested keys.
  for (const [key, value] of [['saved', 1], ['counter', 2], ['user', { name: 'x', id: 1, prefs: { zoom: 2, alpha: true } }]]) {
    const response = await h.value(script.id, 'set', { key, value });
    assert.equal(response.ok, true, key + ': ' + response.error);
  }
  assert.equal((await h.value(script.id, 'setMany', { values: { zeta: 1, beta: [{ y: 1, x: 2 }] } })).ok, true);
  assert.equal((await h.value(script.id, 'delete', { key: 'beta' })).ok, true);
  assert.deepEqual(h.state.data.userscriptManager.scripts[0].values,
    { saved: 1, counter: 2, user: { name: 'x', id: 1, prefs: { zoom: 2, alpha: true } }, zeta: 1 });
  assert.deepEqual((await h.value(script.id, 'get', { key: 'user' })).value, { name: 'x', id: 1, prefs: { zoom: 2, alpha: true } });
});
test('tags normalize old libraries and keep local organization separate from author metadata', async () => {
  const h = harness(); let script = await h.enable(await h.save('Tagged', '// @tag reading\n// @tag reading\n// @grant GM.setValue\n'));
  assert.deepEqual(script.metadata.tags, ['reading']); assert.deepEqual(script.tags, []);
  await h.value(script.id, 'set', { key: 'retained', value: 42 });
  const token = h.state.data.userscriptManager.scripts[0].token;
  const updated = await h.command({ type: 'US_TAGS', id: script.id, revision: script.revision, tags: [' personal ', '<literal>'] });
  script = updated.scripts[0]; assert.deepEqual(script.tags, ['personal', '<literal>']); assert.equal(script.enabled, true);
  assert.equal(h.state.data.userscriptManager.scripts[0].token, token);
  assert.equal(h.state.data.userscriptManager.scripts[0].values.retained, 42);
  await assert.rejects(h.command({ type: 'US_TAGS', id: script.id, revision: script.revision - 1, tags: [] }), /changed/);
  await assert.rejects(h.command({ type: 'US_TAGS', id: script.id, revision: script.revision, tags: ['a,b'] }), /tags/);
  const saved = await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: script.source + '\n// update' });
  assert.deepEqual(saved.scripts[0].tags, script.tags);
});
test('ordering survives restart, toggles and rollback while keeping stable script worlds and values', async () => {
  const h = harness(); const scripts = [];
  for (const name of ['one', 'two', 'three']) scripts.push(await h.enable(await h.save(name, '// @grant GM.setValue\n')));
  await h.value(scripts[1].id, 'set', { key: 'kept', value: true });
  const before = clone(h.state.data), order = scripts.map(s => s.id);
  const move = () => h.command({ type: 'US_MOVE', id: scripts[1].id, revision: scripts[1].revision, direction: -1, order });
  h.state.faults.afterRegister = 1; await assert.rejects(move(), /not applied/);
  assert.deepEqual(h.state.data, before);
  const result = await move(), ids = result.scripts.map(s => s.id);
  assert.deepEqual(ids, [order[1], order[0], order[2]]);
  assert.deepEqual(h.state.scripts.map(s => s.worldId), ids.map(id => core.nativeId(id)));
  assert.deepEqual([...h.state.scripts].sort((a,b) => a.id.localeCompare(b.id)).map(s => s.worldId), ids.map(id => core.nativeId(id)));
  await assert.rejects(move(), /order changed/);
  const restart = harness(h.state.data); await restart.command({ type: 'US_LIST' });
  assert.deepEqual(restart.state.scripts.map(s => s.worldId), h.state.scripts.map(s => s.worldId));
  assert.equal(restart.state.data.userscriptManager.scripts[0].values.kept, true);
  const off = (await restart.command({type:'US_ENABLE',id:ids[1],revision:result.scripts[1].revision,enabled:false})).scripts[1];
  await restart.command({type:'US_ENABLE',id:off.id,revision:off.revision,enabled:true});
  assert.deepEqual(restart.state.scripts.map(s => s.worldId), ids.map(id => core.nativeId(id)));
});
const expose = 'globalThis.testAPI={GM,GM_getValue,GM_setValue,GM_getValues,GM_setValues,GM_deleteValue,GM_deleteValues,GM_listValues,GM_addValueChangeListener,GM_removeValueChangeListener,GM_registerMenuCommand,GM_unregisterMenuCommand};';

async function loopback(t) {
  const http = require('node:http'), { fixtureHandler } = require('./userscripts-network-fixtures.cjs');
  const state = { hits: [], aborted: 0 }, route = fixtureHandler(state);
  const server = http.createServer((request, response) => { if (!route(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { base: 'http://127.0.0.1:' + server.address().port, state };
}
const waitFor = async predicate => {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Local fixture did not reach the expected state.');
};

test('install URLs and version comparisons handle ambiguous input without fetching or precision loss', () => {
  assert.equal(core.sourceURL('https://example.test/a.user.js?version=2'), 'https://example.test/a.user.js?version=2');
  for (const url of ['http://localhost:123/a', 'http://127.0.0.1/a', 'http://[::1]/a']) assert.equal(core.sourceURL(url), url);
  for (const url of [null, {}, '/relative', 'javascript:void(0)', 'file:///a', 'data:text/javascript,a',
    'http://example.test/a', 'https://user:pass@example.test/a', 'https://example.test/a#fragment', 'https://example.test/\nnext']) assert.throws(() => core.sourceURL(url));
  for (const [a, b, expected] of [['1.10', '1.9', 1], ['2', '2.0.0', 0], ['1.2a.3', '1.2b.3', 0],
    ['001.0002', '1.2', 0], ['9007199254740993', '9007199254740992', 1], ['1.0', '1.1', -1],
    ['', '1', null], ['v2', 'v1', null], ['1.0-beta', '1.0', null]]) assert.equal(core.compareVersions(a, b), expected);
});

const updateSource = (version = '1.0', extra = '', body = '') => source('URL fixture', '// @version ' + version + '\n// @grant GM.getValue\n// @grant GM.setValue\n' + extra, body);
async function installFixture(t, text = updateSource(), options = {}) {
  const { base, state } = await loopback(t), h = harness(undefined, options);
  state.sources = { '/usnet/script.user.js': { body: text } };
  const url = base + '/usnet/script.user.js';
  const fetch = () => h.command({ type: 'US_FETCH_SOURCE', url, requestId: crypto.randomUUID() });
  const apply = review => h.command({ type: 'US_APPLY_SOURCE', source: review.source, sourceURL: review.sourceURL,
    ...(review.id ? { id: review.id, revision: review.revision } : {}) });
  const { review } = await fetch(); const saved = await apply(review);
  const current = () => h.state.data.userscriptManager.scripts.find(script => script.id === saved.selectedId);
  const check = () => h.command({ type: 'US_CHECK_UPDATE', id: current().id, revision: current().revision, requestId: crypto.randomUUID() });
  return { h, base, state, url, fetch, apply, current, check };
}

test('URL fetching is inert, cookie-free, redirect-free, bounded and validates source before review', async t => {
  const { base, state } = await loopback(t), h = harness(); await h.ready;
  state.sources = { '/usnet/script.user.js': { body: updateSource('1.0', '// @downloadURL https://example.test/ignored.user.js\n// @updateURL https://example.test/ignored.meta.js\n// @require https://example.test/not-fetched.js\n') } };
  const before = clone(h.state.data), writes = h.state.writes;
  const fetched = await h.command({ type: 'US_FETCH_SOURCE', url: base + '/usnet/script.user.js', requestId: crypto.randomUUID() });
  assert.equal(fetched.review.source, state.sources['/usnet/script.user.js'].body);
  assert.equal(fetched.review.id, undefined); assert.deepEqual(h.state.data, before);
  assert.equal(h.state.writes, writes); assert.equal(h.state.scripts.length, 0); assert.equal(state.hits.length, 1);
  assert.equal(state.hits[0].cookie, ''); assert.equal(state.hits[0].referer, '');
  for (const [entry, error] of [
    [{ body: updateSource(), mime: 'text/html' }, /HTML/],
    [{ body: 'no metadata' }, /metadata/], [{ body: Buffer.from([255]) }, /UTF-8/],
    [{ body: updateSource(), status: 404 }, /404/],
    [{ body: 'x'.repeat(core.LIMITS.source + 1), headers: { 'Content-Length': core.LIMITS.source + 1 } }, /size limit/],
    [{ body: 'x'.repeat(core.LIMITS.source + 1), chunked: true }, /size limit/],
    [{ body: '', status: 302, headers: { Location: '/usnet/should-not-load' } }, /fetch|redirect/i]
  ]) {
    state.sources['/usnet/bad.user.js'] = entry;
    await assert.rejects(h.command({ type: 'US_FETCH_SOURCE', url: base + '/usnet/bad.user.js', requestId: crypto.randomUUID() }), error);
  }
  assert.ok(!state.hits.some(hit => hit.url.includes('should-not-load'))); assert.deepEqual(h.state.data, before);
});

test('manual updates preserve fresh GM values, identity and matching cached dependencies, and revoke old APIs', async t => {
  const f = await installFixture(t);
  let script = await f.h.enable(f.current());
  const { review: identical } = await f.check(); assert.equal(identical.unchanged, true);
  assert.equal(f.current().enabled, true); await assert.rejects(f.apply(identical), /already installed/);
  f.state.sources['/usnet/script.user.js'].body = updateSource('1.1', '// @match https://second.test/*\n');
  const { review } = await f.check(); assert.equal(review.versionChange, 1); assert.equal(f.current().enabled, true);
  assert.equal((await f.h.value(script.id, 'set', { key: 'latest', value: 42 })).ok, true);
  const oldToken = f.current().token, result = await f.apply(review);
  script = f.current(); assert.equal(result.selectedId, script.id); assert.equal(script.enabled, false);
  assert.deepEqual(script.values, { latest: 42 }); assert.notEqual(script.token, oldToken);
  assert.equal(f.h.state.scripts.length, 0); assert.equal(script.sourceURL, f.url);
  assert.equal((await f.h.value(script.id, 'set', { key: 'late', value: 9 })).ok, false);
  // Existing dependency cache is preserved only when the declarations match.
  const saved = await f.h.command({ type: 'US_SAVE', id: script.id, revision: script.revision,
    source: updateSource('1.1', '// @require ' + f.base + '/usnet/first.js\n') });
  script = saved.scripts[0]; await f.h.command({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision });
  const assets = clone(f.current().assets);
  f.state.sources['/usnet/script.user.js'].body = updateSource('1.2', '// @require ' + f.base + '/usnet/first.js\n');
  await f.apply((await f.check()).review); assert.deepEqual(f.current().assets, assets);
  f.state.sources['/usnet/script.user.js'].body = updateSource('1.3', '// @require ' + f.base + '/usnet/second.js\n');
  await f.apply((await f.check()).review); assert.equal(f.current().assets, null);
  await assert.rejects(f.h.enable(f.current()), /Prepare/);
});

test('reviews survive worker restart, use exactly reviewed bytes and leave failures unchanged', async t => {
  const f = await installFixture(t); await f.h.enable(f.current());
  f.state.sources['/usnet/script.user.js'].body = updateSource('1.1', '', '// reviewed');
  const { review } = await f.check(), hits = f.state.hits.length;
  f.state.sources['/usnet/script.user.js'].body = updateSource('1.2', '', '// not reviewed');
  const restarted = harness(f.h.state.data); await restarted.ready;
  const result = await restarted.command({ type: 'US_APPLY_SOURCE', source: review.source, sourceURL: review.sourceURL, id: review.id, revision: review.revision });
  assert.equal(result.scripts[0].source, review.source); assert.equal(f.state.hits.length, hits);
  for (const fault of ['unregister', 'afterSave']) {
    const before = clone(f.h.state.data), native = clone(f.h.state.scripts); f.h.state.faults[fault] = 1;
    await assert.rejects(f.apply(review), /not applied|Injected/); assert.deepEqual(f.h.state.data, before); assert.deepEqual(f.h.state.scripts, native);
  }
});

test('updates reject changed identity, stale reviews and downgrades but expose same-version changes', async t => {
  const f = await installFixture(t), initial = clone(f.h.state.data);
  f.state.sources['/usnet/script.user.js'].body = updateSource().replace('@name URL fixture', '@name Other');
  await assert.rejects(f.check(), /@name or @namespace/); assert.deepEqual(f.h.state.data, initial);
  f.state.sources['/usnet/script.user.js'].body = updateSource('0.9');
  const older = (await f.check()).review; assert.equal(older.versionChange, -1); await assert.rejects(f.apply(older), /older/);
  f.state.sources['/usnet/script.user.js'].body = updateSource('1.0', '', '// changed');
  const changed = (await f.check()).review; assert.equal(changed.versionChange, 0); assert.equal(changed.unchanged, false);
  await f.h.command({ type: 'US_SAVE', id: f.current().id, revision: f.current().revision, source: updateSource('1.0', '', '// local edit') });
  const edited = clone(f.h.state.data); await assert.rejects(f.apply(changed), /changed in another window/); assert.deepEqual(f.h.state.data, edited);
  const fresh = (await f.check()).review;
  await f.h.command({ type: 'US_DELETE', id: f.current().id, revision: f.current().revision });
  await assert.rejects(f.apply(fresh), /changed in another window/); assert.equal(f.h.state.data.userscriptManager.scripts.length, 0);
});

test('installing an existing identity previews replacement and links local scripts without losing values', async t => {
  const { base, state } = await loopback(t), h = harness();
  const local = await h.enable(await h.save('URL fixture', '// @version 1.0\n// @grant GM.setValue\n'));
  await h.value(local.id, 'set', { key: 'kept', value: 'yes' });
  await assert.rejects(h.command({ type: 'US_CHECK_UPDATE', id: local.id, revision: local.revision, requestId: crypto.randomUUID() }), /No installed URL/);
  state.sources = { '/usnet/script.user.js': { body: local.source } };
  const { review } = await h.command({ type: 'US_FETCH_SOURCE', url: base + '/usnet/script.user.js', requestId: crypto.randomUUID() });
  assert.equal(review.id, local.id); assert.equal(review.previousSource, local.source); assert.equal(review.unchanged, false);
  await h.command({ type: 'US_APPLY_SOURCE', source: review.source, sourceURL: review.sourceURL, id: review.id, revision: review.revision });
  assert.equal(h.state.data.userscriptManager.scripts.length, 1); assert.deepEqual(h.state.data.userscriptManager.scripts[0].values, { kept: 'yes' });
});

test('source downloads cancel without blocking controls, and bounded admission releases slots', async t => {
  const f = await installFixture(t); f.state.sources['/usnet/script.user.js'].delay = 10000;
  const start = (id, update = false) => {
    const job = f.h.command({ type: update ? 'US_CHECK_UPDATE' : 'US_FETCH_SOURCE', requestId: id, url: f.url,
      ...(update ? { id: f.current().id, revision: f.current().revision } : {}) });
    job.catch(() => {}); return job;
  };
  let requestId = crypto.randomUUID(), job = start(requestId, true);
  await waitFor(() => f.state.hits.length === 2);
  await f.h.command({ type: 'US_CANCEL_SOURCE', requestId }); await assert.rejects(job, /cancelled|abort/i);
  requestId = crypto.randomUUID(); job = start(requestId, true); await waitFor(() => f.state.hits.length === 3);
  await f.h.command({ type: 'US_SAVE', id: f.current().id, revision: f.current().revision, source: updateSource('1.0', '', '// edit during fetch') });
  await assert.rejects(job, /changed|abort/i);
  const ids = Array.from({ length: 4 }, () => crypto.randomUUID()), jobs = ids.map(id => start(id));
  await waitFor(() => f.state.hits.length === 7);
  await assert.rejects(start(ids[0]), /busy/); await assert.rejects(start(crypto.randomUUID()), /busy/);
  await f.h.host.setEnabled(false); for (const pending of jobs) await assert.rejects(pending, /paused|abort/i);
  delete f.state.sources['/usnet/script.user.js'].delay; assert.equal((await f.fetch()).ok, true);
});

test('source download timeout discards bytes and preserves the installed record', async t => {
  const f = await installFixture(t), before = clone(f.h.state.data);
  f.state.sources['/usnet/script.user.js'] = { body: updateSource('2.0'), delay: 40000 };
  await assert.rejects(f.check(), /timed out/);
  assert.deepEqual(f.h.state.data, before);
  f.state.sources['/usnet/script.user.js'] = { body: updateSource('2.0') };
  assert.equal((await f.check()).review.versionChange, 1);
});

test('linked updates follow @downloadURL/@updateURL and staged bytes apply only through the normal approval', async t => {
  const { base, state } = await loopback(t), h = harness(); await h.ready;
  const links = '// @downloadURL ' + base + '/usnet/next.user.js\n// @updateURL ' + base + '/usnet/next.meta.js\n';
  state.sources = { '/usnet/script.user.js': { body: updateSource('1.0', links) } };
  const { review } = await h.command({ type: 'US_FETCH_SOURCE', url: base + '/usnet/script.user.js', requestId: crypto.randomUUID() });
  assert.equal(review.sourceURL, base + '/usnet/script.user.js', 'a new install fetches only the URL that was entered');
  const saved = await h.command({ type: 'US_APPLY_SOURCE', source: review.source, sourceURL: review.sourceURL });
  const current = () => h.state.data.userscriptManager.scripts.find(script => script.id === saved.selectedId);
  let script = await h.enable(current());
  const next = updateSource('1.1', links, 'void "next";');
  state.sources['/usnet/next.user.js'] = { body: next };
  state.sources['/usnet/next.meta.js'] = { body: '// ==UserScript==\n// @version 1.1\n// ==/UserScript==\n' };
  const manual = await h.command({ type: 'US_CHECK_UPDATE', id: script.id, revision: script.revision, requestId: crypto.randomUUID() });
  assert.equal(manual.review.sourceURL, base + '/usnet/next.user.js'); assert.equal(manual.review.versionChange, 1);
  const before = clone(h.state.data.userscriptManager), checked = await h.command({ type: 'US_CHECK_ALL' });
  assert.equal(checked.result.staged, 1); assert.equal(checked.scripts[script.id].outcome, 'staged');
  assert.equal(checked.scripts[script.id].available, '1.1');
  assert.deepEqual(h.state.data.userscriptManager, before, 'staging never edits, pauses or replaces the running script');
  assert.equal(h.state.scripts.length, 1);
  const staged = await h.command({ type: 'US_STAGED_REVIEW', id: script.id, revision: script.revision });
  assert.equal(staged.review.source, next); assert.equal(staged.review.versionChange, 1);
  const hits = state.hits.length;
  await h.command({ type: 'US_APPLY_SOURCE', source: staged.review.source, sourceURL: staged.review.sourceURL, id: staged.review.id, revision: staged.review.revision });
  script = current();
  assert.equal(state.hits.length, hits, 'approval uses the staged bytes without another download');
  assert.equal(script.source, next); assert.equal(script.enabled, false); assert.equal(script.sourceURL, base + '/usnet/next.user.js');
  assert.equal((await h.command({ type: 'US_UPDATE_STATE' })).scripts[script.id].outcome, undefined);
  await assert.rejects(h.command({ type: 'US_STAGED_REVIEW', id: script.id, revision: script.revision }), /no longer current/);
});

test('pausing userscripts cancels an active update check; settings and link passage validate their input', async t => {
  const f = await installFixture(t);
  await f.h.host.setEnabled(true);
  f.state.sources['/usnet/script.user.js'] = { body: updateSource('2.0'), delay: 10000 };
  const hits = f.state.hits.length, pending = f.h.command({ type: 'US_CHECK_ALL' });
  await waitFor(() => f.state.hits.length > hits);
  await f.h.host.setEnabled(false);
  const result = await pending;
  assert.equal(result.result.cancelled, true); assert.equal(result.scripts[f.current().id].outcome, undefined);
  await assert.rejects(f.h.command({ type: 'US_UPDATE_SETTINGS', settings: { autoCheck: 'yes' } }), /valid update setting/);
  const settings = await f.h.command({ type: 'US_UPDATE_SETTINGS', settings: { interceptLinks: false } });
  assert.equal(settings.interceptLinks, false); assert.equal(settings.autoCheck, true);
  assert.deepEqual(f.h.host.allowNavigation(7, f.url), { ok: true });
  assert.throws(() => f.h.host.allowNavigation(undefined, f.url), /browser tab/);
  assert.throws(() => f.h.host.allowNavigation(7, 'javascript:alert(1)'), /HTTPS/);
});

test('responses that are not a direct userscript carry a code so an intercepted link can return to the browser', async t => {
  const { base, state } = await loopback(t), h = harness(); await h.ready;
  const fetch = path => h.command({ type: 'US_FETCH_SOURCE', url: base + path, requestId: crypto.randomUUID() });
  state.sources = { '/usnet/redirect.user.js': { status: 302, headers: { Location: '/usnet/final.user.js' }, body: '' },
    '/usnet/page.user.js': { body: '<h1>File view</h1>', mime: 'text/html; charset=utf-8' },
    '/usnet/plain.user.js': { body: 'console.log("no metadata")' },
    '/usnet/unsupported.user.js': { body: updateSource('1.0', '// @antifeature tracking\n') },
    '/usnet/missing.user.js': { body: '', status: 404 } };
  for (const [path, code, message] of [['/usnet/redirect.user.js', 'SOURCE_REDIRECT', /redirected/], ['/usnet/page.user.js', 'SOURCE_NOT_SCRIPT', /HTML/],
    ['/usnet/plain.user.js', 'SOURCE_NOT_SCRIPT', /metadata block/], ['/usnet/unsupported.user.js', undefined, /Unsupported metadata @antifeature/],
    ['/usnet/missing.user.js', undefined, /404/]]) {
    const error = await fetch(path).then(() => assert.fail(path + ' was accepted'), error => error);
    assert.match(error.message, message, path); assert.equal(error.code, code, path);
  }
  assert.ok(!state.hits.some(hit => hit.url === '/usnet/final.user.js'), 'the redirect target was never requested');
});

const desktopGrants = ['setClipboard', 'notification', 'download'].flatMap(name => ['// @grant GM_' + name, '// @grant GM.' + name]).join('\n') + '\n// @connect 127.0.0.1\n';
async function desktopRealm(options) {
  const h = harness(undefined, options), script = await h.enable(await h.save('Desktop helpers', desktopGrants,
    'globalThis.desktop={GM,GM_setClipboard,GM_notification,GM_download};'));
  const realm = h.realm(script.id);
  await eventually(() => realm.messages.some(message => message.type === 'ready'));
  return { h, script, realm, api: realm.context.desktop, connectionId: realm.messages.find(message => message.type === 'ready').connectionId };
}
function completeDownload(h, id) {
  h.state.downloads.get(id).state = 'complete';
  h.state.hooks.downloadChanged({ id, state: { current: 'complete' } });
}

test('desktop helper options and permission lists reject unsafe or unsupported inputs', () => {
  const { normalize, permissions } = BlockAdsUserScriptActions;
  assert.deepEqual(normalize('clipboard', { data: '<b>literal</b>', type: 'html' }), { data: '<b>literal</b>', type: 'text/html' });
  for (const details of [{ data: 1 }, { data: 'x', type: false }, { data: 'x', type: 'image/png' }, { data: 'x'.repeat(1048577) }]) assert.throws(() => normalize('clipboard', details));
  for (const details of [{ text: ' ' }, { text: 'x', image: false }, { text: 'x', image: 'https://example.test/icon.png' }, { text: 'x', zombieTimeout: 1 }]) assert.throws(() => normalize('notification', details));
  for (const name of ['../escape', 'C:\\file', 'file/', 'CON', 'nul.txt', 'COM1.bin', 'hidden:stream', 'ends.', ' leading', '', 'x'.repeat(241)]) assert.throws(() => normalize('download', { name }));
  for (const conflictAction of ['uniquify', 'overwrite', 'prompt']) assert.equal(normalize('download', { name: 'ok.bin', conflictAction }).conflictAction, conflictAction);
  for (const conflictAction of [undefined, null]) assert.equal(normalize('download', { name: 'ok.bin', conflictAction }).conflictAction, 'uniquify');
  for (const conflictAction of ['replace', '', 1]) assert.throws(() => normalize('download', { name: 'ok.bin', conflictAction }), /conflictAction/);
  assert.deepEqual(permissions(['GM_setClipboard', 'GM.notification', 'GM.download']), ['clipboardWrite', 'offscreen', 'notifications', 'downloads']);
  assert.deepEqual(permissions(['GM.setClipboard'], true), ['clipboardWrite']);
  assert.deepEqual(permissions(['GM_openInTab']), [], 'Chromium tabs need no optional permission');
  assert.deepEqual(permissions(['GM.openInTab'], true), ['cookies'], 'Firefox needs cookie access to keep containers');
});

test('clipboard legacy writes return void, modern writes confirm completion, preserve order and propagate failures', async () => {
  const { h, api, realm } = await desktopRealm();
  assert.equal(api.GM_setClipboard('first'), undefined);
  await api.GM.setClipboard('<img src=x onerror=alert(1)>', 'html');
  assert.deepEqual(h.state.copies, [{ data: 'first', type: 'text/plain' }, { data: '<img src=x onerror=alert(1)>', type: 'text/html' }]);
  assert.equal(h.state.offscreen, false);
  h.state.faults.clipboard = 1;
  await assert.rejects(api.GM.setClipboard('failure'), /Injected clipboard/);
  assert.equal(h.state.offscreen, false);
  h.state.helperPermissions.delete('clipboardWrite');
  await assert.rejects(api.GM.setClipboard('denied'), /Allow clipboardWrite/);
  assert.equal(h.state.copies.length, 2);
  assert.deepEqual(realm.errors, []);
});

test('desktop actions require exact grants and native document-bound connections', async () => {
  const { h, script, realm, connectionId } = await desktopRealm();
  const message = { actionId: '999', details: { data: 'forged', type: 'text/plain' } };
  assert.equal((await h.value(script.id, 'clipboard', message, realm.from)).ok, false);
  assert.equal((await h.value(script.id, 'clipboard', { ...message, connectionId }, { ...realm.from, documentId: 'other' })).ok, false);
  const plain = await h.enable(await h.save('No helpers', '// @grant GM.getValue\n', ''));
  assert.equal((await h.value(plain.id, 'clipboard', message)).ok, false);
  assert.equal(h.state.copies.length, 0);
});

test('notification handles return synchronously, dispatch owned callbacks and remove exactly once', async () => {
  const { h, api, realm } = await desktopRealm(); let clicked = 0, done = 0;
  const handle = api.GM.notification({ text: 'fixture', title: 'Local', silent: true, onclick: () => clicked++, ondone: () => done++ });
  assert.equal(handle.then, undefined);
  await eventually(() => h.state.notifications.size === 1);
  const id = [...h.state.notifications.keys()][0];
  assert.equal(h.state.notifications.get(id).title, 'Desktop helpers · Local');
  h.state.hooks.notificationClicked('unrelated'); h.state.hooks.notificationClicked(id);
  await eventually(() => clicked === 1);
  const removal = handle.remove(); assert.equal(handle.remove(), removal); await removal;
  h.state.hooks.notificationClosed(id, true); await handle.remove();
  assert.equal(done, 1); assert.equal(h.state.notifications.size, 0);
  const legacy = api.GM_notification('legacy', 'Title', undefined, () => { throw new Error('callback failure'); });
  await eventually(() => h.state.notifications.size === 1);
  h.state.hooks.notificationClicked([...h.state.notifications.keys()][0]);
  await eventually(() => realm.errors.some(error => error.includes('callback failure')));
  await legacy.remove(); assert.equal(h.state.notifications.size, 0);
});

test('notification tags replace only the same document and forged native IDs cannot clear another notification', async () => {
  const { h, api, realm, script, connectionId } = await desktopRealm(); let done = 0;
  api.GM.notification({ text: 'first', tag: 'status', ondone: () => done++ });
  await eventually(() => h.state.notifications.size === 1);
  const secondRealm = h.realm(script.id, 8); await eventually(() => secondRealm.messages.some(message => message.type === 'ready'));
  const other = secondRealm.context.desktop.GM.notification({ text: 'other', tag: 'status' });
  await eventually(() => h.state.notifications.size === 2);
  const replacement = api.GM.notification({ text: 'replacement', tag: 'status' });
  await eventually(() => done === 1 && h.state.notifications.size === 2);
  assert.equal((await h.value(script.id, 'removeNotification', { actionId: [...h.state.notifications.keys()][0], connectionId }, realm.from)).ok, false);
  assert.equal(h.state.notifications.size, 2);
  await replacement.remove(); await other.remove();
});

test('Firefox notifications omit the unsupported native silent field', async () => {
  const { h, api } = await desktopRealm({ firefox: true });
  const handle = api.GM.notification({ text: 'Firefox fixture', silent: true });
  await eventually(() => h.state.notifications.size === 1);
  assert.equal(Object.hasOwn([...h.state.notifications.values()][0], 'silent'), false);
  await handle.remove();
});

test('notification removal before ready creates no native notification', async () => {
  const h = harness(), script = await h.enable(await h.save('Early removal', '// @grant GM.notification\n',
    'globalThis.done=0;globalThis.removed=GM.notification({text:"unused",ondone:()=>done++}).remove();'));
  const realm = h.realm(script.id); await realm.context.removed;
  await eventually(() => realm.messages.some(message => message.type === 'ready'));
  assert.equal(realm.context.done, 1); assert.equal(h.state.notifications.size, 0);
});

test('pending native notifications are cleaned after script revocation and controls remain responsive', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let entered = false;
  const { h, api, realm } = await desktopRealm({ notificationCreate: async () => { entered = true; await gate; } });
  const handle = api.GM.notification({ text: 'late' });
  await eventually(() => entered);
  await h.host.setEnabled(false);
  const removed = assert.rejects(handle.remove(), /connection|inactive|connected/);
  release(); await removed;
  await eventually(() => realm.errors.some(error => error.includes('connection')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.notifications.size, 0);
  assert.equal((await h.command({ type: 'US_LIST' })).enabled, false);
});

test('notification permission denial and revocation settle pending actions without losing other helpers', async () => {
  const { h, api, realm } = await desktopRealm({ helperPermissions: ['clipboardWrite', 'offscreen'] });
  const denied = api.GM.notification({ text: 'denied' });
  await eventually(() => realm.errors.some(error => error.includes('Allow notifications')));
  await assert.rejects(denied.remove(), /Allow notifications/);
  assert.equal(h.state.notifications.size, 0);
  h.state.helperPermissions.add('notifications'); h.state.hooks.added({ permissions: ['notifications'] });
  const shown = api.GM.notification({ text: 'temporary' });
  await eventually(() => h.state.notifications.size === 1);
  h.state.helperPermissions.delete('notifications'); h.state.hooks.removed({ permissions: ['notifications'] });
  await eventually(() => h.state.notifications.size === 0);
  await assert.rejects(shown.remove(), /permission was removed/);
  await api.GM.setClipboard('still allowed'); assert.equal(h.state.copies.length, 1);
});

test('desktop action admission remains bounded while native creation is stalled', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const { h, api, realm } = await desktopRealm({ notificationCreate: () => gate });
  const handles = Array.from({ length: 5 }, (_, index) => api.GM.notification({ text: 'bounded ' + index }));
  await eventually(() => realm.errors.some(error => error.includes('Too many active')));
  assert.equal((await h.command({ type: 'US_LIST' })).active, true);
  release(); await eventually(() => h.state.notifications.size === 4);
  await Promise.all(handles.slice(0, 4).map(handle => handle.remove()));
  await assert.rejects(handles[4].remove(), /Too many active/);
});

test('clipboard rate limits survive completed actions without blocking manager controls', async () => {
  const { h, api } = await desktopRealm();
  for (let i = 0; i < 32; i++) await api.GM.setClipboard('bounded fixture');
  await assert.rejects(api.GM.setClipboard('over limit'), /32 desktop actions/);
  assert.equal(h.state.copies.length, 32); assert.equal((await h.command({ type: 'US_LIST' })).active, true);
});

test('downloads preserve bytes and resolve only after the native save completes', async t => {
  const { base } = await loopback(t), { h, api } = await desktopRealm(); let loaded = 0, ended = 0;
  const promise = api.GM.download({ url: base + '/usnet/bytes.bin', name: 'fixture.bin', anonymous: true, onload: () => loaded++, onloadend: () => ended++ });
  assert.equal(typeof promise.abort, 'function');
  await waitFor(() => h.state.downloads.size === 1);
  assert.equal(loaded, 0); assert.equal(ended, 0);
  const native = h.state.downloads.get(1);
  assert.equal(native.url, 'data:application/octet-stream;base64,AAF/gP8=');
  assert.equal(native.filename, 'fixture.bin'); assert.equal(native.conflictAction, 'uniquify');
  completeDownload(h, 1); const result = await promise;
  assert.deepEqual([...new Uint8Array(await result.response.arrayBuffer())], [0, 1, 127, 128, 255]);
  assert.equal(loaded, 1); assert.equal(ended, 1);
  let legacyDone = 0;
  const handle = api.GM_download({ url: base + '/usnet/bytes.bin', name: 'legacy.bin', onload: () => legacyDone++ });
  assert.equal(handle.then, undefined); await waitFor(() => h.state.downloads.size === 2);
  completeDownload(h, 2); await eventually(() => legacyDone === 1);
});

test('downloads reject permission, scope, HTTP, redirect, oversized and filename failures before saving', async t => {
  const { base, state } = await loopback(t), { h, api } = await desktopRealm({ helperPermissions: [] });
  await assert.rejects(api.GM.download(base + '/usnet/bytes.bin', 'denied.bin'), /Allow downloads/);
  assert.equal(state.hits.length, 0);
  h.state.helperPermissions.add('downloads'); h.state.hooks.added({ permissions: ['downloads'] });
  await assert.rejects(api.GM.download(base.replace('127.0.0.1', 'localhost') + '/usnet/bytes.bin', 'scope.bin'), /connect scope/);
  for (const endpoint of ['missing', 'redirect', 'oversize']) await assert.rejects(api.GM.download({ url: base + '/usnet/' + endpoint, name: endpoint + '.bin', redirect: 'error' }));
  assert.throws(() => api.GM_download(base + '/usnet/bytes.bin', '../escape.bin'), /filename/);
  assert.equal(h.state.downloads.size, 0);
});

test('downloads pass collision policies to the native save and send Basic credentials', async t => {
  const { base, state } = await loopback(t), { h, api } = await desktopRealm();
  const saved = [];
  for (const conflictAction of ['overwrite', 'prompt']) {
    const promise = api.GM.download({ url: base + '/usnet/bytes.bin?' + conflictAction, name: 'same.bin', conflictAction, user: 'u', password: 'p' });
    await waitFor(() => h.state.downloads.size === saved.length + 1);
    const native = h.state.downloads.get(saved.length + 1); saved.push(native.conflictAction);
    assert.equal(native.filename, 'same.bin');
    assert.equal(state.hits.at(-1).authorization, 'Basic dTpw');
    completeDownload(h, native.id); await promise;
  }
  assert.deepEqual(saved, ['overwrite', 'prompt']);
  assert.throws(() => api.GM.download({ url: base + '/usnet/bytes.bin', name: 'bad.bin', conflictAction: 'replace' }), /conflictAction/);
});

test('Firefox rejects the unimplemented prompt collision policy before transferring', async t => {
  const { base, state } = await loopback(t), { h, api } = await desktopRealm({ firefox: true });
  await assert.rejects(api.GM.download({ url: base + '/usnet/bytes.bin', name: 'prompt.bin', conflictAction: 'prompt' }), /Firefox does not support conflictAction "prompt"/);
  assert.equal(state.hits.length, 0); assert.equal(h.state.downloads.size, 0);
  const overwrite = api.GM.download({ url: base + '/usnet/bytes.bin', name: 'overwrite.bin', conflictAction: 'overwrite' });
  await waitFor(() => h.state.downloads.size === 1);
  assert.equal(h.state.downloads.get(1).conflictAction, 'overwrite');
  completeDownload(h, 1); await overwrite;
});

test('Firefox downloads own a Blob URL only until native completion or cancellation', async t => {
  const { base } = await loopback(t), { h, api } = await desktopRealm({ firefox: true });
  const promise = api.GM.download(base + '/usnet/bytes.bin', 'firefox.bin');
  await waitFor(() => h.state.downloads.size === 1);
  const url = h.state.downloads.get(1).url; assert.ok(url.startsWith('blob:'));
  assert.deepEqual([...new Uint8Array(await (await fetch(url)).arrayBuffer())], [0, 1, 127, 128, 255]);
  completeDownload(h, 1); await promise; await assert.rejects(fetch(url));
  const pending = api.GM.download(base + '/usnet/bytes.bin', 'cancel.bin'), rejected = assert.rejects(pending, /aborted/);
  await waitFor(() => h.state.downloads.size === 2); const cancelled = h.state.downloads.get(2).url;
  pending.abort(); await rejected; await eventually(() => h.state.downloadCancels.length === 1);
  await new Promise(resolve => setImmediate(resolve)); await assert.rejects(fetch(cancelled));
});

test('download abort settles once during both fetch and native save, preserving unrelated records', async t => {
  const { base, state } = await loopback(t), { h, api } = await desktopRealm(); let aborted = 0, ended = 0;
  const slow = api.GM_download({ url: base + '/usnet/slow', name: 'slow.bin', onabort: () => aborted++, onloadend: () => ended++ });
  await waitFor(() => state.hits.length === 1); slow.abort(); slow.abort();
  await waitFor(() => state.aborted === 1); assert.equal(aborted, 1); assert.equal(ended, 1); assert.equal(h.state.downloads.size, 0);
  h.state.downloads.set(999, { id: 999, state: 'complete' });
  const saved = api.GM.download(base + '/usnet/bytes.bin', 'cancel.bin');
  const rejected = assert.rejects(saved, /aborted/);
  await waitFor(() => h.state.downloads.has(1)); saved.abort(); await rejected;
  await eventually(() => h.state.downloadCancels.includes(1));
  assert.deepEqual(h.state.downloadCancels, [1]); assert.equal(h.state.downloads.get(999).state, 'complete');
});

test('downloads accepted during revocation are cancelled when their native IDs arrive', async t => {
  const { base } = await loopback(t); let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const { h, api } = await desktopRealm({ downloadCreate: async () => { entered = true; await gate; } });
  const downloading = api.GM.download(base + '/usnet/bytes.bin', 'late.bin');
  const rejected = assert.rejects(downloading, /connection closed/);
  await waitFor(() => entered); await h.host.setEnabled(false);
  release(); await rejected; await eventually(() => h.state.downloadCancels.length === 1);
  assert.equal(h.state.downloads.get(1).state, 'interrupted');
});

test('native download failures, interrupts and early completion reconcile once', async t => {
  const { base } = await loopback(t), { h, api } = await desktopRealm();
  h.state.faults.download = 1;
  await assert.rejects(api.GM.download(base + '/usnet/bytes.bin', 'failure.bin'), /Injected download/);
  const interrupted = api.GM.download(base + '/usnet/bytes.bin', 'interrupted.bin');
  const rejected = assert.rejects(interrupted, /FILE_FAILED/);
  await waitFor(() => h.state.downloads.size === 1);
  h.state.hooks.downloadChanged({ id: 1, state: { current: 'interrupted' }, error: { current: 'FILE_FAILED' } }); await rejected;
  const original = h.api.downloads.download;
  h.api.downloads.download = async data => { const id = await original(data); completeDownload(h, id); return id; };
  const completed = await api.GM.download(base + '/usnet/bytes.bin', 'early.bin'); assert.equal(completed.status, 200);
});

test('a restarted helper broker clears stale notifications only and binds APIs granted after startup', async () => {
  const callbacks = {}, calls = [], live = new Set(), api = { runtime: { getURL: path => 'chrome-extension://test/' + path }, permissions: { contains: async () => true,
    onAdded: { addListener: fn => { callbacks.added = fn; } }, onRemoved: { addListener: fn => { callbacks.removed = fn; } } } };
  const host = BlockAdsUserScriptActions.create(api, connection => live.has(connection));
  api.notifications = { getAll: async () => ({ 'me-us-stale': {}, 'blocker-status': {} }), clear: async id => { calls.push(id); },
    create: async () => {}, onClicked: { addListener: fn => { callbacks.clicked = fn; } }, onClosed: { addListener: fn => { callbacks.closed = fn; } } };
  callbacks.added({ permissions: ['notifications'] });
  await eventually(() => calls.length === 1); assert.deepEqual(calls, ['me-us-stale']); assert.equal(typeof callbacks.clicked, 'function');
  const events = [], connection = { id: 'c', scriptId: 's', port: { postMessage: event => events.push(event) } }; live.add(connection);
  host.request({ operation: 'notification', actionId: '1', details: { text: 'owned' } }, { id: 's' }, { name: 'Fixture' }, connection);
  await new Promise(resolve => setImmediate(resolve)); host.drop(connection);
  await eventually(() => calls.length === 2); assert.ok(calls[1].startsWith('me-us-')); assert.equal(events.length, 0);
});

const tabGrants = '// @grant GM_openInTab\n// @grant GM.openInTab\n';
const tabBody = 'globalThis.openTab=GM_openInTab;globalThis.modernTab=GM.openInTab;';
async function tabRealm(options) {
  const h = harness(undefined, options), script = await h.enable(await h.save('Tab helpers', tabGrants, tabBody));
  const realm = h.realm(script.id);
  await eventually(() => realm.messages.some(message => message.type === 'ready'));
  return { h, script, realm, connectionId: realm.messages.find(message => message.type === 'ready').connectionId };
}
test('Firefox tabs keep the source container, honor container indexes and ignore them elsewhere', async () => {
  const opened = async (options, parent, firefox = true, permissions = ['cookies']) => {
    const { h, realm } = await tabRealm({ firefox, helperPermissions: permissions });
    Object.assign(h.state.tabs.get(7), parent);
    const control = realm.context.modernTab('https://example.test/next', options);
    await eventually(() => h.state.createdTabs.length === 1 || control.closed);
    return { tab: h.state.createdTabs[0], errors: realm.errors };
  };
  assert.equal((await opened(undefined, { cookieStoreId: 'firefox-container-3' })).tab.cookieStoreId, 'firefox-container-3', 'inherit the source container');
  assert.equal((await opened({ container: 2 }, { cookieStoreId: 'firefox-default' })).tab.cookieStoreId, 'firefox-container-2');
  assert.equal('cookieStoreId' in (await opened({ container: 0 }, { cookieStoreId: 'firefox-container-3' })).tab, false, 'container 0 is the default container');
  assert.equal('cookieStoreId' in (await opened(undefined, { cookieStoreId: 'firefox-default' }, true, [])).tab, false, 'the default container needs no permission');
  assert.equal('cookieStoreId' in (await opened(undefined, { cookieStoreId: 'firefox-private', incognito: true }, true, [])).tab, false, 'private windows keep their store');
  const denied = await opened(undefined, { cookieStoreId: 'firefox-container-3' }, true, []);
  assert.equal(denied.tab, undefined, 'a container tab is never silently opened outside its container');
  assert.ok(denied.errors.some(error => /Firefox containers/.test(error)));
  const privateContainer = await opened({ container: 1 }, { incognito: true });
  assert.equal(privateContainer.tab, undefined); assert.ok(privateContainer.errors.some(error => /private windows/.test(error)));
  assert.equal('cookieStoreId' in (await opened({ container: 2 }, {}, false, [])).tab, false, 'Chromium ignores Firefox containers');
});
test('tab options normalize defaults and background booleans while rejecting privileged URLs and unsupported options', () => {
  assert.deepEqual(core.tabOptions('/next', undefined, 'https://example.test/start'), { url: 'https://example.test/next', active: true, insert: true, pinned: false });
  assert.equal(core.tabOptions('/next', true, 'https://example.test/start').active, false);
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///private', 'chrome://settings', 'moz-extension://other/page', 'https://user:secret@example.test/']) {
    assert.throws(() => core.tabOptions(url), /HTTP|URL/);
  }
  assert.equal(core.tabOptions('/next', { container: 0 }, 'https://example.test/start').container, 0);
  assert.equal(core.tabOptions('/next', { container: 2, active: false }, 'https://example.test/start').container, 2);
  assert.equal('container' in core.tabOptions('/next', {}, 'https://example.test/start'), false, 'an omitted container inherits the source tab’s');
  for (const options of [{ active: 1 }, { container: -1 }, { container: 1.5 }, { container: '1' }, { container: 2 ** 31 }, { tabId: 7 }, [], null]) {
    assert.throws(() => core.tabOptions('https://example.test/', options), /options/);
  }
});
test('both tab helpers return immediate owned handles with close-before-open and a single onclose notification', async () => {
  const { h, realm } = await tabRealm();
  const control = realm.context.openTab('/next', true); let closed = 0;
  control.onclose = () => closed++; control.close();
  assert.equal(control.then, undefined); assert.equal(control.closed, false);
  await eventually(() => control.closed);
  assert.equal(closed, 1); control.close(); assert.equal(closed, 1);
  assert.deepEqual(h.state.createdTabs[0], { id: 100, url: 'https://example.test/next', active: false, pinned: false, windowId: 2, index: 4, openerTabId: 7 });
  const second = realm.context.modernTab('https://example.test/pinned', { insert: false, pinned: true });
  await eventually(() => h.state.createdTabs.length === 2);
  assert.equal(second.then, undefined); assert.equal(h.state.createdTabs[1].pinned, true);
  assert.equal(h.state.createdTabs[1].index, undefined); assert.equal(h.state.createdTabs[1].openerTabId, undefined);
  await h.api.tabs.remove(101); await eventually(() => second.closed);
  assert.equal(h.state.tabs.has(7), true); assert.equal(h.state.tabs.has(8), true);
  assert.deepEqual(realm.errors, []);
});
test('tab permissions and handles cannot cross grants, documents, connections or native tab IDs', async () => {
  const { h, realm, script, connectionId } = await tabRealm();
  const handle = realm.context.openTab('/owned'); await eventually(() => h.state.createdTabs.length === 1);
  const details = core.tabOptions('/next', undefined, realm.from.url);
  for (const [operation, args, from] of [
    ['openTab', { details, tabHandle: '2' }, realm.from],
    ['openTab', { details, tabHandle: '2', connectionId }, { ...realm.from, documentId: 'other' }],
    ['closeTab', { tabHandle: '100', tabId: 8, connectionId }, realm.from],
    ['openTab', { details: { ...details, url: 'javascript:alert(1)' }, tabHandle: '3', connectionId }, realm.from]
  ]) assert.equal((await h.value(script.id, operation, args, from)).ok, false);
  const other = await h.enable(await h.save('No tab grant', '// @grant GM_getValue\n', ''));
  assert.equal((await h.value(other.id, 'openTab', { details, tabHandle: '1' })).ok, false);
  assert.equal(h.state.createdTabs.length, 1); assert.equal(h.state.tabs.has(8), true);
  handle.close(); await eventually(() => handle.closed);
});
test('tab creation and close failures release capacity and leave unrelated tabs alone', async () => {
  const { h, realm } = await tabRealm();
  h.state.faults.tabCreate = 1;
  const failed = realm.context.openTab('/failure'); await eventually(() => failed.closed);
  assert.equal(h.state.createdTabs.length, 0);
  const handle = realm.context.openTab('/retry'); await eventually(() => realm.messages.some(message => message.event === 'opened'));
  h.state.faults.tabRemove = 1; handle.close();
  await eventually(() => realm.errors.some(error => error.includes('tabRemove')));
  assert.equal(handle.closed, false); handle.close(); await eventually(() => handle.closed);
  assert.equal(h.state.tabs.size, 2);
});
test('a post-creation lookup failure does not fabricate closure of a tab moved to another window', async () => {
  const { h, realm } = await tabRealm({ tabGet: async id => { if (id >= 100) { h.state.tabs.get(id).windowId = 3; throw new Error('lookup unavailable'); } } });
  const handle = realm.context.openTab('/uncertain'); let closed = 0; handle.onclose = () => closed++;
  await eventually(() => realm.errors.some(error => error.includes('lookup unavailable')));
  assert.equal(handle.closed, false); assert.equal(closed, 0); assert.equal(h.state.tabs.has(100), true);
  assert.throws(() => handle.close(), /connected/);
  assert.deepEqual(h.state.removedTabs, []);
});
test('manager disable does not wait for tab lookup and prevents an opening that has not reached the browser', async () => {
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  const { h, realm } = await tabRealm({ tabGet: async id => { if (id === 7) { entered = true; await gate; } } });
  const handle = realm.context.openTab('/pending'); await eventually(() => entered);
  assert.equal((await h.host.setEnabled(false)).enabled, false);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.createdTabs.length, 0); assert.equal(handle.closed, false);
  assert.throws(() => handle.close(), /connected/);
});
test('revocation during an accepted browser creation never closes or claims ownership of the resulting page', async () => {
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const { h, realm } = await tabRealm({ tabCreate: async () => { entered = true; await gate; } });
  const handle = realm.context.openTab('/accepted'); let closed = 0; handle.onclose = () => closed++;
  await eventually(() => entered); await h.host.setEnabled(false); release();
  await eventually(() => h.state.createdTabs.length === 1);
  assert.equal(handle.closed, false); assert.equal(closed, 0); assert.deepEqual(h.state.removedTabs, []);
  assert.throws(() => handle.close(), /connected/);
});

test('pending native openings remain bounded across connection revocation', async () => {
  let release, entered = 0; const gate = new Promise(resolve => { release = resolve; });
  const { h, realm, script } = await tabRealm({ tabCreate: async () => { entered++; await gate; } });
  for (let i = 0; i < 4; i++) realm.context.openTab('/pending-' + i);
  await eventually(() => entered === 4);
  const limited = realm.context.openTab('/over-limit'); await eventually(() => limited.closed);
  assert.ok(realm.errors.some(error => error.includes('pending openings')));
  realm.ports[0].loseConnection();
  const fresh = h.realm(script.id, 8);
  await eventually(() => fresh.messages.some(message => message.type === 'ready'));
  const stillLimited = fresh.context.openTab('/after-disconnect'); await eventually(() => stillLimited.closed);
  assert.equal(entered, 4);
  assert.equal((await h.host.setEnabled(false)).enabled, false);
  release(); await eventually(() => h.state.createdTabs.length === 4);
  assert.deepEqual(h.state.removedTabs, []);
  realm.event('pagehide'); fresh.event('pagehide');
});
test('native connection loss invalidates tab handles without replaying or fabricating a close', async () => {
  const { h, realm } = await tabRealm();
  const handle = realm.context.openTab('/kept'); let closed = 0; handle.onclose = () => closed++;
  await eventually(() => realm.messages.some(message => message.event === 'opened'));
  realm.ports[0].loseConnection(); await eventually(() => realm.ports.length === 1 && h.state.createdTabs.length === 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => handle.close(), /connected/); assert.equal(handle.closed, false); assert.equal(closed, 0);
  realm.event('pagehide', { persisted: false });
  assert.equal(h.state.createdTabs.length, 1);
});
test('rapid open-and-close cycles are bounded per script without blocking manager controls', async () => {
  const { h, realm } = await tabRealm();
  for (let i = 0; i < 32; i++) {
    const handle = realm.context.openTab('/rate-' + i); handle.close(); await eventually(() => handle.closed);
  }
  const refused = realm.context.openTab('/overflow'); await eventually(() => refused.closed);
  assert.equal(h.state.createdTabs.length, 32);
  assert.ok(realm.errors.some(error => error.includes('32 tab openings')));
  assert.equal((await h.host.setEnabled(false)).enabled, false);
});

test('default timing, GM_info grant metadata and case-insensitive globs match compatibility contracts', () => {
  const parsed = core.parse(source('Default', '// @include https://other.test/Path*\n// @exclude *SECRET*\n// @grant GM.info\n'));
  assert.equal(parsed.runAt, 'document_end');
  assert.equal(core.allows(parsed, 'https://other.test/pATH'), true);
  assert.equal(core.allows(parsed, 'https://other.test/Path/secret'), false);
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source('Info', '// @grant GM.info\n// @author Offline\n', 'globalThis.info = GM.info;') };
  const context = vm.createContext({ URL, location: { href: 'https://example.test/page' } }); inject(core.registration(record), context);
  assert.deepEqual(json(context.info.script.grant), ['GM.info']);
  assert.equal(context.info.script.author, 'Offline'); assert.equal(context.info.script.runAt, 'document-end');
  assert.equal(context.info.scriptWillUpdate, false); assert.equal(context.info.uuid, record.id);
  assert.equal(context.info.injectInto, 'content'); assert.match(context.info.scriptMetaStr, /@name Info/);
});

test('menu icons accept bounded raster data and ignore remote or executable content', async () => {
  const h = harness(), script = await h.enable(await h.save('Icons', '// @grant GM_registerMenuCommand\n', 'globalThis.menu = GM_registerMenuCommand;'));
  const realm = h.realm(script.id);
  const icon = 'data:image/png;base64,aGVsbG8=';
  realm.context.menu('Local', () => {}, { icon });
  realm.context.menu('Remote', () => {}, { icon: 'https://never-fetched.invalid/icon.png' });
  realm.context.menu('SVG', () => {}, { icon: 'data:image/svg+xml;base64,aGVsbG8=' });
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length === 3);
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.map(item => item.icon), [icon, '', '']);
});

test('dependencies require explicit preparation, retain order, expose granted resources and reuse offline cache', async t => {
  const { base, state } = await loopback(t), h = harness();
  const metadata = '// @require ' + base + '/usnet/first.js\n// @require ' + base + '/usnet/second.js\n// @resource css ' + base + '/usnet/style.css\n// @resource bytes ' + base + '/usnet/bytes.bin\n' +
    '// @grant GM_getResourceText\n// @grant GM_getResourceURL\n// @grant GM.getResourceText\n// @grant GM.getResourceUrl\n';
  let script = await h.save('Assets', metadata, 'globalThis.result={value:offlineLibrary.value,order:offlineOrder,text:GM_getResourceText("css"),GM,GM_getResourceURL,GM_getResourceText};');
  assert.equal(state.hits.length, 0, 'saving does not fetch');
  await assert.rejects(h.enable(script), /Prepare and review/);
  assert.equal(state.hits.length, 0, 'enabling does not fetch');
  let response = await h.command({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision });
  script = response.scripts.find(item => item.id === script.id);
  assert.equal(script.enabled, false); assert.equal(script.assets.length, 4);
  assert.equal(state.hits.length, 4); assert.ok(script.assets.every(asset => !Object.hasOwn(asset, 'body') && asset.sha256.length === 64));
  const preview = await h.command({ type: 'US_ASSET_READ', id: script.id, revision: script.revision, index: 0 });
  assert.match(preview.asset.text, /offlineLibrary/); assert.equal(globalThis.offlineLibrary, undefined);
  await h.enable(script); const realm = h.realm(script.id), result = realm.context.result;
  assert.equal(result.value, 42); assert.deepEqual(json(result.order), ['first', 'second']); assert.match(result.text, /✓/);
  assert.equal(await result.GM.getResourceText('css'), result.text);
  assert.equal(await result.GM.getResourceUrl('bytes'), result.GM_getResourceURL('bytes'));
  assert.deepEqual([...new Uint8Array(await (await fetch(result.GM_getResourceURL('bytes'))).arrayBuffer())], [0, 1, 127, 128, 255]);
  assert.throws(() => result.GM_getResourceText('missing'), /Unknown @resource/);
  assert.equal(result.GM.xmlHttpRequest, undefined, 'resources grant no network API');
  await h.host.start(); h.realm(script.id, 8);
  assert.equal(state.hits.length, 4, 'startup and page execution use cached dependencies');
  const blobURL = result.GM_getResourceURL('bytes'); realm.event('pagehide', { persisted: false });
  await assert.rejects(fetch(blobURL));
});

test('enabling a bidi dependency requires its reviewed digest and current revision, including on upgrade', async t => {
  const { base, state } = await loopback(t), h = harness();
  const path = '/usnet/direction.js';
  state.sources = { [path]: { body: '// fixture ' + String.fromCodePoint(0x200e) } };
  let script = await h.save('Dependency review', '// @require ' + base + path + '\n');
  const prepare = async () => (await h.command({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision })).scripts[0];
  script = await prepare();
  assert.equal(script.assets[0].bidi, true);
  const enable = (digests, revision = script.revision) => h.command({ type: 'US_ENABLE', id: script.id, revision, enabled: true, acknowledgeBidi: true, reviewedRequires: digests });
  const first = script.assets[0].sha256, revision = script.revision;
  await assert.rejects(enable(undefined), /dependencies/);
  state.sources[path].body += ' changed'; script = await prepare();
  await assert.rejects(enable([first], revision), /changed/);
  await assert.rejects(enable([first]), /dependencies/);
  const current = script.assets[0].sha256;
  assert.equal((await enable([current])).scripts[0].enabled, true);
  const stored = structuredClone(h.state.data.userscriptManager);
  delete stored.scripts[0].reviewedRequires;
  assert.equal(BlockAdsUserScriptCore.library(stored).scripts[0].enabled, false);
});

test('dependency hash pins, corrupt caches, changed declarations and invalid file responses fail closed', async t => {
  const { base } = await loopback(t), h = harness();
  const { createHash } = require('node:crypto'), { assets } = require('./userscripts-network-fixtures.cjs');
  const hash = createHash('sha256').update(assets['/usnet/first.js'][1]).digest('hex');
  let script = await h.save('Pinned', '// @require ' + base + '/usnet/first.js#sha256=' + hash + '\n');
  let response = await h.command({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision }); script = response.scripts[0];
  assert.equal(script.assets[0].sha256, hash);
  const record = h.state.data.userscriptManager.scripts[0], original = record.assets[0].body;
  record.assets[0].body = btoa('var tampered = true;');
  await assert.rejects(h.enable(script), /integrity/); assert.equal(h.state.scripts.length, 0);
  record.assets[0].body = original;
  response = await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: script.source + '\n// changed body' });
  script = response.scripts[0]; assert.equal(script.assets[0].sha256, hash, 'body-only edits retain the reviewed cache');
  response = await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: script.source.replace('first.js#sha256=' + hash, 'second.js') });
  script = response.scripts[0]; assert.equal(script.assets, null);
  for (const [name, suffix, expected] of [['Wrong pin', 'first.js#sha256=' + '0'.repeat(64), /SHA-256/], ['HTML', 'bad.js', /HTML/],
    ['UTF8', 'bad-utf8.js', /UTF-8/], ['Large', 'large.js', /size limit/], ['Redirect', 'redirect', /fetch failed/]]) {
    const bad = await h.save(name, '// @require ' + base + '/usnet/' + suffix + '\n');
    await assert.rejects(h.command({ type: 'US_PREPARE_ASSETS', id: bad.id, revision: bad.revision }), expected);
    assert.equal(h.state.data.userscriptManager.scripts.find(item => item.id === bad.id).assets, null);
  }
});

test('slow dependency jobs are cancellable, do not hold controls, and cannot commit after an edit', async t => {
  const { base, state } = await loopback(t), h = harness();
  for (const action of ['cancel', 'edit', 'delete', 'disable']) {
    const script = await h.save('Slow ' + action, '// @resource slow ' + base + '/usnet/slow\n');
    const pending = h.command({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision }).then(() => 'committed', () => 'cancelled');
    await waitFor(() => state.hits.filter(item => item.url === '/usnet/slow').length >= ['cancel', 'edit', 'delete', 'disable'].indexOf(action) + 1);
    assert.equal((await h.command({ type: 'US_LIST' })).ok, true, 'controls run during the download');
    if (action === 'cancel') await h.command({ type: 'US_CANCEL_ASSETS', id: script.id });
    else if (action === 'edit') await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: script.source + '\n// edited' });
    else if (action === 'delete') await h.command({ type: 'US_DELETE', id: script.id, revision: script.revision });
    else await h.host.setEnabled(false);
    assert.equal(await pending, 'cancelled');
    assert.ok(!h.state.data.userscriptManager.scripts.find(item => item.id === script.id)?.assets);
  }
});

test('startup integrity failure preserves cached data and removes previously registered scripts', async t => {
  const { base } = await loopback(t), h = harness();
  let script = await h.save('Integrity restart', '// @require ' + base + '/usnet/first.js\n');
  script = (await h.command({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision })).scripts[0];
  await h.enable(script); assert.equal(h.state.scripts.length, 1);
  h.state.data.userscriptManager.scripts[0].assets[0].body = btoa('var damaged = true;');
  const damaged = clone(h.state.data.userscriptManager);
  await h.host.start();
  assert.equal(h.state.scripts.length, 0); assert.equal(h.state.worlds.length, 0);
  assert.deepEqual(h.state.data.userscriptManager, damaged);
  const status = await h.command({ type: 'US_LIST' }); assert.equal(status.active, false); assert.match(status.error, /integrity/);
});

test('network API sends bounded real loopback requests with modern results and legacy callback ordering', async t => {
  const { base } = await loopback(t), h = harness();
  const script = await h.enable(await h.save('HTTP', '// @connect 127.0.0.1\n// @grant GM.xmlHttpRequest\n// @grant GM_xmlhttpRequest\n', 'globalThis.api = {GM,GM_xmlhttpRequest};'));
  const realm = h.realm(script.id), { GM, GM_xmlhttpRequest } = realm.context.api;
  const context = { local: () => true };
  const response = await GM.xmlHttpRequest({ url: base + '/usnet/json', method: 'POST', headers: { 'X-Test': 'hello' }, data: 'body ✓', responseType: 'json', context, anonymous: true });
  assert.equal(response.status, 200); assert.equal(response.response.value, 42); assert.equal(response.response.body, 'body ✓');
  assert.equal(response.response.header, 'hello'); assert.equal(response.context, context); assert.match(response.responseHeaders, /x-offline-fixture: yes/);
  assert.equal((await GM.xmlHttpRequest({ url: base + '/usnet/missing' })).status, 404, 'HTTP failures are onload results');
  assert.equal((await GM.xmlHttpRequest({ url: base + '/usnet/invalid-json', responseType: 'json' })).response, null);
  const binary = await GM.xmlHttpRequest({ url: base + '/usnet/bytes.bin', responseType: 'arraybuffer' });
  assert.deepEqual([...new Uint8Array(binary.response)], [0, 1, 127, 128, 255]);
  const blob = await GM.xmlHttpRequest({ url: base + '/usnet/bytes.bin', responseType: 'blob' });
  assert.deepEqual([...new Uint8Array(await blob.response.arrayBuffer())], [0, 1, 127, 128, 255]);
  const events = [], progress = [];
  await new Promise((resolve, reject) => {
    const handle = GM_xmlhttpRequest({ url: base + '/usnet/stream', onloadstart: () => events.push('start'),
      onreadystatechange: response => events.push(response.readyState), onprogress: response => progress.push(response.loaded),
      onload: response => { events.push('load'); assert.equal(response.responseText.length, 131072); }, onloadend: resolve, onerror: reject });
    assert.equal(typeof handle.abort, 'function'); assert.equal(handle.then, undefined);
  });
  assert.equal(events[0], 'start'); assert.deepEqual(events.filter(value => typeof value === 'number'), [1, 2, 3, 4]);
  assert.equal(events.at(-1), 'load'); assert.equal(progress.at(-1), 131072); assert.deepEqual(realm.errors, []);
});

test('request validation rejects forbidden targets, options, headers, redirects and oversized responses without retries', async t => {
  const { base, state } = await loopback(t), h = harness();
  const script = await h.enable(await h.save('Limited HTTP', '// @connect 127.0.0.1\n// @grant GM.xmlHttpRequest\n', 'globalThis.request = GM.xmlHttpRequest;'));
  const realm = h.realm(script.id), request = realm.context.request;
  for (const [details, expected] of [
    [{ url: 'https://outside.invalid/' }, /@connect/], [{ url: 'file:///private' }, /HTTP/],
    [{ url: base + '/usnet/json', headers: { Cookie: 'secret' } }, /header/],
    [{ url: base + '/usnet/json', method: 'TRACE' }, /method/],
    [{ url: base + '/usnet/json', data: 'GET body' }, /GET/],
    [{ url: base + '/usnet/json', responseType: 'stream' }, /responseType/],
    [{ url: base + '/usnet/json', timeout: -1 }, /timeout/]
  ]) await assert.rejects(request(details), expected);
  assert.equal(state.hits.length, 0);
  for (const name of ['Accept-Charset', 'Date', 'DNT', 'Expect', 'Set-Cookie', 'Permissions-Policy', 'X-HTTP-Method']) {
    await assert.rejects(request({ url: base + '/usnet/json', headers: { [name]: 'TRACE' } }), /header/);
  }
  assert.throws(() => request({ url: base, fetch: true }), /option/);
  await assert.rejects(request({ url: base + '/usnet/redirect', redirect: 'error' }), /Redirects are disabled/);
  assert.equal(state.hits.some(item => item.url === '/usnet/json'), false);
  await assert.rejects(request({ url: base + '/usnet/oversize' }), /size limit/);
  const metadata = core.parse(source('Scope', '// @connect self\n// @grant GM.xmlHttpRequest\n'));
  assert.throws(() => BlockAdsUserScriptNetwork.validate({ url: base }, metadata, 'https://example.test/'), /@connect/);
  assert.equal(BlockAdsUserScriptNetwork.validate({ url: 'https://example.test/', timeout: 999999 }, metadata, 'https://example.test/').timeout, 30000);
  assert.equal((await h.value(script.id, 'request', { requestId: '99', details: { url: base } })).ok, false, 'a forged message without a native connection cannot fetch');
});

test('redirects check every destination, rewrite POST correctly and strip cross-origin headers', async t => {
  const { base, state } = await loopback(t), h = harness();
  const script = await h.enable(await h.save('Redirects', '// @grant GM.xmlHttpRequest\n// @connect 127.0.0.1\n', 'globalThis.request = GM.xmlHttpRequest;'));
  const request = h.realm(script.id).context.request;
  state.sources = {
    '/usnet/other-host': { status: 302, headers: { Location: base.replace('127.0.0.1', 'localhost') + '/usnet/forbidden' }, body: '' },
    '/usnet/keep-body': { status: 307, headers: { Location: '/usnet/json' }, body: '' },
    '/usnet/loop': { status: 302, headers: { Location: '/usnet/loop' }, body: '' }
  };
  const first = await request({url:base+'/usnet/redirect',method:'POST',data:'original',responseType:'json'});
  assert.equal(first.response.method,'GET'); assert.equal(first.response.body,''); assert.equal(first.finalUrl,base+'/usnet/json');
  const kept = await request({url:base+'/usnet/keep-body',method:'POST',data:'original',responseType:'json'});
  assert.equal(kept.response.method,'POST'); assert.equal(kept.response.body,'original');
  await assert.rejects(request({url:base+'/usnet/other-host'}), /connect/);
  assert.equal(state.hits.some(h=>h.url==='/usnet/forbidden'), false);
  await assert.rejects(request({url:base+'/usnet/loop'}), /five redirects/);
  assert.equal(state.hits.filter(h=>h.url==='/usnet/loop').length,6);
  const network=BlockAdsUserScriptNetwork, meta=core.parse(source('redirect safety','// @connect *\n'));
  const original=network.validate({url:'https://one.test/start',method:'POST',body:btoa('data'),headers:{Authorization:'private','X-Test':'private','Content-Type':'text/plain'}},meta,'https://page.test/');
  const next=network.redirected(original,307,'https://two.test/end');
  assert.deepEqual(next.headers,{}); assert.equal(next.body,original.body); assert.equal(next.method,'POST');
  assert.throws(()=>network.redirected(original,302,'http://one.test/end'),/downgrade/);
  assert.throws(()=>network.redirected(original,302,'https://secret@two.test/end'),/credentials/);
});

test('HTTP user/password send Basic credentials that explicit headers override and cross-origin redirects drop', async t => {
  const { base, state } = await loopback(t), h = harness();
  const script = await h.enable(await h.save('Auth', '// @connect 127.0.0.1\n// @grant GM.xmlHttpRequest\n', 'globalThis.request = GM.xmlHttpRequest;'));
  const request = h.realm(script.id).context.request;
  await request({ url: base + '/usnet/json?basic', user: 'ünï', password: 'p:ss' });
  assert.equal(state.hits.at(-1).authorization, 'Basic ' + Buffer.from('ünï:p:ss').toString('base64'));
  await request({ url: base + '/usnet/json?password-only', password: 'secret' });
  assert.equal(state.hits.at(-1).authorization, 'Basic ' + Buffer.from(':secret').toString('base64'));
  await request({ url: base + '/usnet/json?explicit', user: 'ignored', password: 'x', headers: { authorization: 'Bearer local' } });
  assert.equal(state.hits.at(-1).authorization, 'Bearer local');
  await request({ url: base + '/usnet/json?empty', user: '', password: null });
  assert.equal(state.hits.at(-1).authorization, '');
  assert.throws(() => request({ url: base, user: 1 }), /strings/);
  const hits = state.hits.length;
  await assert.rejects(request({ url: base + '/usnet/json', user: 'a:b' }), /colon/);
  await assert.rejects(request({ url: base + '/usnet/json', password: 'x\n' }), /control/);
  await assert.rejects(request({ url: base + '/usnet/json', user: 'x'.repeat(1025) }), /1 KiB/);
  assert.equal(state.hits.length, hits, 'invalid credentials never reach the network');
  const network = BlockAdsUserScriptNetwork, meta = core.parse(source('auth redirect', '// @connect *\n'));
  const original = network.validate({ url: 'https://one.test/start', user: 'u', password: 'p' }, meta, 'https://page.test/');
  assert.equal(original.headers.Authorization, 'Basic dTpw');
  assert.equal(network.redirected(original, 302, '/next').headers.Authorization, 'Basic dTpw', 'same-origin redirects keep credentials');
  assert.deepEqual(network.redirected(original, 302, 'https://two.test/next').headers, {}, 'cross-origin redirects drop credentials');
});

test('ReadableStream request data is read within the upload limit and cancelled with its request', async t => {
  const { base, state } = await loopback(t), h = harness();
  const script = await h.enable(await h.save('Streams', '// @connect 127.0.0.1\n// @grant GM.xmlHttpRequest\n', 'globalThis.request = GM.xmlHttpRequest;'));
  const request = h.realm(script.id, 7, { globals: { ReadableStream } }).context.request;
  const chunks = (...parts) => new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(part); controller.close(); } });
  const echoed = await request({ url: base + '/usnet/json', method: 'POST', responseType: 'json',
    data: chunks(new TextEncoder().encode('stream '), new Uint8Array([0xe2, 0x9c, 0x93]), new DataView(new Uint8Array([0x21]).buffer)) });
  assert.equal(echoed.response.body, 'stream ✓!');
  const hits = state.hits.length;
  await assert.rejects(request({ url: base + '/usnet/json', method: 'POST', data: chunks('text chunk') }), /Uint8Array/);
  const quarter = new Uint8Array(2 * 1024 * 1024);
  await assert.rejects(request({ url: base + '/usnet/json', method: 'POST', data: chunks(quarter, quarter, quarter, quarter, new Uint8Array(1)) }), /8 MiB/);
  await assert.rejects(request({ url: base + '/usnet/json', data: chunks(new Uint8Array(1)) }), /GET/);
  let cancelled = 0;
  const handle = request({ url: base + '/usnet/json', method: 'POST', data: new ReadableStream({ pull: () => new Promise(() => {}), cancel: () => { cancelled++; } }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  handle.abort();
  await assert.rejects(handle, /aborted/);
  await waitFor(() => cancelled === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(state.hits.length, hits, 'rejected and aborted stream uploads never reach the network');
});

test('FormData preserves ordered duplicate fields, Unicode, filenames and binary bytes', async t => {
  const {base,state}=await loopback(t),h=harness();
  const script=await h.enable(await h.save('FormData','// @grant GM.xmlHttpRequest\n','globalThis.request=GM.xmlHttpRequest;'));
  const realm=h.realm(script.id),request=realm.context.request,form=new FormData();
  form.append('label','first ✓'); form.append('label','second'); form.append('file',new Blob([new Uint8Array([0,1,128,255])],{type:'application/octet-stream'}),'local.bin');
  const response=await request({url:base+'/usnet/multipart',method:'POST',data:form,responseType:'json'});
  assert.match(response.response.contentType,/^multipart\/form-data; boundary=/);
  const binary=Buffer.from(response.response.bodyBase64,'base64');
  assert.ok(binary.indexOf(Buffer.from('first ✓'))<binary.indexOf(Buffer.from('second')));
  assert.ok(binary.includes(Buffer.from('filename="local.bin"'))); assert.ok(binary.includes(Buffer.from([0,1,128,255])));
  const count=state.hits.length;
  await assert.rejects(request({url:base+'/usnet/multipart',method:'POST',data:form,headers:{'Content-Type':'multipart/form-data'}}),/boundary/);
  const oversized=new FormData(); oversized.append('file',new Blob([new Uint8Array(8388608)]),'too-big.bin');
  await assert.rejects(request({url:base+'/usnet/multipart',method:'POST',data:oversized}),/8 MiB/);
  assert.equal(state.hits.length,count);
  assert.throws(()=>request({url:base,upload:{onprogress:'bad'}}),/upload callbacks/);
  const result=await request({url:base+'/usnet/json',method:'POST',data:'x'.repeat(1100000),responseType:'json'});
  assert.equal(result.response.body.length,1100000);
});

test('larger Firefox downloads preserve exact bytes and release their shared buffer budget', async t => {
  const {base,state}=await loopback(t),{h,api}=await desktopRealm({firefox:true});
  const body=Buffer.alloc(3*1024*1024,173);state.sources={'/usnet/large-download':{body,mime:'application/octet-stream'}};
  const pending=api.GM.download(base+'/usnet/large-download','large.bin');
  await waitFor(()=>h.state.downloads.size===1);
  assert.deepEqual(Buffer.from(await (await fetch(h.state.downloads.get(1).url)).arrayBuffer()),body);
  completeDownload(h,1); const result=await pending;
  assert.equal(result.response.size,body.length);
  const releases=[];
  for(let i=0;i<4;i++){const release=BlockAdsUserScriptNetwork.reserve({},16*1024*1024);release.grow(16*1024*1024);releases.push(release);}
  assert.throws(()=>BlockAdsUserScriptNetwork.reserve({},1),/budget/);
  for(const release of releases){release();release();}
  const whole=BlockAdsUserScriptNetwork.reserve({},64*1024*1024);whole.grow(64*1024*1024);whole();
});
test('transfer budget grows with received bytes instead of reserving every response cap up front', () => {
  const { LIMITS, reserve } = BlockAdsUserScriptNetwork;
  // The documented 32 concurrent requests fit before any of them has a body.
  const held = []; let refused;
  try {
    for (let i = 0; i < 32; i++) held.push(reserve({}, LIMITS.response));
    const active = reserve({}, LIMITS.response); held.push(active);
    active.grow(5 * 1024 * 1024); active.grow(LIMITS.response); active.grow(LIMITS.response * 2);
    for (let i = 0; i < 16 && !refused; i++) {
      try { const release = reserve({}, LIMITS.download); held.push(release); release.grow(LIMITS.download); }
      catch (error) { refused = error; }
    }
  } finally { for (const release of held) release(); }
  assert.match(refused?.message || '', /64 MiB buffer budget/, 'growth past the shared budget is refused');
  const whole = reserve({}, LIMITS.budget); whole.grow(LIMITS.budget); whole();
});

test('native upload-progress XHR reserves the whole response before the transfer begins', () => {
  const { reserve, LIMITS } = BlockAdsUserScriptNetwork;
  const held = reserve({}, LIMITS.budget);
  try {
    held.grow(LIMITS.budget - LIMITS.response + 1);
    assert.throws(() => reserve({ upload: true }, LIMITS.response), /buffer budget/);
    reserve({ upload: false }, LIMITS.response)();
  } finally { held(); }
  reserve({ upload: true }, LIMITS.response)();
});

test('abort, timeout, port loss and module disable settle network promises once and release capacity', async t => {
  const { base, state } = await loopback(t), h = harness();
  const script = await h.enable(await h.save('Cancellation', '// @grant GM.xmlHttpRequest\n', 'globalThis.request = GM.xmlHttpRequest;'));
  let realm = h.realm(script.id), request = realm.context.request;
  let ended = 0;
  const early = request({ url: base + '/usnet/slow', onloadend: () => ended++ });
  const earlyRejected = assert.rejects(early, /aborted/); early.abort(); await earlyRejected; assert.equal(ended, 1);
  const timeoutEvents = [];
  await assert.rejects(request({ url: base + '/usnet/slow', timeout: 30, ontimeout: () => timeoutEvents.push('timeout'), onloadend: () => timeoutEvents.push('end') }), /timed out/);
  assert.deepEqual(timeoutEvents, ['timeout', 'end']);
  const slow = request({ url: base + '/usnet/slow' }), cancelled = assert.rejects(slow, /aborted/);
  await waitFor(() => state.hits.length >= 2); slow.abort(); await cancelled;
  const requests = Array.from({ length: 4 }, () => request({ url: base + '/usnet/slow' }));
  const outcomes = Promise.all(requests.map(promise => promise.then(() => 'load', error => error.message)));
  assert.throws(() => request({ url: base + '/usnet/json' }), /four/);
  await waitFor(() => state.hits.length >= 6);
  const controlStart = Date.now(); await h.host.setEnabled(false); assert.ok(Date.now() - controlStart < 1000, 'disable does not wait for slow HTTP');
  assert.ok((await outcomes).every(message => /closed/.test(message)));
  assert.throws(() => request({ url: base + '/usnet/json' }), /inactive/);
  await h.host.setEnabled(true); realm = h.realm(script.id, 8); request = realm.context.request;
  const disconnected = request({ url: base + '/usnet/slow' }), lost = assert.rejects(disconnected, /not retried/);
  await waitFor(() => state.hits.length >= 7); realm.ports[0].loseConnection(); await lost;
  const count = state.hits.length; await new Promise(resolve => setTimeout(resolve, 300)); assert.equal(state.hits.length, count, 'disconnect never resends a request');
  realm.event('pagehide');
});

test('Firefox redirect permission removal cancels an active transfer without replay', async t => {
  const { base, state } = await loopback(t), h = harness(undefined, { firefox: true, helperPermissions: ['webRequestBlocking', 'offscreen'] });
  const script = await h.enable(await h.save('Transfer permission', '// @grant GM.xmlHttpRequest\n', 'globalThis.request=GM.xmlHttpRequest;'));
  const request = h.realm(script.id).context.request; let ended = 0;
  const pending = request({ url: base + '/usnet/slow', onloadend: () => ended++ });
  const rejected = assert.rejects(pending, /abort/);
  await waitFor(() => state.hits.length === 1);
  h.state.helperPermissions.delete('offscreen'); h.state.hooks.removed({ permissions: ['offscreen'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 0, 'removing upload-only access does not cancel a normal fetch');
  h.state.helperPermissions.delete('webRequestBlocking'); h.state.hooks.removed({ permissions: ['webRequestBlocking'] });
  await rejected; await waitFor(() => state.aborted === 1);
  assert.equal(ended, 1); assert.equal(state.hits.length, 1);
});

test('include scopes form a union with matches; both exclusion forms win in the wrapper and broker', async () => {
  const h = harness(), script = await h.enable(await h.save('Globs', '// @include https://other.test/read*\n// @exclude *?private=*\n// @exclude-match https://other.test/read/secret*\n// @grant GM.getValue\n', 'globalThis.ran=true;'));
  const meta = core.parse(script.source);
  for (const url of ['https://example.test/a', 'https://other.test/read?q=ok#part']) assert.equal(core.allows(meta, url), true);
  for (const url of ['https://other.test/other', 'https://example.test/a?private=yes', 'https://other.test/read/secret', 'file:///read']) assert.equal(core.allows(meta, url), false);
  assert.deepEqual(h.state.scripts[0].matches, ['https://example.test/*']);
  assert.ok(h.state.scripts[0].includeGlobs.length, 'native prefilter avoids spending a world on unrelated pages');
  assert.equal(h.realm(script.id, 7, { sender: { url: 'https://other.test/other' } }).context.ran, undefined);
  assert.equal(h.realm(script.id, 7, { sender: { url: 'https://other.test/read' } }).context.ran, true);
  assert.equal((await h.value(script.id, 'get', { key: 'x' }, { ...h.sender(), url: 'https://other.test/other' })).ok, false);
  const includeOnly = core.parse(script.source.replace('// @match https://example.test/*\n', ''));
  assert.equal(core.allows(includeOnly, 'https://example.test/a'), false);
  assert.equal(core.allows(includeOnly, 'https://other.test/read'), true);
  assert.equal(core.allows(core.parse(source('Regex', '// @include /https?:.*/\n')), 'https://other.test/page'), true);
  const heavy = core.parse(source('Bounded', '// @include https://other.test/' + 'a*'.repeat(40) + 'b\n'));
  assert.equal(vm.runInNewContext('core.allows(heavy,url)', { core, heavy, url: 'https://other.test/' + 'a'.repeat(4096) + 'c' }, { timeout: 1000 }), false);
});

test('extended wrapper and broker checks agree, including oversized regex exclusions and stale navigation', async () => {
  const h = harness(); await h.ready;
  const rules = '// @match http*://api*.example.tld:8080/read*#good\n// @include /^https:\\/\\/example\\.test\\/regex/\n// @exclude /private/\n// @grant GM.getValue\n// @grant GM.registerMenuCommand\n';
  const saved = await h.command({ type: 'US_SAVE', source: source('Extended broker', rules, 'globalThis.ran=true;').replace('// @match https://example.test/*\n', '') });
  const script = await h.enable(saved.scripts.find(item => item.id === saved.selectedId));
  for (const [url, expected] of [['https://api-one.example.co.uk:8080/read#good', true], ['https://example.test/regex', true],
    ['https://api-one.example.co.uk:8081/read#good', false], ['https://api-one.example.co.uk:8080/read#bad', false],
    ['https://api-one.example.com.evil.invalid:8080/read#good', false], ['https://example.test/regex/private', false]]) {
    const from = { ...h.sender(), url };
    assert.equal(h.realm(script.id, 7, { sender: from }).context.ran === true, expected, url);
    assert.equal((await h.value(script.id, 'get', { key: 'probe' }, from)).ok, expected, url);
  }
  const realm = h.realm(script.id, 7, { sender: { url: 'https://example.test/regex' } });
  await eventually(() => realm.messages.some(item => item.type === 'ready'));
  h.state.hooks.tabUpdated(7, { url: 'https://example.test/regex/private' });
  await eventually(() => realm.messages.some(item => item.type === 'revoked'));
  const before = h.state.data.userscriptManager.scripts.length;
  await assert.rejects(h.command({ type: 'US_SAVE', source: source('Unsupported regex', '// @exclude /(a)\\1/i\n') }), /without flags/);
  assert.equal(h.state.data.userscriptManager.scripts.length, before);
  const heavySave = await h.command({ type: 'US_SAVE', source: source('Heavy exclusion', '// @exclude /(?:a?){128}b/\n// @grant GM.getValue\n', 'globalThis.ran=true;') });
  const heavy = await h.enable(heavySave.scripts.find(item => item.id === heavySave.selectedId));
  const url = 'https://example.test/' + 'a'.repeat(16000) + 'c';
  assert.equal(h.realm(heavy.id, 7, { sender: { url } }).context.ran, undefined);
  assert.equal((await h.value(heavy.id, 'get', { key: 'probe' }, { ...h.sender(), url })).ok, false);
});

test('broker denies stale top/subframe URLs, replaced documents and failed live scope probes', async () => {
  const h = harness(), script = await h.enable(await h.save('Current frame', '// @grant GM.getValue\n'));
  for (const frameId of [0, 3]) {
    const from = { ...h.sender(), frameId, documentId: 'original' }, key = '7:' + frameId;
    h.state.frames.set(key, { url: 'https://example.test/page', documentId: 'original' });
    assert.equal((await h.value(script.id, 'get', { key: 'x' }, from)).ok, true);
    h.state.frames.set(key, { url: 'https://other.test/page', documentId: 'original' });
    assert.equal((await h.value(script.id, 'get', { key: 'x' }, from)).ok, false, 'old native sender URL cannot authorize a new scope');
    h.state.frames.set(key, { url: 'https://example.test/page', documentId: 'replacement' });
    assert.equal((await h.value(script.id, 'get', { key: 'x' }, from)).ok, false, 'old document cannot borrow replacement frame scope');
    h.state.frames.set(key, { url: 'https://example.test/page', error: 'removed' });
    assert.equal((await h.value(script.id, 'get', { key: 'x' }, from)).ok, false);
  }
  h.state.faults.frameProbe = 1;
  assert.equal((await h.value(script.id, 'get', { key: 'x' })).ok, false);
});

test('a stalled frame probe releases manager controls, never authorizes later and does not accumulate probes', { timeout: 6000 }, async () => {
  let release, calls = 0;
  const h = harness(undefined, { frameProbe: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const script = await h.enable(await h.save('Unresponsive frame', '// @grant GM.setValue\n'));
  const pending = h.value(script.id, 'set', { key: 'late', value: true });
  await eventually(() => calls === 1);
  const list = h.command({ type: 'US_LIST' });
  const result = await pending; assert.equal(result.ok, false); assert.match(result.error, /timed out/);
  assert.equal((await list).scripts.length, 1, 'manager controls proceed after the deadline');
  assert.equal((await h.value(script.id, 'set', { key: 'late', value: true })).ok, false);
  assert.equal(calls, 1, 'no second native injection while the timed-out call remains unresolved');
  release([{ frameId: 0, result: 'https://example.test/page' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.data.userscriptManager.scripts[0].values.late, undefined, 'late result cannot perform the expired write');
  await h.host.setEnabled(false);
});

test('native glob prefilter preserves match scopes and is a superset for literal query and fragment globs', () => {
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source('Prefilter', '// @include https://other.test/read?literal=yes#part\n')
    .replace('https://example.test/*', '*://*.example.test/path*') };
  const meta = core.parse(record.source), registration = core.registration(record);
  assert.deepEqual(registration.matches, ['*://*.example.test/path*']);
  const nativeGlob = (glob, url) => new RegExp('^' + glob.split('*').map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('?', '.')).join('.*') + '$').test(url);
  const url = 'https://other.test/read?literal=yes#part';
  assert.equal(core.allows(meta, url), true);
  assert.ok(registration.includeGlobs.some(glob => nativeGlob(glob, url)));
  assert.equal(registration.includeGlobs.some(glob => nativeGlob(glob, 'https://unrelated.test/page')), false);
});

test('include-only native registration satisfies Chromium without granting scope to its reserved placeholder', () => {
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source('Only include', '// @include https://example.test/included*\n', 'globalThis.ran=true;')
    .replace('// @match https://example.test/*\n', '') };
  const registration = core.registration(record);
  assert.equal(registration.matches.length, 1);
  assert.equal(core.allows(core.parse(record.source), registration.matches[0]), false);
  const context = vm.createContext({ URL, location: { href: registration.matches[0] } });
  inject(registration, context);
  assert.equal(context.ran, undefined);
  assert.equal(core.allows(core.parse(record.source), 'https://example.test/included-page'), true);
});

test('missing native messaging fails closed before a privileged source body runs', () => {
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source('No native world', '// @grant GM_getValue\n', 'globalThis.ran=true;') };
  const errors = [], context = vm.createContext({ URL, location: { href: 'https://example.test/page' }, chrome: { runtime: {} }, console: { error: (...args) => errors.push(args.map(String).join(' ')) } });
  inject(core.registration(record), context);
  assert.equal(context.ran, undefined);
  assert.ok(errors.some(error => error.includes('10 isolated script worlds')));
});

test('legacy reads are synchronous after hydration; ordered writes and bulk defaults survive reload', async () => {
  const h = harness(), script = await h.enable(await h.save('Legacy', compatibilityGrants, expose));
  await h.value(script.id, 'set', { key: 'saved', value: { n: 3 } });
  const realm = h.realm(script.id); assert.equal(realm.context.testAPI, undefined, 'source waits for the persisted snapshot');
  await eventually(() => realm.context.testAPI);
  const api = realm.context.testAPI;
  assert.deepEqual(json(api.GM_getValue('saved')), { n: 3 });
  assert.equal(api.GM_getValue('saved') instanceof Promise, false);
  const detached = api.GM_getValue('saved'); detached.n = 99;
  assert.equal(api.GM_getValue('saved').n, 3, 'reads do not expose the cache by reference');
  assert.equal(api.GM_setValue('counter', 1), undefined);
  assert.equal(api.GM_getValue('counter'), 1, 'legacy read-your-writes');
  api.GM_setValue('counter', 2);
  await api.GM.setValues({ other: false, counter: 3 });
  assert.equal(await api.GM.getValue('counter'), 3);
  assert.deepEqual(json(api.GM_getValues({ counter: 0, absent: 'fallback' })), { counter: 3, absent: 'fallback' });
  assert.deepEqual(json(await api.GM.getValues(['other', 'missing'])), { other: false });
  assert.ok(Object.hasOwn(api.GM_getValues({ missing: undefined }), 'missing'));
  assert.equal((await api.GM.getValues({ missing: undefined })).missing, undefined);
  await api.GM.deleteValues(['counter', 'other']);
  assert.deepEqual(json(api.GM_listValues()), ['saved']);
  const reloaded = h.realm(script.id, 8); await eventually(() => reloaded.context.testAPI);
  assert.deepEqual(json(reloaded.context.testAPI.GM_getValues()), { saved: { n: 3 } });
  assert.deepEqual(realm.errors, []);
});

test('value listeners distinguish local and remote commits, deletes, no-ops and removal', async () => {
  const h = harness(), script = await h.enable(await h.save('Listeners', compatibilityGrants, expose));
  const first = h.realm(script.id, 7), second = h.realm(script.id, 8);
  await eventually(() => first.context.testAPI && second.context.testAPI);
  const a = first.context.testAPI, b = second.context.testAPI, local = [], remote = [];
  a.GM_addValueChangeListener('x', (...args) => local.push(args));
  const listener = b.GM.addValueChangeListener('x', (...args) => remote.push(args));
  a.GM_setValue('x', 1); assert.deepEqual(local, [['x', undefined, 1, false]]);
  await a.GM.getValue('x'); await eventually(() => remote.length === 1);
  assert.deepEqual(remote, [['x', undefined, 1, true]]);
  assert.equal(b.GM_getValue('x'), 1);
  await a.GM.setValue('x', 1); assert.equal(local.length, 1); assert.equal(remote.length, 1);
  await a.GM.deleteValue('x'); await eventually(() => remote.length === 2);
  assert.deepEqual(remote[1], ['x', 1, undefined, true]);
  b.GM_removeValueChangeListener(listener);
  await a.GM.setValue('x', 2); assert.equal(remote.length, 2);
  assert.equal(b.GM_getValue('x'), 2, 'cache still follows commits after removing a listener');
});

test('failed value persistence rolls back optimistic reads and never notifies other tabs', async () => {
  const h = harness(), script = await h.enable(await h.save('Rollback values', compatibilityGrants, expose));
  const first = h.realm(script.id), second = h.realm(script.id, 8);
  await eventually(() => first.context.testAPI && second.context.testAPI);
  const a = first.context.testAPI, b = second.context.testAPI, remote = [];
  b.GM_addValueChangeListener('x', (...args) => remote.push(args));
  for (const fault of ['save', 'afterSave']) {
    h.state.faults[fault] = 1;
    await assert.rejects(a.GM.setValue('x', 10), /Injected/);
    assert.equal(a.GM_getValue('x'), undefined);
    assert.equal((await h.value(script.id, 'get', { key: 'x' })).exists, false);
    assert.deepEqual(remote, []);
  }
  h.state.faults.save = 1; a.GM_setValue('x', 20);
  await eventually(() => first.errors.length === 1);
  assert.equal(a.GM_getValue('x'), undefined, 'void legacy writes report failures and undo the cache');
});

test('a delayed write acknowledgement cannot overwrite a newer remote value or mislabel its listener', async () => {
  const h = harness(), script = await h.enable(await h.save('Acknowledgement order', compatibilityGrants, expose));
  let release, held = false;
  const gate = new Promise(resolve => { release = resolve; });
  const first = h.realm(script.id, 7, { reply: (reply, message) => {
    if (message.operation === 'set') { held = true; return gate.then(() => reply); } return reply;
  } }), second = h.realm(script.id, 8);
  await eventually(() => first.context.testAPI && second.context.testAPI);
  const a = first.context.testAPI, b = second.context.testAPI, changes = [];
  a.GM_addValueChangeListener('x', (...args) => changes.push(args));
  const write = a.GM.setValue('x', 1); await eventually(() => held);
  await b.GM.setValue('x', 2); release(); await write;
  assert.equal(a.GM_getValue('x'), 2);
  assert.deepEqual(changes, [['x', undefined, 1, false], ['x', 1, 2, true]]);
});

test('reentrant listener writes keep their order and callback failures do not swallow other listeners', async () => {
  const h = harness(), script = await h.enable(await h.save('Reentrant', compatibilityGrants, expose));
  const realm = h.realm(script.id); await eventually(() => realm.context.testAPI);
  const a = realm.context.testAPI, observed = [];
  a.GM_addValueChangeListener('x', (_key, _old, value) => { if (value === 1) a.GM_setValue('x', 2); });
  a.GM_addValueChangeListener('x', () => { throw new Error('Fixture listener error'); });
  a.GM_addValueChangeListener('x', (_key, _old, value) => observed.push(value));
  a.GM_setValue('x', 1);
  assert.equal(await a.GM.getValue('x'), 2);
  assert.equal(a.GM_getValue('x'), 2);
  assert.ok(observed.includes(1) && observed.includes(2));
  assert.ok(realm.errors.every(error => error.includes('Fixture listener error')));
});

test('native channel reconnection hydrates values and republishes menus without rerunning source', async () => {
  const h = harness(), script = await h.enable(await h.save('Reconnect', compatibilityGrants, expose + 'globalThis.runs=(globalThis.runs||0)+1;'));
  const realm = h.realm(script.id); await eventually(() => realm.context.testAPI);
  const api = realm.context.testAPI;
  api.GM_registerMenuCommand('Resume', () => {}, { autoClose: false });
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length);
  realm.event('pagehide', { persisted: true });
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
  await h.value(script.id, 'set', { key: 'away', value: 9 });
  realm.event('pageshow', { persisted: true });
  await eventually(() => api.GM_getValue('away') === 9);
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length);
  assert.equal(realm.context.runs, 1);
  // A native worker disconnect follows the same reconnect path without a page event.
  realm.ports.at(-1).loseConnection();
  await new Promise(resolve => setTimeout(resolve, 300));
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length);
  assert.equal(realm.context.runs, 1);
  h.state.granted = false; await h.host.start();
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
  assert.ok(realm.errors.some(error => error.includes('inactive')));
});

test('bulk writes are atomic, prototype-safe and require the specific declared grant', async () => {
  const h = harness(), script = await h.enable(await h.save('Bulk', compatibilityGrants, expose));
  assert.equal((await h.value(script.id, 'setMany', { values: JSON.parse('{"__proto__":{"safe":true},"constructor":5}') })).ok, true);
  const result = await h.value(script.id, 'getMany');
  assert.deepEqual(result.values, JSON.parse('{"__proto__":{"safe":true},"constructor":5}'));
  const before = clone(h.state.data);
  for (const values of [{ good: 1, bad: NaN }, { good: 1, huge: 'x'.repeat(65536) }, Object.fromEntries(Array.from({ length: 257 }, (_, i) => ['k' + i, i]))]) {
    assert.equal((await h.value(script.id, 'setMany', { values })).ok, false); assert.deepEqual(h.state.data, before);
  }
  const single = await h.enable(await h.save('Single grant', '// @grant GM.setValue\n'));
  assert.equal((await h.value(single.id, 'setMany', { values: { x: 1 } })).ok, false);
  assert.equal((await h.value(single.id, 'getMany')).ok, false);
});

test('menus update and unregister in their native tab, reject forged sessions, and expire on disable', async () => {
  const h = harness(), script = await h.enable(await h.save('Menus', compatibilityGrants, expose));
  const realm = h.realm(script.id); await eventually(() => realm.context.testAPI);
  const api = realm.context.testAPI, invoked = [];
  const id = api.GM_registerMenuCommand('<img> Settings', event => invoked.push(event.ctrlKey), { id: 'settings', title: 'Local settings', autoClose: false });
  let commands;
  await eventually(async () => { commands = (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands; return commands.length; });
  assert.equal(id, 'settings'); assert.equal(commands[0].caption, '<img> Settings');
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 8 })).commands, []);
  const invoke = { type: 'US_MENU_RUN', tabId: 7, connectionId: commands[0].connectionId, menuId: id, event: { ctrlKey: true } };
  assert.equal((await h.command(invoke)).autoClose, false); await eventually(() => invoked.length);
  assert.deepEqual(invoked, [true]);
  await assert.rejects(h.command({ ...invoke, tabId: 8 }), /expired/);
  const forged = await h.value(script.id, 'menus', { connectionId: commands[0].connectionId, menus: [] }, { ...h.sender(), tab: { id: 8 } });
  assert.equal(forged.ok, false);
  api.GM.registerMenuCommand('Updated', () => {}, { id, autoClose: false });
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands[0]?.caption === 'Updated');
  api.GM_unregisterMenuCommand(id);
  await eventually(async () => !(await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length);
  api.GM_registerMenuCommand('Again', () => {}, { id });
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length);
  await h.host.setEnabled(false);
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
  await assert.rejects(h.command(invoke), /expired/);
  assert.equal((await h.value(script.id, 'get', { key: 'x' })).ok, false);
});

test('document-body waits once and document-start without a storage snapshot stays immediate', async () => {
  const h = harness(), script = await h.enable(await h.save('Body', '// @run-at document-body\n', 'globalThis.runs=(globalThis.runs||0)+1;'));
  assert.equal(h.state.scripts[0].runAt, 'document_start');
  let callback, disconnected = 0;
  const document = { body: null }, realm = h.realm(script.id, 7, { globals: { document,
    MutationObserver: class { constructor(cb) { callback = cb; } observe() {} disconnect() { disconnected++; } } } });
  assert.equal(realm.context.runs, undefined); document.body = {}; callback(); callback();
  assert.equal(realm.context.runs, 1); assert.ok(disconnected > 0);
  const start = await h.enable(await h.save('Start', '// @run-at document-start\n', 'globalThis.immediate=true;'));
  assert.equal(h.realm(start.id).context.immediate, true);
});

test('native subscriptions reject other worlds, frames and excluded URLs before exposing saved values', async () => {
  const h = harness(), script = await h.enable(await h.save('Channel scope', compatibilityGrants + '// @noframes\n// @exclude https://example.test/private*\n', expose));
  for (const sender of [{ id: 'other' }, { frameId: 1 }, { userScriptWorldId: core.nativeId(crypto.randomUUID()) }, { url: 'https://example.test/private' }]) {
    const realm = h.realm(script.id, 7, { sender });
    if (sender.url) assert.equal(realm.ports.length, 0, 'wrapper rejects excluded URL before connecting');
    else await eventually(() => realm.errors.length);
    assert.equal(realm.context.testAPI, undefined);
  }
  const realm = h.realm(script.id); await eventually(() => realm.context.testAPI);
  realm.context.testAPI.GM_registerMenuCommand('Allowed', () => {});
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length);
  h.state.hooks.tabUpdated(7, { url: 'https://example.test/private' });
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
  assert.ok(realm.errors.some(error => error.includes('inactive')));
});

test('menu-only scripts run immediately, publish after connection, and enforce bounded command storage', async () => {
  const h = harness(), script = await h.enable(await h.save('Only menus', '// @grant GM.registerMenuCommand\n// @grant GM.unregisterMenuCommand\n',
    'globalThis.GMAPI=GM; GM.registerMenuCommand("Early",()=>{}, {id:"early"}); globalThis.ran=true;'));
  const realm = h.realm(script.id); assert.equal(realm.context.ran, true);
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length === 1);
  const api = realm.context.GMAPI;
  for (let i = 1; i < 32; i++) api.registerMenuCommand('Command ' + i, () => {});
  assert.throws(() => api.registerMenuCommand('Overflow', () => {}), /32 menu/);
  api.unregisterMenuCommand('early'); api.registerMenuCommand('Replacement', () => {});
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length === 32);
  assert.equal(api.getValue, undefined);
  h.state.hooks.tabRemoved(7);
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
});

test('native connection floods cannot reserve control capacity or keep disabled capabilities alive', async () => {
  const h = harness(), script = await h.enable(await h.save('Connection pressure', compatibilityGrants, expose));
  const realms = Array.from({ length: 32 }, () => h.realm(script.id));
  await h.host.setEnabled(false);
  await eventually(() => realms.every(realm => realm.errors.length));
  assert.ok(realms.filter(realm => realm.context.testAPI).length <= 1);
  assert.deepEqual(h.state.scripts, []);
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
});

test('many matching legacy scripts can hydrate together without consuming ordinary GM request slots', async () => {
  const h = harness(), scripts = [];
  for (let i = 0; i < 12; i++) scripts.push(await h.enable(await h.save('Hydrate ' + i, '// @grant GM_getValue\n// @grant GM_registerMenuCommand\n',
    'globalThis.initial=GM_getValue("missing",42); GM_registerMenuCommand("Ready",()=>{});')));
  const realms = scripts.map(script => h.realm(script.id));
  await eventually(() => realms.every(realm => realm.context.initial === 42));
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands.length === 12);
  assert.ok(realms.every(realm => realm.errors.length === 0));
});

test('menu changes coalesce while a native publication acknowledgement is pending', async () => {
  const h = harness(), script = await h.enable(await h.save('Menu updates', compatibilityGrants, expose));
  let release, publications = 0;
  const realm = h.realm(script.id, 7, { reply: (response, message) => {
    if (message.operation === 'menus' && ++publications === 1) return new Promise(resolve => { release = () => resolve(response); });
    return response;
  } });
  await eventually(() => release && realm.context.testAPI);
  for (let i = 0; i < 20; i++) {
    realm.context.testAPI.GM_registerMenuCommand('Version ' + i, () => {}, { id: 'same' });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(publications, 1, 'only one request is in flight per native connection');
  release();
  await eventually(async () => (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands[0]?.caption === 'Version 19');
  assert.equal(publications, 2, 'the latest complete menu replaces intermediate updates');
  assert.deepEqual(realm.errors, []);
});

test('menu traffic has bounded native admission, preserves value slots, and yields to disable', async () => {
  const h = harness(), script = await h.enable(await h.save('Menu pressure', compatibilityGrants,
    expose + ' GM_registerMenuCommand("Ready",()=>{});'));
  const realms = Array.from({ length: 12 }, () => h.realm(script.id));
  let commands;
  await eventually(async () => { commands = (await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands; return commands.length === 12; });
  await new Promise(resolve => setImmediate(resolve));
  const read = h.api.storage.local.get;
  let release, entered = false;
  const gate = new Promise(resolve => { release = resolve; });
  h.api.storage.local.get = async (...args) => { if (!entered) { entered = true; await gate; } return read(...args); };
  const publish = index => h.value(script.id, 'menus', { connectionId: commands[index].connectionId, menus: [] }, realms[index].from);
  const first = publish(0); await eventually(() => entered);
  assert.match((await publish(0)).error, /pending script menu/);
  const waiting = commands.slice(1).map((_, index) => publish(index + 1));
  const reads = Array.from({ length: 8 }, () => h.value(script.id, 'get', { key: 'saved' }, realms[0].from));
  assert.match((await h.value(script.id, 'get', { key: 'overflow' }, realms[0].from)).error, /pending GM storage/);
  const disable = h.host.setEnabled(false);
  release();
  assert.equal((await first).ok, true, 'active publication finishes before disable');
  await disable;
  assert.ok((await Promise.all([...waiting, ...reads])).every(response => !response.ok && /inactive|expired/.test(response.error)));
  assert.deepEqual((await h.command({ type: 'US_MENU_LIST', tabId: 7 })).commands, []);
});

test('document-body observer cancels on pagehide and resumes once on back-forward cache restore', async () => {
  const h = harness(), script = await h.enable(await h.save('Body lifecycle', '// @run-at document-body\n', 'globalThis.runs=(globalThis.runs||0)+1;'));
  let callback, observed = 0, disconnected = 0;
  const document = { body: null }, realm = h.realm(script.id, 7, { globals: { document,
    MutationObserver: class { constructor(cb) { callback = cb; } observe() { observed++; } disconnect() { disconnected++; } } } });
  realm.event('pagehide', { persisted: true }); callback(); assert.equal(realm.context.runs, undefined); assert.equal(disconnected, 1);
  realm.event('pageshow', { persisted: true }); assert.equal(observed, 2);
  document.body = {}; callback(); assert.equal(realm.context.runs, 1);
  realm.event('pagehide', { persisted: true }); realm.event('pageshow', { persisted: true }); assert.equal(realm.context.runs, 1);
});

test('synthetic or duplicate pageshow does not replace a live channel or rerun source', async () => {
  const h = harness(), script = await h.enable(await h.save('Single channel', compatibilityGrants, expose + 'globalThis.runs=(globalThis.runs||0)+1;'));
  const r = h.realm(script.id); await eventually(() => r.context.testAPI);
  try {
    r.event('pageshow', { persisted: true, isTrusted: false });
    r.event('pageshow', { persisted: true });
    assert.equal(r.ports.length, 1);
    r.event('pagehide', { isTrusted: false });
    await r.context.testAPI.GM.setValue('alive', 1);
    assert.equal(r.context.runs, 1);
  } finally { r.event('pagehide'); }
});

test('navigation invalidates queued writes and late replies without replay after restoration', async () => {
  const h = harness(), script = await h.enable(await h.save('Queued lifecycle', '// @grant GM_getValue\n// @grant GM.setValue\n', 'globalThis.life={read:GM_getValue,write:GM.setValue};globalThis.runs=(globalThis.runs||0)+1;'));
  let finish;
  const r = h.realm(script.id, 7, { reply: (response, message) => message.operation === 'set' && message.key === 'first'
    ? new Promise(resolve => { finish = () => resolve(response); }) : response });
  await eventually(() => r.context.life);
  const result = Promise.allSettled([r.context.life.write('first', 1), r.context.life.write('queued', 2)]);
  try {
    await eventually(() => finish);
    r.event('pagehide', { persisted: true }); r.event('pageshow', { persisted: true });
    finish();
    assert.deepEqual((await result).map(item => item.status), ['fulfilled', 'rejected'], 'preserve submitted success; cancel the unsent queued mutation');
    assert.equal((await h.value(script.id, 'get', { key: 'queued' })).exists, false);
    await eventually(() => r.context.life.read('first') === 1);
    assert.equal(r.context.life.read('queued'), undefined, 'canceled optimistic patches do not overlay the resumed snapshot');
    assert.equal(r.context.runs, 1);
  } finally { finish?.(); r.event('pagehide'); }
});

test('pagehide clears a pending channel timeout and a queued old timeout cannot stop the resumed channel', async () => {
  const h = harness(), script = await h.enable(await h.save('Pending channel', '// @grant GM_getValue\n// @grant GM.setValue\n', 'globalThis.life={read:GM_getValue,write:GM.setValue};'));
  const timers = new Set();
  const r = h.realm(script.id, 7, { globals: { setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: callback => timers.delete(callback) } });
  const oldTimeout = [...timers][0]; assert.ok(oldTimeout);
  try {
    r.event('pagehide', { persisted: true }); assert.equal(timers.size, 0);
    r.event('pageshow', { persisted: true }); await eventually(() => r.context.life);
    oldTimeout(); await r.context.life.write('after', 1);
    assert.equal((await h.value(script.id, 'get', { key: 'after' })).value, 1);
  } finally { r.event('pagehide'); }
});

test('exhausting native reconnect attempts releases a waiting document-body observer', async () => {
  const h = harness(), script = await h.enable(await h.save('Reconnect cleanup', '// @run-at document-body\n// @grant GM.registerMenuCommand\n', 'globalThis.runs=(globalThis.runs||0)+1;'));
  h.state.hooks.connect = () => {}; // Transport exists but never delivers ready.
  const timers = new Map(); let mutation, disconnected = 0;
  const document = { body: null };
  const r = h.realm(script.id, 7, { globals: { document,
    setTimeout: (callback, delay) => { timers.set(callback, delay); return callback; }, clearTimeout: callback => timers.delete(callback),
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() { disconnected++; } } } });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      r.ports.at(-1).loseConnection(); await new Promise(setImmediate);
      if (attempt < 3) { const [callback, delay] = [...timers][0]; assert.equal(delay, 250 * 2 ** attempt); timers.delete(callback); callback(); }
    }
    assert.equal(r.ports.length, 4); assert.equal(timers.size, 0); assert.equal(disconnected, 1);
    document.body = {}; mutation(); assert.equal(r.context.runs, undefined);
    assert.ok(r.errors.some(error => error.includes('connection lost')));
  } finally { r.event('pagehide'); }
});
for (const action of ['module', 'script', 'delete']) test('GM flood cannot block ' + action + ' shutdown', async () => {
  const h = harness(), script = await h.enable(await h.save('Flood', '// @grant GM.getValue\n'));
  const oldToken = h.state.data.userscriptManager.scripts[0].token;
  const requests = Array.from({ length: 100 }, () => h.value(script.id, 'get', { key: 'value' }));
  if (action === 'module') await h.host.setEnabled(false);
  else await h.host.request({ type: action === 'delete' ? 'US_DELETE' : 'US_ENABLE',
    id: script.id, revision: script.revision, enabled: false });
  const replies = await Promise.all(requests);
  assert.ok(replies.filter(reply => reply.ok).length <= 1, 'shutdown runs before the queued GM backlog');
  assert.deepEqual(h.state.scripts, []);
  const saved = h.state.data.userscriptManager.scripts[0];
  if (action === 'delete') assert.equal(saved, undefined);
  else {
    assert.equal(action === 'module' ? h.state.data.userscriptManager.enabled : saved.enabled, false);
    assert.notEqual(saved.token, oldToken);
  }
  assert.equal((await h.value(script.id, 'get', { key: 'value', token: oldToken })).ok, false);
});
test('GM backpressure applies across scripts and frames in the same native tab', async () => {
  const h = harness(), scripts = [];
  for (let i = 0; i < 9; i++) scripts.push(await h.enable(await h.save('Tab ' + i, '// @grant GM.getValue\n')));
  const replies = await Promise.all(scripts.map((script, frameId) =>
    h.value(script.id, 'get', { key: 'x' }, { ...h.sender(), frameId })));
  assert.equal(replies.filter(reply => reply.ok).length, 8);
  assert.match(replies[8].error, /pending GM storage/);
  assert.equal((await h.value(scripts[8].id, 'get', { key: 'x' })).ok, true, 'completed requests release tab capacity');
});
test('GM backpressure follows a script across native tabs and releases failed requests', async () => {
  const h = harness(), script = await h.enable(await h.save('Many tabs', '// @grant GM.getValue\n'));
  h.state.faults.read = 1;
  const replies = await Promise.all(Array.from({ length: 17 }, (_, id) =>
    h.value(script.id, 'get', { key: 'x' }, { ...h.sender(), tab: { id } })));
  assert.equal(replies.filter(reply => reply.ok).length, 15);
  assert.match(replies[0].error, /Injected read/);
  assert.match(replies[16].error, /pending GM storage/);
  assert.equal((await h.value(script.id, 'get', { key: 'x' })).ok, true);
});
test('global GM backpressure reserves status and shutdown capacity across many tabs', async () => {
  const h = harness(), scripts = [];
  for (let i = 0; i < 9; i++) scripts.push(await h.enable(await h.save('Global ' + i, '// @grant GM.getValue\n')));
  let completed = 0;
  const requests = scripts.flatMap((script, id) => Array.from({ length: 8 }, () =>
    h.value(script.id, 'get', { key: 'x' }, { ...h.sender(), tab: { id } }).then(reply => {
      if (reply.ok) completed++; return reply;
    })));
  assert.equal((await h.host.state()).active, true);
  assert.ok(completed <= 1, 'status takes priority over the GM backlog');
  await h.host.setEnabled(false);
  const replies = await Promise.all(requests);
  assert.equal(replies.filter(reply => /pending GM storage/.test(reply.error || '')).length, 8);
  assert.equal(h.state.data.userscriptManager.enabled, false);
  assert.deepEqual(h.state.scripts, []);
});
test('malformed storage messages do not take valid request capacity', async () => {
  const h = harness(), script = await h.enable(await h.save('Admission', '// @grant GM.getValue\n'));
  const bad = Array.from({ length: 100 }, () => h.value(script.id, 'UPDATE_SETTINGS', { enabled: false }));
  const good = Array.from({ length: 8 }, () => h.value(script.id, 'get', { key: 'x' }));
  assert.ok((await Promise.all(bad)).every(reply => !reply.ok));
  assert.ok((await Promise.all(good)).every(reply => reply.ok));
});
test('shutdown waits for the active write, preserves it, and rejects queued old capabilities', { timeout: 5000 }, async () => {
  const h = harness(), script = await h.enable(await h.save('In flight', '// @grant GM.setValue\n// @grant GM.getValue\n'));
  const oldToken = h.state.data.userscriptManager.scripts[0].token;
  const originalSet = h.api.storage.local.set;
  let signal, release, held = false;
  const entered = new Promise(resolve => { signal = resolve; }), gate = new Promise(resolve => { release = resolve; });
  h.api.storage.local.set = async patch => {
    if (!held && patch.userscriptManager.scripts[0]?.values.inFlight === 42) {
      held = true; signal(); await gate;
    }
    return originalSet(patch);
  };
  const active = h.value(script.id, 'set', { key: 'inFlight', value: 42 });
  await entered;
  const queued = Array.from({ length: 20 }, () => h.value(script.id, 'set', { key: 'late', value: true }));
  let stopped = false;
  const shutdown = h.host.setEnabled(false).then(result => { stopped = true; return result; });
  try {
    await Promise.resolve();
    assert.equal(stopped, false, 'an in-flight write is never raced by a separate management writer');
  } finally { release(); }
  assert.equal((await active).ok, true); await shutdown;
  assert.ok((await Promise.all(queued)).every(reply => !reply.ok));
  const saved = h.state.data.userscriptManager.scripts[0];
  assert.deepEqual(saved.values, { inFlight: 42 });
  assert.notEqual(saved.token, oldToken);
  await h.host.setEnabled(true);
  assert.equal((await h.value(script.id, 'get', { key: 'inFlight', token: oldToken })).ok, false);
  assert.equal((await h.value(script.id, 'get', { key: 'inFlight' })).value, 42);
});
test('failed shutdown restores the old capability and allows a clean retry under GM load', async () => {
  const h = harness(), script = await h.enable(await h.save('Rollback flood', '// @grant GM.getValue\n'));
  const oldToken = h.state.data.userscriptManager.scripts[0].token;
  h.state.faults.save = 1;
  const requests = Array.from({ length: 8 }, () => h.value(script.id, 'get', { key: 'x' }));
  await assert.rejects(h.host.setEnabled(false), /not applied/);
  assert.equal(h.state.data.userscriptManager.enabled, true);
  assert.equal(h.state.data.userscriptManager.scripts[0].token, oldToken);
  assert.equal(h.state.scripts.length, 1);
  assert.ok((await Promise.all(requests)).every(reply => reply.ok));
  await h.host.setEnabled(false);
  assert.equal(h.state.data.userscriptManager.enabled, false);
  assert.deepEqual(h.state.scripts, []);
});
test('control FIFO order and capability revocation survive immediate disable and re-enable', async () => {
  const h = harness(), script = await h.enable(await h.save('Transitions', '// @grant GM.getValue\n'));
  const oldToken = h.state.data.userscriptManager.scripts[0].token;
  const requests = Array.from({ length: 100 }, () => h.value(script.id, 'get', { key: 'x' }));
  const disable = h.host.setEnabled(false), enable = h.host.setEnabled(true);
  await Promise.all([disable, enable]);
  assert.equal(h.state.data.userscriptManager.enabled, true);
  assert.equal(h.state.scripts.length, 1);
  assert.ok((await Promise.all(requests)).filter(reply => reply.ok).length <= 1);
  assert.equal((await h.value(script.id, 'get', { key: 'x', token: oldToken })).ok, false);
  assert.equal((await h.value(script.id, 'get', { key: 'x' })).ok, true);
});
test('old auto scripts stay isolated until individually re-enabled, including across module toggles', async () => {
  const id = crypto.randomUUID(), sourceCode = source('Old auto', '// @inject-into auto\n// @grant GM.getValue\n');
  const h = harness({ userscriptManager: { schemaVersion: 1, revision: 1, enabled: true, scripts: [
    { id, revision: 1, enabled: true, source: sourceCode, token: 'a'.repeat(64), values: { kept: 7 } }
  ] } });
  let view = await h.command({ type: 'US_LIST' });
  assert.equal(view.scripts[0].autoPageApproved, false);
  assert.equal(h.state.scripts.length, 1); assert.equal(h.state.scripts[0].world, 'USER_SCRIPT');
  await h.host.setEnabled(false); await h.host.setEnabled(true);
  assert.equal(h.state.scripts.length, 1); assert.equal(h.state.scripts[0].world, 'USER_SCRIPT');
  view = await h.command({ type: 'US_ENABLE', id, revision: 1, enabled: true });
  assert.equal(view.scripts[0].autoPageApproved, true);
  assert.deepEqual(h.state.scripts.map(s => s.world), ['MAIN', 'USER_SCRIPT']);
  assert.equal(h.state.worlds.length, 1);
  assert.deepEqual(h.state.data.userscriptManager.scripts[0].values, { kept: 7 });
  view = await h.command({ type: 'US_SAVE', id, revision: view.scripts[0].revision, source: sourceCode });
  assert.equal(view.scripts[0].enabled, false); assert.equal(view.scripts[0].autoPageApproved, false);
});
test('page relay registrations preserve native authorization, live scope and capability revocation', async () => {
  const h = harness(), script = await h.enable(await h.save('Page grants', '// @inject-into page\n// @grant GM.getValue\n'));
  assert.deepEqual(h.state.scripts.map(s => s.world), ['MAIN', 'USER_SCRIPT']);
  assert.deepEqual(h.state.worlds.map(w => w.messaging), [true]);
  assert.equal((await h.value(script.id, 'get', { key: 'x' }, { ...h.sender(), userScriptWorldId: core.nativeId(script.id) })).ok, true);
  assert.equal((await h.value(script.id, 'get', { key: 'x' }, { ...h.sender(), userScriptWorldId: 'MAIN' })).ok, false);
  assert.equal((await h.value(script.id, 'set', { key: 'x', value: 1 })).ok, false);
  const token = h.state.data.userscriptManager.scripts[0].token;
  assert.ok(!h.state.scripts[0].js.some(entry => entry.code.includes(token)));
  h.state.frames.set('7:0', { url: 'https://outside.invalid/' });
  assert.equal((await h.value(script.id, 'get', { key: 'x' })).ok, false);
  h.state.frames.clear();
  await h.command({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: false });
  assert.equal((await h.value(script.id, 'get', { key: 'x', token })).ok, false);
  assert.equal(h.state.scripts.length, 0);
});
test('metadata produces explicit site, timing, world, frame and grant scope', () => {
  const parsed = core.parse(source('Scoped', '// @exclude-match https://example.test/private/*\n// @noframes\n// @run-at document-start\n// @grant GM.getValue\n'));
  assert.equal(parsed.runAt, 'document_start'); assert.equal(parsed.world, 'USER_SCRIPT'); assert.equal(parsed.allFrames, false);
  assert.equal(core.allows(parsed, 'https://example.test/read?a=1'), true);
  for (const url of ['https://example.test/private/account', 'https://example.test.evil.test/read', 'http://example.test/read', 'file:///example.test/read']) assert.equal(core.allows(parsed, url), false);
  const wildcard = core.parse(source().replace('https://example.test/*', '*://*.example.test/path*'));
  for (const url of ['https://example.test/path', 'http://sub.example.test/path?q=1']) assert.equal(core.allows(wildcard, url), true);
  assert.deepEqual(core.parse(source().replace('https://example.test/*', '<all_urls>')).matches, ['http://*/*', 'https://*/*']);
});
for (const [label, change] of [
  ['missing scope', text => text.replace('// @match https://example.test/*\n', '')],
  ['insecure dependency', text => text.replace('// ==/UserScript==', '// @require http://example.test/code.js\n// ==/UserScript==')],
  ['unsupported grant', text => text.replace('// ==/UserScript==', '// @grant GM_unsupported\n// ==/UserScript==')],
  ['duplicate singleton', text => text.replace('// ==/UserScript==', '// @name Other\n// ==/UserScript==')],
  ['mixed none grant', text => text.replace('// ==/UserScript==', '// @grant none\n// @grant GM.getValue\n// ==/UserScript==')],
  ['bad host', text => text.replace('https://example.test/*', 'https://example.test@other.test/*')],
  ['code before metadata', text => 'alert(1);\n' + text],
  ['source quota', text => text + ' '.repeat(core.LIMITS.source)]
]) test('rejects ' + label + ' before registration', () => assert.throws(() => core.parse(change(source()))));
test('icon and update metadata is explained visibly; parsing fetches nothing', () => {
  const parsed = core.parse(source('No downloads', '// @updateURL https://example.test/update\n// @icon https://example.test/icon.png\n'));
  assert.equal(parsed.warnings.length, 2);
  assert.ok(parsed.warnings.some(warning => /@updateURL .*Install from URL/.test(warning)));
});
test('metadata parsing stays linear on padded sources without a closing marker', () => {
  // These inputs took several seconds each with a multiline backtracking regex.
  const cases = ['\n'.repeat(131000) + '// ==UserScript==\n', '// ==UserScript==\n' + '// @name x\n'.repeat(11000),
    '// ==UserScript==\n// @name a' + ' '.repeat(16000) + 'b\n// @namespace n\n// @match https://a.test/*\n// ==/UserScript==\n'];
  const started = performance.now();
  for (const text of cases) { try { core.parse(text); } catch {} }
  assert.ok(performance.now() - started < 1000, 'parsing must not stall the background worker');
  assert.equal(core.metadataBlock(cases[0]), null);
  // Equivalent results for ordinary layouts: BOM, leading blank lines, CRLF, compact markers, trailing blanks.
  const parsed = core.parse('﻿  \r\n// ==UserScript==\r\n// @name  Spaced name \t\r\n// @namespace n\r\n// @match https://a.test/*\r\n//==/UserScript==\r\ncode');
  assert.deepEqual([parsed.name, parsed.namespace, parsed.metaStr], ['Spaced name', 'n', '// @name  Spaced name \t\r\n// @namespace n\r\n// @match https://a.test/*\r\n']);
  assert.equal(core.metadataBlock('// ==UserScript==\n// ==/UserScript=='), '');
  assert.equal(core.metadataBlock('x\n// ==UserScript==\n// ==/UserScript==\n'), null);
});
test('generated GM helpers reject lossy values in the script world before native transport', async () => {
  let messages = 0;
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source('Value contract',
    '// @grant GM.setValue\n', "globalThis.results=Promise.all([undefined,NaN,Infinity,BigInt(1),new Date(),{bad:undefined},()=>{}].map(value=>GM.setValue('bad',value).then(()=>false,()=>true)));") };
  const context=vm.createContext({URL,addEventListener(){},location:{href:'https://example.test/page'},chrome:{runtime:{async sendMessage(){messages++;return {ok:true};}}}});
  inject(core.registration(record), context);
  assert.ok((await context.results).every(Boolean));
  assert.equal(messages,0);
});
test('first use defaults off and can save, export source, edit and delete without browser access', async () => {
  const h = harness(undefined, { granted: false }); await h.ready;
  assert.equal((await h.host.state()).enabled, false);
  const script = await h.save('Local');
  assert.equal(script.enabled, false); assert.equal(script.source, source('Local'));
  assert.equal('token' in script, false); assert.equal('values' in script, false);
  const edited = await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: source('Changed') });
  assert.equal(edited.scripts[0].metadata.name, 'Changed');
  await h.command({ type: 'US_DELETE', id: script.id, revision: edited.scripts[0].revision });
  assert.deepEqual(h.state.data.userscriptManager.scripts, []);
  assert.deepEqual(h.state.scripts, []);
  await assert.rejects(h.host.setEnabled(true), /access/);
});
test('module and script switches register exact scope, persist intent and revoke old capabilities', async () => {
  const h = harness(), script = await h.enable(await h.save('One'));
  assert.equal(h.state.scripts.length, 1);
  assert.equal(h.state.scripts[0].worldId, core.nativeId(script.id));
  assert.equal(h.state.worlds[0].messaging, false, 'no messaging privilege for grant none');
  const oldToken = h.state.data.userscriptManager.scripts[0].token;
  await h.host.setEnabled(false);
  assert.equal(h.state.scripts.length, 0); assert.equal(h.state.worlds.length, 0);
  assert.equal(h.state.data.userscriptManager.scripts[0].enabled, true);
  await h.host.setEnabled(true);
  assert.equal(h.state.scripts.length, 1);
  assert.notEqual(h.state.data.userscriptManager.scripts[0].token, oldToken);
  const edited = await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: source('Edited') });
  assert.equal(edited.scripts[0].enabled, false); assert.deepEqual(h.state.scripts, []);
});
test('stale saves, toggles and deletions cannot overwrite another editor', async () => {
  const h = harness(), script = await h.save('Original');
  await h.command({ type: 'US_SAVE', id: script.id, revision: script.revision, source: source('New source') });
  for (const type of ['US_SAVE', 'US_ENABLE', 'US_DELETE']) await assert.rejects(h.command({
    type, id: script.id, revision: script.revision, source: source('Old draft'), enabled: true
  }), /another window/);
  assert.equal((await h.command({ type: 'US_LIST' })).scripts[0].metadata.name, 'New source');
  await assert.rejects(h.save('New source'), /already exists/);
});
for (const fault of ['register', 'afterRegister', 'ignoredRegister', 'world', 'save', 'afterSave']) test(fault + ' failure rolls back browser state and saved intent, then retries', async () => {
  const h = harness(), first = await h.enable(await h.save('First', '// @grant GM.getValue\n'));
  const second = await h.save('Second');
  const before = clone({ data: h.state.data, scripts: h.state.scripts, worlds: h.state.worlds });
  h.state.faults[fault] = 1;
  await assert.rejects(h.command({ type: 'US_ENABLE', id: second.id, revision: second.revision, enabled: true }));
  assert.deepEqual({ data: h.state.data, scripts: h.state.scripts, worlds: h.state.worlds }, before);
  await h.command({ type: 'US_ENABLE', id: second.id, revision: second.revision, enabled: true });
  assert.equal(h.state.scripts.length, 2); assert.equal(first.enabled, true);
});
test('failure removing registrations leaves the prior enabled script and record intact', async () => {
  const h = harness(), script = await h.enable(await h.save('Keep'));
  h.state.faults.unregister = 1;
  await assert.rejects(h.command({ type: 'US_DELETE', id: script.id, revision: script.revision }), /not applied/);
  assert.equal(h.state.scripts.length, 1);
  assert.equal(h.state.data.userscriptManager.scripts[0].enabled, true);
});
test('worker restart and extension update restore saved scripts without losing values', async () => {
  const h = harness(), script = await h.enable(await h.save('Persistent', '// @grant GM.setValue\n// @grant GM.getValue\n'));
  assert.equal((await h.value(script.id, 'set', { key: 'answer', value: 42 })).ok, true);
  const restarted = harness(h.state.data); await restarted.ready;
  assert.equal(restarted.state.scripts.length, 1);
  assert.equal((await restarted.value(script.id, 'get', { key: 'answer' })).value, 42);
  restarted.state.scripts = []; restarted.state.worlds = [];
  await restarted.host.start(); assert.equal(restarted.state.scripts.length, 1);
});
test('GM values are isolated by capability, grants, native sender, frame and URL scope', async () => {
  const h = harness(), grants = '// @grant GM.getValue\n// @grant GM.setValue\n// @grant GM.deleteValue\n// @grant GM.listValues\n// @noframes\n// @exclude-match https://example.test/private/*\n';
  const first = await h.enable(await h.save('First', grants)), second = await h.enable(await h.save('Second', grants));
  assert.equal((await h.value(first.id, 'set', { key: 'answer', value: { number: 42 } })).ok, true);
  assert.deepEqual((await h.value(first.id, 'get', { key: 'answer' })).value, { number: 42 });
  assert.equal((await h.value(second.id, 'get', { key: 'answer' })).exists, false);
  for (const args of [{ token: 'guessed' }, { token: h.state.data.userscriptManager.scripts.find(item => item.id === second.id).token }]) assert.equal((await h.value(first.id, 'get', { key: 'answer', ...args })).ok, false);
  for (const from of [{ ...h.sender(), id: 'other' }, { ...h.sender(), frameId: 2 }, { ...h.sender(), url: 'https://other.test/' },
    { ...h.sender(), url: 'https://example.test/private/account' }, { ...h.sender(), userScriptWorldId: core.nativeId(second.id) },
    { ...h.sender(), tab: undefined }]) assert.equal((await h.value(first.id, 'get', { key: 'answer' }, from)).ok, false);
  assert.equal((await h.value(first.id, 'UPDATE_SETTINGS', { enabled: false })).ok, false);
  assert.deepEqual((await h.value(first.id, 'list')).keys, ['answer']);
  await h.value(first.id, 'delete', { key: 'answer' }); assert.equal((await h.value(first.id, 'get', { key: 'answer' })).exists, false);
  const noGrant = await h.enable(await h.save('No privileges'));
  assert.equal((await h.value(noGrant.id, 'get', { key: 'answer' })).ok, false);
});
test('revoked browser access and disabled/deleted scripts cannot use their former GM storage', async () => {
  const h = harness(), script = await h.enable(await h.save('Revocation', '// @grant GM.getValue\n'));
  h.state.apiOn = false;
  assert.equal((await h.host.state()).active, false);
  assert.equal((await h.value(script.id, 'get', { key: 'x' })).ok, false);
  await h.host.setEnabled(false); assert.equal(h.state.data.userscriptManager.enabled, false);
  h.state.apiOn = true; await h.host.start(); assert.deepEqual(h.state.scripts, []);
  await h.host.setEnabled(true);
  const oldToken = h.state.data.userscriptManager.scripts[0].token;
  await h.command({ type: 'US_DELETE', id: script.id, revision: script.revision });
  assert.equal((await h.value(script.id, 'get', { key: 'x', token: oldToken })).ok, false);
});
test('wildcard-heavy scopes cannot stall the shared extension worker', () => {
  const metadata = core.parse(source('Path scope').replace('https://example.test/*', 'https://example.test/' + 'a*'.repeat(40) + 'b'));
  const url = 'https://example.test/' + 'a'.repeat(2048) + 'c';
  assert.equal(vm.runInNewContext('core.allows(metadata, url)', { core, metadata, url }, { timeout: 1000 }), false);
  assert.equal(core.allows(metadata, 'https://example.test/' + 'a'.repeat(2048) + 'b'), true);
  const adjacent = core.parse(source('Overlap').replace('https://example.test/*', 'https://example.test/a*b*b'));
  assert.equal(core.allows(adjacent, 'https://example.test/ab'), false);
  assert.equal(core.allows(adjacent, 'https://example.test/abb'), true);
});
test('Edge permission denial still allows disabling the module', async () => {
  const h = harness(undefined, { unavailableError: "'userScripts.getScripts' is not available in this context." });
  await h.enable(await h.save('Native access'));
  h.state.apiOn = false;
  const denied = await h.command({ type: 'US_LIST' });
  assert.equal(denied.available, false);
  assert.equal(denied.scripts.length, 1);
  await h.host.setEnabled(false);
  assert.equal(h.state.data.userscriptManager.enabled, false);
  h.state.apiOn = true;
  await h.host.start();
  assert.deepEqual(h.state.scripts, []);
});
test('concurrent GM writes retain both values and quota errors preserve the old data', async () => {
  const h = harness(), script = await h.enable(await h.save('Storage', '// @grant GM.setValue\n// @grant GM.getValue\n'));
  const replies = await Promise.all(['one', 'two', '__proto__'].map(key => h.value(script.id, 'set', { key, value: { saved: true } })));
  assert.ok(replies.every(reply => reply.ok));
  assert.equal((await h.value(script.id, 'get', { key: '__proto__' })).value.saved, true);
  const saved = clone(h.state.data);
  assert.equal((await h.value(script.id, 'set', { key: 'large', value: 'x'.repeat(core.LIMITS.values) })).ok, false);
  assert.deepEqual(h.state.data, saved);
  h.state.faults.save = 1;
  assert.equal((await h.value(script.id, 'set', { key: 'lost', value: 1 })).ok, false);
  assert.deepEqual(h.state.data, saved);
});
test('invalid stored data is preserved while stale native registrations are removed', async () => {
  const h = harness(), script = await h.enable(await h.save('Old'));
  h.state.data.userscriptManager.scripts[0].source = 'corrupted';
  const saved = clone(h.state.data); await h.host.start();
  assert.deepEqual(h.state.data, saved); assert.deepEqual(h.state.scripts, []);
  await assert.rejects(h.command({ type: 'US_SAVE', source: source('Replacement') }), /metadata/);
  assert.equal(script.enabled, true);
});
test('native registrations from other bundled modules are left untouched', async () => {
  const h = harness(); await h.ready;
  h.state.scripts.push({ id: 'other-module', js: [{ code: 'void 0' }] });
  h.state.worlds.push({ worldId: 'other-world', messaging: false });
  await h.host.start(); await h.host.setEnabled(false);
  assert.equal(h.state.scripts[0].id, 'other-module'); assert.equal(h.state.worlds[0].worldId, 'other-world');
});
test('a module failure stays local and cannot invoke an unregistered adapter', async () => {
  let protection = true;
  const registry = BlockAdsModules.create({ state: async () => ({ enabled: protection, active: protection }),
    setEnabled: async value => { protection = value; return { ok: true }; } },
  { state: async () => { throw new Error('Script-only failure'); }, setEnabled: async () => { throw new Error('Script-only failure'); } });
  const result = await registry.state();
  assert.equal(result.modules[0].active, true); assert.match(result.modules[1].error, /Script-only/);
  await assert.rejects(registry.set('userscripts', true)); assert.equal(protection, true);
  await assert.rejects(registry.set('__proto__', false), /Unknown/);
  await registry.set('blocking', false); assert.equal(protection, false);
});

test('a scheduled check installs an update that needs no new access, keeping the script on with its values and tags; wider updates wait', async t => {
  const logged = [];
  const f = await installFixture(t, updateSource(), { log: entry => logged.push(entry) });
  let script = await f.h.enable(f.current());
  assert.equal((await f.h.value(script.id, 'set', { key: 'kept', value: 7 })).ok, true);
  await f.h.command({ type: 'US_TAGS', id: script.id, revision: f.current().revision, tags: ['mine'] });
  const next = updateSource('1.1', '', 'void "next version";');
  f.state.sources['/usnet/script.user.js'] = { body: next };
  const checked = await f.h.command({ type: 'US_CHECK_ALL' });
  assert.deepEqual([checked.result.applied, checked.result.staged, checked.scripts[f.current().id].outcome], [1, 0, 'applied']);
  script = f.current();
  assert.deepEqual([script.source, script.enabled, script.sourceURL, script.values.kept, script.tags], [next, true, f.url, 7, ['mine']]);
  assert.ok(f.h.state.scripts.some(registered => JSON.stringify(registered).includes('next version')), 'the browser registration runs the new code');
  assert.deepEqual(logged.map(entry => entry.message), ['Updated userscript "URL fixture" to 1.1 automatically; it asks for no new access']);

  const wider = updateSource('1.2', '// @grant GM_cookie\n', 'void "wider";');
  f.state.sources['/usnet/script.user.js'] = { body: wider };
  const again = await f.h.command({ type: 'US_CHECK_ALL' });
  assert.deepEqual([again.result.applied, again.result.staged, again.scripts[script.id].outcome], [0, 1, 'staged']);
  assert.equal(again.scripts[script.id].message, 'Waiting for your review: it asks for GM_cookie.');
  assert.deepEqual([f.current().source, f.current().enabled], [next, true], 'the running script is unchanged');
  const staged = await f.h.command({ type: 'US_STAGED_REVIEW', id: script.id, revision: f.current().revision });
  assert.equal(staged.review.source, wider, 'the wider update still waits for the normal review');

  await f.h.command({ type: 'US_UPDATE_SETTINGS', settings: { autoApply: false } });
  f.state.sources['/usnet/script.user.js'] = { body: updateSource('1.3', '', 'void "manual";') };
  const off = await f.h.command({ type: 'US_CHECK_ALL' });
  assert.deepEqual([off.result.applied, off.scripts[script.id].outcome, f.current().source], [0, 'staged', next], 'with the setting off every update waits');
  assert.equal(logged.length, 1);
});
