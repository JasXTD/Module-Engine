const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('../userscripts-core.js'); require('../userscripts-runtime.js'); require('../modules.js');
const core = globalThis.BlockAdsUserScriptCore;
const clone = value => structuredClone(value);
const source = (name = 'Example', metadata = '', body = 'document.body.dataset.script = "ran";') =>
  '// ==UserScript==\n// @name ' + name + '\n// @namespace tests\n// @match https://example.test/*\n' + metadata + '// ==/UserScript==\n' + body;
function harness(initial, options = {}) {
  const state = { data: initial ? clone(initial) : {}, scripts: [], worlds: [], faults: {}, granted: options.granted ?? true, apiOn: true, hooks: {}, writes: 0 };
  const fault = name => { if (state.faults[name]) { state.faults[name]--; throw new Error('Injected ' + name + ' failure'); } };
  const event = key => ({ addListener: callback => { state.hooks[key] = callback; } });
  const api = {
    runtime: { id: 'test', onUserScriptMessage: event('message') },
    permissions: { contains: async () => state.granted, onAdded: event('added'), onRemoved: event('removed') },
    storage: { local: {
      async get() { fault('read'); return clone(state.data); },
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
          new vm.Script(script.js[0].code); // The mock never executes untrusted code.
          state.scripts.push(clone(script));
        }
        fault('afterRegister');
        if (state.faults.ignoredRegister) { state.faults.ignoredRegister--; state.scripts.pop(); }
      }
    }
  };
  const host = BlockAdsUserScripts.create(api), ready = host.start();
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
  return { state, api, host, ready, command, save, enable, sender, value };
}
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
  ['remote dependency', text => text.replace('// ==/UserScript==', '// @require https://example.test/code.js\n// ==/UserScript==')],
  ['unsupported grant', text => text.replace('// ==/UserScript==', '// @grant GM_xmlhttpRequest\n// ==/UserScript==')],
  ['duplicate singleton', text => text.replace('// ==/UserScript==', '// @name Other\n// ==/UserScript==')],
  ['mixed none grant', text => text.replace('// ==/UserScript==', '// @grant none\n// @grant GM.getValue\n// ==/UserScript==')],
  ['page-world privilege', text => text.replace('// ==/UserScript==', '// @inject-into page\n// @grant GM.setValue\n// ==/UserScript==')],
  ['bad host', text => text.replace('https://example.test/*', 'https://example.test@other.test/*')],
  ['code before metadata', text => 'alert(1);\n' + text],
  ['source quota', text => text + ' '.repeat(core.LIMITS.source)]
]) test('rejects ' + label + ' before registration', () => assert.throws(() => core.parse(change(source()))));
test('asset and update metadata is ignored visibly without fetching anything', () => {
  const parsed = core.parse(source('No downloads', '// @updateURL https://example.test/update\n// @icon https://example.test/icon.png\n'));
  assert.equal(parsed.warnings.length, 2);
});
test('generated GM helpers reject lossy values in the script world before native transport', async () => {
  let messages = 0;
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source('Value contract',
    '// @grant GM.setValue\n', "globalThis.results=Promise.all([undefined,NaN,Infinity,BigInt(1),new Date(),{bad:undefined},()=>{}].map(value=>GM.setValue('bad',value).then(()=>false,()=>true)));") };
  const context=vm.createContext({chrome:{runtime:{async sendMessage(){messages++;return {ok:true};}}}});
  vm.runInContext(core.registration(record).js[0].code,context);
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
