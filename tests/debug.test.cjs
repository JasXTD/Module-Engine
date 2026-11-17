const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../src/shared/debug-protocol.js'); require('../src/background/debug-runtime.js');
const id = '12345678-1234-1234-1234-123456789abc';
globalThis.BlockAdsUserScriptCore = { allows: (_metadata, url) => url.startsWith('https://example.test/') };
const event = () => { const listeners = []; return { addListener: callback => listeners.push(callback), fire: message => listeners.forEach(callback => callback(message)) }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, inspect, readNetwork) {
  const onConnect = event(), state = { sink: null, reads: 0, networkReads: 0 };
  const api = { runtime: { id: 'owned', onConnect, getURL: path => 'chrome-extension://owned/' + path, getManifest: () => ({ version: '1.9.0' }) } };
  const library = { enabled: true, active: true, available: true, scripts: [{ id, revision: 1, enabled: true, source: '// source',
    metadata: { name: 'Example', version: '1', world: 'USER_SCRIPT' }, token: 'private-capability', values: { secret: 'private-value' }, tags: [] }] };
  const host = BlockAdsDebug.create(api, { userscripts: { inspect: async () => { state.reads++; return inspect ? inspect() : library; }, setDiagnosticSink: sink => { state.sink = sink; } },
    blocking: async () => ({ enabled: true }), activity: async () => [{ time: 1, kind: 'blocked', url: 'https://user:secret@example.test/path?q=secret#token', cookies: 'private-cookie' },
      // The shape background.js writes for a blocked request.
      { time: 2, kind: 'blocked', layer: 'Ads', ruleId: 42, host: 'ads.example.test', path: '/pixel.gif', type: 'image', site: 'news.example.test', tabId: 7 }],
    network: async args => { state.networkReads++; return readNetwork ? readNetwork(args) : { ok: true, entries: [], capture: { active: false } }; } });
  t.after(() => host.close());
  function port(sender = { id: 'owned', url: api.runtime.getURL('src/ui/mcp/debug.html') }) {
    const p = { name: 'ME_DEBUG_READONLY', sender, onMessage: event(), onDisconnect: event(), sent: [], closed: false,
      postMessage: message => p.sent.push(message), disconnect: () => { if (!p.closed) { p.closed = true; p.onDisconnect.fire(); } } };
    onConnect.fire(p); return p;
  }
  const approve = (scopes = ['status', 'scripts', 'logs']) => { const p = port(); p.onMessage.fire({ type: 'approve', scopes }); return p; };
  const read = async (p, name, args = {}) => { const requestId = crypto.randomUUID(); p.onMessage.fire({ type: 'read', id: requestId, name: 'module_engine_' + name, arguments: args }); await flush(); return p.sent.find(item => item.id === requestId)?.result; };
  return { state, library, port, approve, read, host };
}
test('only the exact owned Debug page can approve a single read port', async t => {
  const f = fixture(t);
  for (const sender of [{ id: 'other', url: 'chrome-extension://owned/src/ui/mcp/debug.html' }, { id: 'owned', url: 'https://example.test/src/ui/mcp/debug.html' }, { id: 'owned', url: 'chrome-extension://owned/src/ui/manager/manager.html' }, { id: 'owned', url: 'chrome-extension://owned/src/ui/mcp/debug.html#other' }]) assert.equal(f.port(sender).closed, true);
  const early = f.port(); await f.read(early, 'status'); assert.equal(early.closed, true); assert.equal(f.state.reads, 0);
  const p = f.approve(); assert.equal(p.closed, false); assert.equal(f.port().closed, true);
  p.disconnect(); assert.equal(f.state.sink, null);
  assert.equal(f.approve().closed, false);
});
test('scope guards and explicit projections never return GM values, cookies or capabilities', async t => {
  const f = fixture(t), p = f.approve(['status']);
  assert.equal((await f.read(p, 'status')).blocking.enabled, true);
  assert.equal((await f.read(p, 'get_script', { id })).ok, false);
  assert.equal((await f.read(p, 'get_logs')).ok, false); assert.equal(f.state.sink, null);
  p.disconnect(); const all = f.approve();
  const script = await f.read(all, 'get_script', { id }); assert.equal(script.script.source, '// source');
  assert.equal(/private-capability|private-value/.test(JSON.stringify(script)), false);
  assert.equal((await f.read(all, 'list_scripts')).scripts[0].source, undefined);
  const logs = await f.read(all, 'get_logs'); assert.equal(logs.entries[0].url, 'https://example.test/path'); assert.equal(JSON.stringify(logs).includes('private-cookie'), false);
  assert.deepEqual(logs.entries[1], { kind: 'activity', time: 2, event: 'blocked', message: '', site: 'news.example.test', host: 'ads.example.test',
    path: '/pixel.gif', type: 'image', layer: 'Ads', ruleId: 42, tabId: 7 }, 'blocked entries keep the server, path and rule');
  assert.equal((await f.read(all, 'check_url', { url: 'https://example.test/page' })).scripts[0].matches, true);
  assert.equal((await f.read(all, 'status', { type: 'UPDATE_SETTINGS' })).ok, false);
  assert.equal((await f.read(all, 'eval')).ok, false);
});
test('matching distinguishes legacy auto isolation from approved page-first execution', async t => {
  const f = fixture(t), p = f.approve(), script = f.library.scripts[0];
  Object.assign(script.metadata, { world: 'MAIN', injection: 'auto', pageBridge: true });
  let result = (await f.read(p, 'check_url', { url: 'https://example.test/' })).scripts[0];
  assert.equal(result.world, 'USER_SCRIPT'); assert.equal(result.fallbackWorld, null);
  script.autoPageApproved = true;
  result = (await f.read(p, 'check_url', { url: 'https://example.test/' })).scripts[0];
  assert.equal(result.world, 'MAIN'); assert.equal(result.fallbackWorld, 'USER_SCRIPT');
  assert.equal((await f.read(p, 'get_script', { id })).script.autoPageApproved, true);
});
test('logs are bounded, filtered and cleared on revocation; stale reads never deliver', async t => {
  let resolve; const f = fixture(t, () => new Promise(r => { resolve = r; })), p = f.approve();
  const oldSink = f.state.sink;
  for (let i = 0; i < 105; i++) oldSink({ time: i, scriptId: id, message: String(i) });
  const logs = await f.read(p, 'get_logs', { kind: 'userscript', limit: 100, scriptId: id }); assert.equal(logs.entries.length, 100); assert.equal(logs.entries[0].message, '5');
  await f.read(p, 'status'); p.disconnect(); resolve(f.library); await flush();
  assert.equal(p.sent.some(item => item.type === 'result' && item.result?.blocking), false);
  const next = f.approve(); oldSink({ time: 999, message: 'old' }); assert.equal((await f.read(next, 'get_logs', { kind: 'userscript' })).entries.length, 0);
});
test('too many pending reads are refused and invalid envelopes close the channel', async t => {
  const f = fixture(t, () => new Promise(() => {})), p = f.approve();
  for (let i = 0; i < 4; i++) await f.read(p, 'status');
  assert.match((await f.read(p, 'status')).error, /limit/);
  p.onMessage.fire({ type: 'UPDATE_SETTINGS', enabled: false }); assert.equal(p.closed, true); assert.equal(f.state.sink, null);
});
test('browser approval expires before another read, even before the timer runs', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = fixture(t), p = f.approve(); now += ModuleEngineDebugProtocol.SESSION_MS;
  assert.equal(await f.read(p, 'status'), undefined); assert.equal(p.closed, true); assert.equal(f.state.reads, 0); assert.equal(f.state.sink, null);
});

