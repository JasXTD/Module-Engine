const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const http = require('node:http');
const protocol = require('../src/shared/debug-protocol.js');
const { createServer } = require('../mcp/server.cjs');
const { client } = require('./mcp-client.cjs');
const origin = 'chrome-extension://' + 'a'.repeat(32);
async function fixture(t, options = {}) {
  const input = new PassThrough(), output = new PassThrough(); const server = createServer({ input, output, ...options });
  const { port } = await server.start(), c = client(input, output);
  t.after(async () => { await server.close(); c.dispose(); });
  const post = (route, token, body = {}, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', headers: { Origin: origin,
      Host: '127.0.0.1:' + port, 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...headers } }, res => {
      let raw = ''; res.on('data', chunk => { raw += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(raw) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const pair = async (scopes = ['status', 'scripts', 'logs']) => {
    const connection = await c.tool('connection'); const code = protocol.pairing(connection.pairingCode);
    const paired = await post('/pair', code.token, { scopes, browser: 'Offline fixture' }); assert.equal(paired.status, 200);
    return { ...paired.body, bootstrap: code.token };
  };
  return { ...c, input, output, server, port, post, pair };
}
test('MCP lifecycle and closed schemas expose only seven read-only tools', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('tools/list')).error.code, -32000);
  const init = await f.initialize(); assert.equal(init.result.protocolVersion, '2025-11-25');
  const { tools } = (await f.request('tools/list')).result; assert.equal(tools.length, 7);
  for (const tool of tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.inputSchema.additionalProperties, false); }
  for (const [name, args] of [['eval', {}], ['status', { action: 'disable' }], ['get_script', { id: '../source' }], ['get_logs', { limit: 101 }], ['get_network_log', {start:true}], ['get_network_log', {limit:101}], ['check_url', { url: 'file:///C:/' }], ['check_url', { url: 'https://user:pass@example.test/' }]]) {
    assert.equal((await f.tool(name, args)).error.code, -32602);
  }
  assert.equal((await f.tool('status')).ok, false);
  assert.equal((await f.request('resources/list')).error.code, -32601);
  assert.deepEqual((await f.request('ping')).result, {});
});

test('network reads need separate stdio bridge approval and forward only read arguments', async t => {
  const f=await fixture(t);await f.initialize();const previous=await f.pair();
  assert.match((await f.tool('get_network_log')).error,/scope/);await f.post('/disconnect',previous.token);
  const paired=await f.pair(['status','network']), args={url:'/local',limit:10,state:'error'};
  const pending=f.tool('get_network_log',args),job=(await f.post('/poll',paired.token)).body.request;
  assert.equal(job.name,'module_engine_get_network_log');assert.deepEqual(job.arguments,args);
  await f.post('/result',paired.token,{id:job.id,result:{ok:true,entries:[],capture:{active:false}}});assert.equal((await pending).capture.active,false);
  await f.post('/disconnect',paired.token);assert.equal((await f.tool('get_network_log')).ok,false);
});
test('bridge rejects webpage origins, rebound Hosts, missing credentials and consumed pairing codes', async t => {
  const f = await fixture(t); await f.initialize();
  const code = protocol.pairing((await f.tool('connection')).pairingCode);
  for (const headers of [{ Origin: 'https://example.test' }, { Origin: 'null' }, { Host: 'evil.test:' + f.port }, { Origin: '' }]) {
    const r = await f.post('/pair', code.token, { scopes: ['status'] }, headers); assert.equal(r.status, 403); assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await f.post('/pair', 'wrong', { scopes: ['status'] })).status, 401);
  assert.equal((await f.post('/pair', code.token, { scopes: ['status', 'write'] })).status, 400);
  const p = await f.pair(['status']); assert.notEqual(p.token, p.bootstrap);
  assert.equal((await f.post('/pair', p.bootstrap, { scopes: ['status'] })).status, 401);
  assert.equal((await f.post('/poll', p.bootstrap)).status, 401);
  assert.equal((await f.post('/poll', p.token, {}, { Origin: 'moz-extension://12345678-1234-1234-1234-123456789abc' })).status, 401);
  assert.match((await f.tool('list_scripts')).error, /scope/);
  assert.equal((await f.tool('connection')).connected, true);
});
test('authenticated read roundtrip, cancellation, disconnect and stale results', async t => {
  const f = await fixture(t); await f.initialize(); const p = await f.pair();
  const reading = f.tool('status'); const job = (await f.post('/poll', p.token)).body.request;
  assert.equal(job.name, 'module_engine_status');
  await f.post('/result', p.token, { id: job.id, result: { ok: true, observed: 'fixture' } });
  assert.deepEqual(await reading, { ok: true, observed: 'fixture' });
  const cancel = f.request('tools/call', { name: 'module_engine_status', arguments: {} }); cancel.catch(() => {});
  const cancelledJob = (await f.post('/poll', p.token)).body.request;
  f.notify('notifications/cancelled', { requestId: cancel.id });
  await f.post('/result', p.token, { id: cancelledJob.id, result: { ok: true } });
  await f.request('ping'); assert.equal(f.received.some(item => item.id === cancel.id), false);
  const pending = f.tool('status'); await f.post('/poll', p.token);
  await f.post('/disconnect', p.token);
  assert.match((await pending).error, /disconnected/);
  assert.equal((await f.post('/result', p.token, { id: job.id, result: { ok: true } })).status, 401);
  assert.equal((await f.tool('status')).ok, false);
  assert.notEqual(protocol.pairing((await f.tool('connection')).pairingCode).token, p.bootstrap);
});
test('malformed and split UTF-8 stdio frames do not become tools', async t => {
  const f = await fixture(t); f.input.write('{bad}\n'); await f.initialize();
  assert.equal(f.received[0].error.code, -32700);
  const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping', params: { label: '本' } }) + '\n');
  const index = bytes.indexOf(Buffer.from('本'));
  f.input.write(bytes.subarray(0, index + 1)); f.input.write(bytes.subarray(index + 1));
  await f.request('ping'); assert.deepEqual(f.received.find(item => item.id === 100).result, {});
  f.input.write(Buffer.from([0xff, 10])); await f.request('ping'); assert.equal(f.received.filter(item => item.error?.code === -32700).length, 2);
});
test('oversized input closes the listener and releases stdin', async t => {
  const f = await fixture(t); f.input.write(Buffer.alloc(protocol.MAX_BYTES + 1, 65));
  assert.equal(f.input.destroyed, true);
  await assert.rejects(f.post('/pair', 'none'), /ECONNREFUSED|ECONNRESET/);
});
test('oversized escaped results return a bounded error without losing the connection', async t => {
  const f = await fixture(t); await f.initialize(); const p = await f.pair();
  const pending = f.request('tools/call', { name: 'module_engine_status' }); const job = (await f.post('/poll', p.token)).body.request;
  await f.post('/result', p.token, { id: job.id, result: { ok: true, source: '"'.repeat(200000) } });
  const result = (await pending).result; assert.equal(result.isError, true); assert.match(result.content[0].text, /transport limit/);
  assert.equal((await f.tool('connection')).connected, true);
});
test('pairing expiry, session expiry and stale polling leases revoke access at the boundary', async t => {
  const f = await fixture(t); await f.initialize(); let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const old = protocol.pairing((await f.tool('connection')).pairingCode); now += 120001;
  assert.equal((await f.post('/pair', old.token, { scopes: ['status'] })).status, 401);
  const fresh = await f.pair(); now += protocol.SESSION_MS;
  assert.equal((await f.tool('status')).ok, false); assert.equal((await f.post('/poll', fresh.token)).status, 401);
  const lease = await f.pair(); now += 30001;
  assert.equal((await f.tool('connection')).connected, false); assert.equal((await f.post('/poll', lease.token)).status, 401);
});
test('pending reads are bounded and disconnect resolves every outstanding tool call', async t => {
  const f = await fixture(t); await f.initialize(); const p = await f.pair();
  const waiting = Array.from({ length: 8 }, () => f.tool('status'));
  assert.match((await f.tool('status')).error, /pending/);
  await f.post('/disconnect', p.token);
  assert.ok((await Promise.all(waiting)).every(result => result.ok === false));
});

