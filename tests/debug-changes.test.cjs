/* Review-gated MCP change proposals at the browser boundary, with the real
   metadata parser and a library host that keeps the runtime's revision rules. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js');
require('../src/userscripts/userscripts-page.js'); require('../src/userscripts/userscripts-core.js');
require('../src/shared/debug-protocol.js'); require('../src/background/debug-runtime.js');
const core = BlockAdsUserScriptCore, protocol = ModuleEngineDebugProtocol;
const source = (name, body = 'void 0;', metadata = '') => '// ==UserScript==\n// @name ' + name + '\n// @namespace https://owned.test/\n// @match https://example.test/*\n' +
  metadata + '// ==/UserScript==\n' + body + '\n';
const event = () => { const listeners = []; return { addListener: callback => listeners.push(callback), fire: message => listeners.forEach(callback => callback(message)) }; };
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
// Mirrors userscripts-runtime.js: saving turns a script off, every write needs the
// current revision, and enabling refuses unprepared dependencies.
function library() {
  const state = { scripts: [], requests: [], failEnable: null, gate: null };
  const view = () => structuredClone({ ok: true, enabled: true, active: true, available: true,
    scripts: state.scripts.map(script => ({ ...script, metadata: core.parse(script.source) })) });
  return { state, host: {
    inspect: async () => view(), setDiagnosticSink: () => {},
    async request(message) {
      state.requests.push(message);
      if (state.gate) await state.gate;
      const script = message.id !== undefined ? state.scripts.find(item => item.id === message.id) : null;
      if (message.id !== undefined && (!script || script.revision !== message.revision)) throw new Error('This script changed in another window. Refresh and reopen it before applying changes.');
      if (message.type === 'US_SAVE') {
        const metadata = core.parse(message.source);
        if (script) Object.assign(script, { source: message.source, enabled: false, revision: script.revision + 1,
          assets: JSON.stringify(core.assetSpecs(core.parse(script.source))) === JSON.stringify(core.assetSpecs(metadata)) ? script.assets : null });
        else state.scripts.push({ id: crypto.randomUUID(), revision: 1, enabled: false, source: message.source, sourceURL: null, tags: [], assets: null });
        return { ...view(), selectedId: script?.id ?? state.scripts.at(-1).id };
      }
      if (message.type === 'US_ENABLE') {
        if (state.failEnable) throw new Error(state.failEnable);
        if (message.enabled && core.assetSpecs(core.parse(script.source)).length && !script.assets) throw new Error('Prepare and review this script’s dependencies before enabling it.');
        Object.assign(script, { enabled: message.enabled, revision: script.revision + 1 });
        return { ...view(), selectedId: script.id };
      }
      if (message.type === 'US_DELETE') { state.scripts.splice(state.scripts.indexOf(script), 1); return { ...view(), selectedId: null }; }
      throw new Error('Unknown userscript command.');
    }
  } };
}
function fixture(t) {
  const onConnect = event(), logs = [], { state, host } = library();
  const api = { runtime: { id: 'owned', onConnect, getURL: path => 'chrome-extension://owned/' + path, getManifest: () => ({ version: '1.9.0' }) } };
  const debug = BlockAdsDebug.create(api, { userscripts: host, blocking: async () => ({ enabled: true }), activity: async () => [],
    network: async () => ({ ok: true, entries: [] }), log: async entry => { logs.push(entry); } });
  t.after(() => debug.close());
  function approve(scopes = ['status', 'scripts', protocol.CHANGES]) {
    const p = { name: 'ME_DEBUG_READONLY', sender: { id: 'owned', url: api.runtime.getURL('src/ui/mcp/debug.html') }, onMessage: event(), onDisconnect: event(), sent: [], closed: false,
      postMessage: message => p.sent.push(message), disconnect: () => { if (!p.closed) { p.closed = true; p.onDisconnect.fire(); } } };
    onConnect.fire(p); p.onMessage.fire({ type: 'approve', scopes }); return p;
  }
  async function call(p, name, args = {}) {
    const id = crypto.randomUUID(); p.onMessage.fire({ type: 'read', id, name: 'module_engine_' + name, arguments: args }); await settle();
    return p.sent.find(item => item.type === 'result' && item.id === id)?.result;
  }
  async function decide(p, id, action, acknowledgeBidi) { p.onMessage.fire({ type: 'decide', id, action, acknowledgeBidi }); await settle(); return latest(p, id); }
  const latest = (p, id) => p.sent.filter(item => item.type === 'proposal' && item.proposal.id === id).at(-1)?.proposal;
  async function install(name, options = {}) {
    const saved = await host.request({ type: 'US_SAVE', source: source(name, options.body, options.metadata) });
    const script = state.scripts.find(item => item.id === saved.selectedId);
    if (options.enabled) Object.assign(script, { enabled: true, revision: script.revision + 1 });
    if (options.assets) script.assets = options.assets;
    state.requests.length = 0; return script;
  }
  return { state, logs, approve, call, decide, latest, install };
}

test('change tools need their own approval, and agent requests cannot make decisions', async t => {
  const f = fixture(t), readOnly = f.approve(['status', 'scripts']);
  assert.match((await f.call(readOnly, 'propose_script', { source: source('Owned') })).error, /scope/);
  assert.match((await f.call(readOnly, 'get_proposal', { proposalId: crypto.randomUUID() })).error, /scope/);
  // A decision without change approval is a protocol violation, not a request.
  readOnly.onMessage.fire({ type: 'decide', id: crypto.randomUUID(), action: 'apply' }); assert.equal(readOnly.closed, true);
  const p = f.approve(), proposal = (await f.call(p, 'propose_script', { source: source('Owned') })).proposal;
  for (const name of ['decide', 'apply', 'apply_proposal', 'module_engine_decide']) assert.equal((await f.call(p, name, { id: proposal.id })).ok, false);
  assert.equal((await f.call(p, 'get_proposal', { proposalId: proposal.id })).proposal.status, 'pending');
  assert.equal(f.state.requests.length, 0); assert.equal(f.state.scripts.length, 0);
  for (const action of ['delete', 'APPLY', '']) { const next = f.approve(); next.onMessage.fire({ type: 'decide', id: proposal.id, action }); assert.equal(next.closed, true); }
});

test('MCP cannot apply and enable hidden direction controls without a separate page acknowledgment', async t => {
  const f = fixture(t), p = f.approve();
  const input = source('Bidi', '// \u202e inert comment');
  const item = (await f.call(p, 'propose_script', { source: input })).proposal;
  for (const acknowledgment of [undefined, false, 'true']) {
    const refused = await f.decide(p, item.id, 'apply_enable', acknowledgment);
    assert.equal(refused.status, 'pending'); assert.match(refused.error, /acknowledge/); assert.equal(f.state.requests.length, 0);
  }
  const applied = await f.decide(p, item.id, 'apply_enable', true);
  assert.equal(applied.status, 'applied'); assert.equal(applied.enabled, true);
  assert.equal(f.state.scripts[0].source, input); assert.equal(f.state.requests.at(-1).acknowledgeBidi, true);
  const script = f.state.scripts[0];
  const edit = (await f.call(p, 'propose_script', { id: script.id, revision: script.revision, source: input + '\n// new revision' })).proposal;
  const count = f.state.requests.length;
  assert.equal((await f.decide(p, edit.id, 'apply_enable')).status, 'pending'); assert.equal(f.state.requests.length, count);
  assert.equal((await f.decide(p, edit.id, 'apply')).enabled, false);
});

test('MCP disable and revert cannot silently reenable source with direction controls', async t => {
  const f = fixture(t), p = f.approve(), script = await f.install('Bidi', { enabled: true, body: '// \u2066 inert' });
  const item = (await f.call(p, 'propose_enabled', { id: script.id, revision: script.revision, enabled: false })).proposal;
  assert.equal((await f.decide(p, item.id, 'apply')).enabled, false);
  const count = f.state.requests.length, reverted = await f.decide(p, item.id, 'revert');
  assert.match(reverted.error, /fresh review/); assert.equal(f.state.requests.length, count); assert.equal(script.enabled, false);
  const next = (await f.call(p, 'propose_enabled', { id: script.id, revision: script.revision, enabled: true })).proposal;
  assert.equal((await f.decide(p, next.id, 'apply')).status, 'pending');
  assert.equal((await f.decide(p, next.id, 'apply', true)).enabled, true);
});

test('a new script is checked, shown for review, saved off on Apply and removable for the session', async t => {
  const f = fixture(t), p = f.approve();
  assert.match((await f.call(p, 'propose_script', { source: '// ==UserScript==\n// @match https://example.test/*\n// ==/UserScript==\n' })).error, /Metadata error/);
  assert.match((await f.call(p, 'propose_script', { source: source('Big', 'x'.repeat(core.LIMITS.source)) })).error, /Invalid tool argument/);
  // Within the character bound but over the UTF-8 byte limit.
  assert.match((await f.call(p, 'propose_script', { source: source('Wide', '"' + 'é'.repeat(core.LIMITS.source / 2) + '";') })).error, /128 KiB/);
  const result = await f.call(p, 'propose_script', { source: source('Owned'), note: 'Hides the banner.' });
  assert.equal(result.ok, true); assert.equal(result.proposal.status, 'pending'); assert.match(result.next, /MCP page/);
  const shown = f.latest(p, result.proposal.id);
  assert.equal(shown.source, source('Owned')); assert.equal(shown.previousSource, null); assert.equal(shown.created, true); assert.equal(shown.note, 'Hides the banner.');
  assert.equal(f.state.requests.length, 0);
  const applied = await f.decide(p, result.proposal.id, 'apply');
  assert.equal(applied.status, 'applied'); assert.equal(applied.enabled, false); assert.equal(applied.canRevert, true); assert.equal(applied.source, undefined);
  assert.deepEqual(f.state.requests.map(item => item.type), ['US_SAVE']); assert.equal(f.state.scripts[0].enabled, false);
  const status = (await f.call(p, 'get_proposal', { proposalId: result.proposal.id })).proposal;
  assert.equal(status.scriptId, f.state.scripts[0].id); assert.equal(status.revision, f.state.scripts[0].revision);
  assert.match(f.logs.at(-1).message, /applied the agent’s new script "Owned"; it stays off/);
  assert.equal((await f.decide(p, result.proposal.id, 'apply')).status, 'applied'); assert.equal(f.state.requests.length, 1);
  assert.equal((await f.decide(p, result.proposal.id, 'revert')).status, 'reverted');
  assert.equal(f.state.requests.at(-1).type, 'US_DELETE'); assert.equal(f.state.scripts.length, 0);
  assert.match(f.logs.at(-1).message, /reverted .*removed the script/);
  assert.ok(p.sent.some(item => item.type === 'decided' && item.id === result.proposal.id));
});

test('edits keep identity, use the read revision, and Apply & enable turns on only the reviewed code', async t => {
  const f = fixture(t), p = f.approve(), script = await f.install('Owned', { enabled: true });
  const edit = source('Owned', 'document.title = "fixed";');
  assert.match((await f.call(p, 'propose_script', { source: edit, id: script.id, revision: script.revision + 1 })).error, /changed since you read it/);
  assert.match((await f.call(p, 'propose_script', { source: edit, id: script.id })).error, /together/);
  assert.match((await f.call(p, 'propose_script', { source: source('Renamed'), id: script.id, revision: script.revision })).error, /Keep @name/);
  assert.match((await f.call(p, 'propose_script', { source: script.source, id: script.id, revision: script.revision })).error, /already installed/);
  assert.match((await f.call(p, 'propose_script', { source: source('Owned') })).error, new RegExp('Pass its id \\(' + script.id));
  const proposal = (await f.call(p, 'propose_script', { source: edit, id: script.id, revision: script.revision })).proposal;
  const shown = f.latest(p, proposal.id);
  assert.equal(shown.previousSource, script.source); assert.equal(shown.wasEnabled, true); assert.equal(shown.created, false);
  const applied = await f.decide(p, proposal.id, 'apply_enable');
  assert.equal(applied.status, 'applied'); assert.equal(applied.enabled, true);
  assert.deepEqual(f.state.requests.map(item => item.type), ['US_SAVE', 'US_ENABLE']);
  assert.equal(f.state.scripts[0].source, edit); assert.equal(f.state.scripts[0].enabled, true);
  assert.match(f.logs.at(-1).message, /edit to "Owned" and turned it on/);
  // Revert restores the previous source, saved off like any edit.
  assert.equal((await f.decide(p, proposal.id, 'revert')).status, 'reverted');
  assert.equal(f.state.scripts[0].source, script.source); assert.equal(f.state.scripts[0].enabled, false);
});

test('decisions refuse stale proposals, and later edits block revert', async t => {
  const f = fixture(t), p = f.approve(), script = await f.install('Owned');
  const first = (await f.call(p, 'propose_script', { source: source('Owned', 'void 1;'), id: script.id, revision: script.revision })).proposal;
  script.revision++; // The user edits the script in Modules & scripts.
  const stale = await f.decide(p, first.id, 'apply');
  assert.equal(stale.status, 'stale'); assert.match(stale.error, /changed after this proposal/); assert.equal(f.state.requests.length, 0);
  const second = (await f.call(p, 'propose_script', { source: source('Owned', 'void 2;'), id: script.id, revision: script.revision })).proposal;
  assert.equal((await f.decide(p, second.id, 'apply')).status, 'applied');
  f.state.scripts[0].revision++;
  const blocked = await f.decide(p, second.id, 'revert');
  assert.equal(blocked.status, 'applied'); assert.equal(blocked.canRevert, false); assert.match(blocked.error, /changed after the agent’s change/);
  assert.equal(f.state.scripts[0].source, source('Owned', 'void 2;'));
  const created = (await f.call(p, 'propose_script', { source: source('Later') })).proposal;
  await f.install('Later');
  assert.equal((await f.decide(p, created.id, 'apply')).status, 'stale');
});

test('a proposal being applied is never replaced mid-decision, so Revert keeps its previous source', async t => {
  const f = fixture(t), p = f.approve(), script = await f.install('Owned');
  const first = (await f.call(p, 'propose_script', { source: source('Owned', 'void 1;'), id: script.id, revision: script.revision })).proposal;
  let release; f.state.gate = new Promise(resolve => { release = resolve; });
  p.onMessage.fire({ type: 'decide', id: first.id, action: 'apply' }); await settle();
  const second = await f.call(p, 'propose_script', { source: source('Owned', 'void 2;'), id: script.id, revision: script.revision });
  assert.equal(second.ok, true); assert.equal(f.latest(p, first.id).status, 'pending');
  f.state.gate = null; release(); await settle();
  assert.equal(f.latest(p, first.id).status, 'applied');
  assert.equal((await f.decide(p, first.id, 'revert')).status, 'reverted'); assert.equal(f.state.scripts[0].source, script.source);
  assert.equal((await f.decide(p, second.proposal.id, 'apply')).status, 'stale');
});
test('pending proposals are bounded, newer ones replace older ones, and rejection changes nothing', async t => {
  const f = fixture(t), p = f.approve();
  const first = (await f.call(p, 'propose_script', { source: source('One') })).proposal;
  const replacement = (await f.call(p, 'propose_script', { source: source('One', 'void 1;') })).proposal;
  assert.equal(f.latest(p, first.id).status, 'superseded');
  for (const name of ['Two', 'Three', 'Four']) assert.equal((await f.call(p, 'propose_script', { source: source(name) })).ok, true);
  assert.match((await f.call(p, 'propose_script', { source: source('Five') })).error, /Four proposals/);
  assert.equal((await f.call(p, 'propose_script', { source: source('Four', 'void 4;') })).ok, true);
  const rejected = await f.decide(p, replacement.id, 'reject');
  assert.equal(rejected.status, 'rejected'); assert.match(f.logs.at(-1).message, /rejected .*"One"/);
  assert.equal(f.state.requests.length, 0);
  assert.equal((await f.call(p, 'propose_script', { source: source('Five') })).ok, true);
});

test('enable proposals defer to pending edits and respect unprepared dependencies', async t => {
  const f = fixture(t), p = f.approve();
  const pin = '// @require https://cdn.owned.test/lib.js#sha256=' + 'a'.repeat(64) + '\n';
  const plain = await f.install('Plain'), deps = await f.install('Deps', { metadata: pin });
  assert.match((await f.call(p, 'propose_enabled', { id: plain.id, revision: plain.revision, enabled: false })).error, /already off/);
  const edit = (await f.call(p, 'propose_script', { source: source('Plain', 'void 1;'), id: plain.id, revision: plain.revision })).proposal;
  assert.match((await f.call(p, 'propose_enabled', { id: plain.id, revision: plain.revision, enabled: true })).error, /source change for this script is waiting/);
  assert.equal((await f.decide(p, edit.id, 'reject')).status, 'rejected');
  const on = (await f.call(p, 'propose_enabled', { id: plain.id, revision: plain.revision, enabled: true, note: 'Needed for the fix.' })).proposal;
  const shown = f.latest(p, on.id);
  assert.equal(shown.requestedEnabled, true); assert.equal(shown.source, plain.source); assert.equal(shown.note, 'Needed for the fix.');
  const applied = await f.decide(p, on.id, 'apply');
  assert.equal(applied.status, 'applied'); assert.equal(applied.enabled, true); assert.match(f.logs.at(-1).message, /turned on "Plain"/);
  assert.equal((await f.decide(p, on.id, 'revert')).status, 'reverted'); assert.equal(f.state.scripts[0].enabled, false);
  const blocked = (await f.call(p, 'propose_enabled', { id: deps.id, revision: deps.revision, enabled: true })).proposal;
  const refused = await f.decide(p, blocked.id, 'apply');
  assert.equal(refused.status, 'pending'); assert.equal(refused.needsDependencies, true); assert.match(refused.error, /Prepare this script’s dependencies/);
  const off = (await f.call(p, 'propose_enabled', { id: plain.id, revision: f.state.scripts[0].revision, enabled: true })).proposal;
  f.state.failEnable = 'Userscripts are unavailable.';
  const failed = await f.decide(p, off.id, 'apply');
  assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'Userscripts are unavailable.');
});

test('Apply & enable reports a save that could not be turned on, and needs prepared dependencies', async t => {
  const f = fixture(t), p = f.approve(), pin = '// @require https://cdn.owned.test/lib.js#sha256=' + 'a'.repeat(64) + '\n';
  const created = (await f.call(p, 'propose_script', { source: source('Deps', 'void 0;', pin) }));
  assert.match(created.next, /dependencies must be prepared/);
  const refused = await f.decide(p, created.proposal.id, 'apply_enable');
  assert.equal(refused.status, 'pending'); assert.match(refused.error, /apply it without turning it on/); assert.equal(f.state.requests.length, 0);
  const prepared = await f.install('Prepared', { metadata: pin, assets: [{ kind: 'require' }] });
  const kept = (await f.call(p, 'propose_script', { source: source('Prepared', 'void 1;', pin), id: prepared.id, revision: prepared.revision })).proposal;
  assert.equal(f.latest(p, kept.id).needsDependencies, false);
  f.state.failEnable = 'Native registration failed.';
  const partial = await f.decide(p, kept.id, 'apply_enable');
  assert.equal(partial.status, 'applied'); assert.equal(partial.enabled, false); assert.match(partial.error, /Saved, but not turned on: Native registration failed/);
});

test('disconnect discards proposals; draft matching never saves', async t => {
  const f = fixture(t), p = f.approve();
  const draft = await f.call(p, 'check_url', { url: 'https://example.test/page', source: source('Draft', 'void 0;', '// @inject-into auto\n') });
  assert.equal(draft.draft.matches, true); assert.equal(draft.draft.world, 'USER_SCRIPT'); assert.equal(f.state.requests.length, 0);
  assert.match((await f.call(p, 'check_url', { url: 'https://example.test/', source: 'not a script' })).error, /Metadata error/);
  assert.equal((await f.call(p, 'status')).debug.readOnly, false);
  const proposal = (await f.call(p, 'propose_script', { source: source('Owned') })).proposal;
  p.disconnect();
  const next = f.approve(['status']);
  assert.equal((await f.call(next, 'status')).debug.readOnly, true);
  next.disconnect(); const again = f.approve();
  assert.match((await f.call(again, 'get_proposal', { proposalId: proposal.id })).error, /not found/);
  again.onMessage.fire({ type: 'decide', id: proposal.id, action: 'apply' }); await settle();
  assert.equal(f.state.requests.length, 0); assert.equal(again.closed, false);
});

test('protocol keeps change tools closed and pairs id with revision', () => {
  const tools = protocol.tools.filter(tool => tool.scope === protocol.CHANGES).map(tool => tool.name);
  assert.deepEqual(tools, ['module_engine_propose_script', 'module_engine_propose_enabled', 'module_engine_get_proposal']);
  for (const tool of protocol.tools) assert.equal(tool.annotations.readOnlyHint, !tool.name.includes('propose_'));
  assert.deepEqual(protocol.scopes(['status', 'scripts', 'logs', 'network', 'changes']), ['status', 'scripts', 'logs', 'network', 'changes']);
  assert.throws(() => protocol.scopes(['status', 'changes', 'delete']));
  assert.throws(() => protocol.call('module_engine_propose_script', { source: 'x', id: crypto.randomUUID() }), /together/);
  assert.throws(() => protocol.call('module_engine_propose_script', { source: 'x', revision: 1 }), /together/);
  assert.throws(() => protocol.call('module_engine_propose_enabled', { id: crypto.randomUUID(), revision: 1, enabled: 'yes' }));
  assert.throws(() => protocol.call('module_engine_propose_script', { source: 'x', delete: true }));
  assert.throws(() => protocol.call('module_engine_propose_script', { source: 'x', note: 'n'.repeat(501) }));
  assert.equal(protocol.call('module_engine_propose_script', { source: 'x' }).scope, protocol.CHANGES);
});