test('network metadata requires its own approval and has no capture controls', async t => {
  const f=fixture(t), old=f.approve();
  assert.equal((await f.read(old,'get_network_log')).ok,false);assert.equal(f.state.networkReads,0);
  old.disconnect();const p=f.approve(['status','network']);
  const result=await f.read(p,'get_network_log',{limit:5,url:'/fixture',method:'GET',tabId:-1,state:'error'});
  assert.equal(result.ok,true);assert.equal(result.capture.active,false);assert.equal(f.state.networkReads,1);assert.equal(f.state.reads,0);assert.equal(f.state.sink,null);
  for(const args of [{start:true},{clear:true},{stop:true},{capture:true},{limit:101},{tabId:-2},{url:'x'.repeat(257)},{state:'blocked'},{statusCode:99}])assert.equal((await f.read(p,'get_network_log',args)).ok,false);
  assert.equal(f.state.networkReads,1);
  assert.equal((await f.read(p,'get_logs')).ok,false);assert.equal((await f.read(p,'get_script',{id})).ok,false);
  assert.equal((await f.read(p,'start_network_capture')).ok,false);
});

test('network reads in flight cannot deliver after approval is revoked', async t => {
  let resolve;const f=fixture(t,null,()=>new Promise(r=>{resolve=r;})),p=f.approve(['status','network']);
  await f.read(p,'get_network_log');assert.equal(f.state.networkReads,1);p.disconnect();
  resolve({ok:true,entries:[{url:'https://example.test/private-path'}]});await flush();
  assert.equal(p.sent.some(m=>m.type==='result'),false);
  const next=f.approve(['status']);assert.equal((await f.read(next,'get_network_log')).ok,false);assert.equal(f.state.networkReads,1);
});