test('a default server stays read-only: change tools are hidden and change approval is dropped at pairing', async t => {
  const f = await fixture(t); const init = await f.initialize();
  assert.match(init.result.instructions, /^Read-only/);
  const { tools } = (await f.request('tools/list')).result;
  assert.equal(tools.some(tool => tool.name.includes('propose') || tool.name.includes('proposal')), false);
  assert.equal((await f.tool('connection')).changesOffered, false);
  for (const [name, args] of [['propose_script', { source: '// x' }], ['get_proposal', { proposalId: '12345678-1234-1234-1234-123456789abc' }]])
    assert.equal((await f.tool(name, args)).error.code, -32602);
  const paired = await f.pair(['status', 'scripts', 'changes']);
  assert.deepEqual(paired.scopes, ['status', 'scripts']);
});
test('--allow-changes advertises review-gated proposals and forwards them only after change approval', async t => {
  const f = await fixture(t, { allowChanges: true }); const init = await f.initialize();
  assert.match(init.result.instructions, /review-gated/);
  const { tools } = (await f.request('tools/list')).result; assert.equal(tools.length, 10);
  const propose = tools.find(tool => tool.name === 'module_engine_propose_script');
  assert.equal(propose.annotations.readOnlyHint, false); assert.equal(propose.annotations.destructiveHint, false); assert.equal(propose.inputSchema.additionalProperties, false);
  assert.equal(tools.find(tool => tool.name === 'module_engine_get_proposal').annotations.readOnlyHint, true);
  assert.equal((await f.tool('propose_script', { source: '// x', id: '12345678-1234-1234-1234-123456789abc' })).error.code, -32602);
  assert.match((await f.tool('connection')).instructions, /Propose script changes for my review/);
  const readOnly = await f.pair(['status', 'scripts']); assert.deepEqual(readOnly.scopes, ['status', 'scripts']);
  assert.match((await f.tool('propose_script', { source: '// x' })).error, /change scope/);
  await f.post('/disconnect', readOnly.token);
  const p = await f.pair(['status', 'changes']); assert.deepEqual(p.scopes, ['status', 'changes']);
  const args = { source: '// proposed', note: 'Fixes the banner.' }, pending = f.tool('propose_script', args);
  const job = (await f.post('/poll', p.token)).body.request;
  assert.equal(job.name, 'module_engine_propose_script'); assert.deepEqual(job.arguments, args);
  await f.post('/result', p.token, { id: job.id, result: { ok: true, proposal: { status: 'pending' } } });
  assert.equal((await pending).proposal.status, 'pending');
});
