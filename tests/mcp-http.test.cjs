/* Offline protocol and trust-boundary tests. All sockets bind literal loopback. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { PassThrough } = require('node:stream');
const path = require('node:path');
const protocol = require('../src/shared/debug-protocol.js');
const { createServer } = require('../mcp/server.cjs');
const { httpRequest, httpClient, processClient } = require('./mcp-client.cjs');
const origin = 'chrome-extension://' + 'a'.repeat(32);
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' }
} };
const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
async function fixture(t) {
  const token = randomBytes(32).toString('base64url');
  const input = new PassThrough(), output = new PassThrough();
  const server = createServer({ input, output, http: { port: 0, token } });
  const { port, url } = await server.start(); const client = httpClient(url, token);
  t.after(() => server.close());
  const post = (body, headers = {}) => httpRequest(url, token, { body, headers });
  const bridge = (route, bearer, body = {}) => httpRequest('http://127.0.0.1:' + port + route, bearer, { body, headers: { Origin: origin } });
  const pair = async (scopes = ['status', 'scripts', 'logs']) => {
    const code = protocol.pairing((await client.tool('connection')).pairingCode);
    const paired = await bridge('/pair', code.token, { scopes, browser: 'Offline fixture' });
    assert.equal(paired.status, 200); return { ...paired.body, bootstrap: code.token };
  };
  return { token, input, output, server, port, url, client, post, bridge, pair };
}
test('HTTP options fail closed; stdio remains the default even with a token in the environment', async t => {
  for (const options of [{ port: 0 }, { port: 0, token: 'weak' }, { port: -1, token: 'a'.repeat(43) }, { port: 65536, token: 'a'.repeat(43) }])
    assert.throws(() => createServer({ http: options }));
  const c = await processClient(); t.after(() => c.close());
  assert.equal((await c.initialize()).result.serverInfo.name, 'module-engine');
  assert.equal((await c.tool('status')).ok, false);
});
test('HTTP rejects missing or wrong authentication, browser Origins, rebound Hosts and alternate paths', async t => {
  const f = await fixture(t);
  for (const headers of [{ Authorization: '' }, { Authorization: 'Bearer wrong' }, { Authorization: f.token }, { Authorization: 'Basic ' + f.token }])
    assert.equal((await f.post(initialize, headers)).status, 401);
  for (const headers of [{ Origin: 'https://example.test' }, { Origin: 'null' }, { Origin: '' }, { Origin: origin },
    { Origin: new URL(f.url).origin }, { Host: 'localhost:' + new URL(f.url).port }, { Host: 'evil.test', 'X-Forwarded-Host': new URL(f.url).host }]) {
    const reply = await f.post(initialize, headers); assert.equal(reply.status, 403);
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
  }
  for (const suffix of ['?token=unused', '/', '/pair']) assert.equal((await httpRequest(f.url + suffix, f.token, { body: initialize })).status, 404);
  const reply = await f.post(initialize); assert.equal(reply.status, 200);
  assert.equal(reply.headers['cache-control'], 'no-store'); assert.equal(reply.headers['x-content-type-options'], 'nosniff');
  assert.match(reply.headers['mcp-session-id'], /^[A-Za-z0-9_-]{43}$/);
});
test('HTTP methods, media negotiation, duplicate headers and malformed frames fail without opening a session', async t => {
  const f = await fixture(t);
  for (const method of ['GET', 'OPTIONS', 'PUT', 'HEAD']) {
    const reply = await httpRequest(f.url, f.token, { method }); assert.equal(reply.status, 405); assert.equal(reply.headers.allow, 'POST, DELETE');
    assert.equal(reply.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }]) assert.equal((await f.post(initialize, headers)).status, 415);
  for (const Accept of ['', 'application/json', 'application/json, text/event-stream;q=0']) assert.equal((await f.post(initialize, { Accept })).status, 406);
  for (const body of [Buffer.from('{bad'), Buffer.from([0xff])]) {
    const reply = await f.post(body); assert.equal(reply.status, 400); assert.equal(reply.body.error.code, -32700);
  }
  for (const body of [[], [initialize], null, 'ping', { id: 1, method: 'ping' }]) assert.equal((await f.post(body)).status, 400);
  const raw = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(f.url).port) }); let data = '';
    socket.setTimeout(3000, () => socket.destroy(new Error('Duplicate-header fixture timed out.')));
    socket.on('error', reject); socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolve(data));
    socket.on('connect', () => socket.end('POST /mcp HTTP/1.1\r\nHost: ' + new URL(f.url).host + '\r\nAuthorization: Bearer ' + f.token +
      '\r\nauthorization: Bearer ' + f.token + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'));
  });
  assert.match(raw, /^HTTP\/1.1 400 /);
  assert.equal((await f.post({ ...initialize, id: {} })).status, 400);
  assert.equal((await f.post(initialize, { 'Content-Type': 'application/json; charset=utf-8' })).status, 200);
});
test('HTTP initialization is exclusive and session/version headers cannot bypass lifecycle or schemas', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(ping)).status, 400);
  const replies = await Promise.all([f.post(initialize), f.post(initialize)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  const headers = { 'MCP-Session-Id': replies.find(r => r.status === 200).headers['mcp-session-id'] };
  assert.equal((await f.post(ping)).status, 400);
  assert.equal((await f.post(ping, { 'MCP-Session-Id': 'a'.repeat(43) })).status, 404);
  for (const version of ['unknown', '2024-11-05']) assert.equal((await f.post(ping, { ...headers, 'MCP-Protocol-Version': version })).status, 400);
  assert.equal((await f.post({ ...ping, method: 'tools/list' }, headers)).body.error.code, -32000);
  const notification = await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  assert.equal(notification.status, 202); assert.equal(notification.body, undefined);
  const tools = (await f.post({ ...ping, method: 'tools/list' }, headers)).body.result.tools;
  assert.equal(tools.length, 7); assert.ok(tools.every(tool => tool.annotations.readOnlyHint && !tool.inputSchema.additionalProperties));
  for (const [method, params, code] of [['tools/call', { name: 'module_engine_eval', arguments: {} }, -32602],
    ['tools/call', { name: 'module_engine_status', arguments: { action: 'disable' } }, -32602], ['resources/list', {}, -32601]])
    assert.equal((await f.post({ ...ping, method, params }, headers)).body.error.code, code);
  assert.equal((await f.post(initialize, headers)).body.error.code, -32602);
});
test('HTTP and browser credentials stay separate; approved read roundtrips preserve scopes and cancellation', async t => {
  const f = await fixture(t); await f.client.initialize();
  assert.equal((await f.client.tool('status')).ok, false);
  const code = protocol.pairing((await f.client.tool('connection')).pairingCode);
  assert.equal((await f.bridge('/pair', f.token, { scopes: ['status'] })).status, 401);
  assert.equal((await httpRequest(f.url, code.token, { body: initialize })).status, 401);
  const paired = await f.pair(['status']);
  assert.equal((await httpRequest(f.url, paired.token, { body: initialize })).status, 401);
  assert.match((await f.client.tool('get_logs')).error, /scope/);
  const read = f.client.tool('status'); const job = (await f.bridge('/poll', paired.token)).body.request;
  assert.equal(job.name, 'module_engine_status');
  await f.bridge('/result', paired.token, { id: job.id, result: { ok: true, observed: 'offline' } });
  assert.deepEqual(await read, { ok: true, observed: 'offline' });
  const pending = f.client.request('tools/call', { name: 'module_engine_status' });
  const cancelled = (await f.bridge('/poll', paired.token)).body.request;
  await f.client.notify('notifications/cancelled', { requestId: pending.id });
  assert.equal((await pending).error.code, -32800);
  await f.bridge('/result', paired.token, { id: cancelled.id, result: { ok: true, stale: true } });
  assert.deepEqual((await f.client.request('ping')).result, {});
});
test('HTTP DELETE revokes browser pairing and pending reads; reconnect cannot inherit approval or stale results', async t => {
  const f = await fixture(t); await f.client.initialize(); const paired = await f.pair();
  const read = f.client.tool('status'); const rejected = assert.rejects(read, /404/);
  const job = (await f.bridge('/poll', paired.token)).body.request;
  assert.equal((await httpRequest(f.url, f.token, { method: 'DELETE' })).status, 400);
  assert.equal((await httpRequest(f.url, 'wrong', { method: 'DELETE' })).status, 401);
  await f.client.disconnect(); await rejected;
  assert.equal((await f.bridge('/result', paired.token, { id: job.id, result: { ok: true, stale: true } })).status, 401);
  assert.equal((await f.bridge('/pair', paired.bootstrap, { scopes: ['status'] })).status, 401);
  const next = httpClient(f.url, f.token); await next.initialize();
  assert.equal((await next.tool('status')).ok, false);
  const code = protocol.pairing((await next.tool('connection')).pairingCode);
  assert.ok(code.token !== paired.bootstrap);
});
test('HTTP session expiry revokes outstanding reads and requires initialization and new browser approval', async t => {
  const f = await fixture(t); await f.client.initialize(); const paired = await f.pair();
  const read = f.client.tool('status'); const rejected = assert.rejects(read, /404/);
  await f.bridge('/poll', paired.token);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + protocol.SESSION_MS);
  await assert.rejects(f.client.request('ping'), /404/); await rejected;
  assert.equal((await f.bridge('/poll', paired.token)).status, 401);
  const next = httpClient(f.url, f.token); await next.initialize(); assert.equal((await next.tool('status')).ok, false);
});
test('HTTP duplicate request IDs cannot steal a pending result, and escaped results stay bounded', async t => {
  const f = await fixture(t);
  const init = await f.post(initialize), headers = { 'MCP-Session-Id': init.headers['mcp-session-id'] };
  await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  const connection = await f.post({ ...ping, method: 'tools/call', params: { name: 'module_engine_connection' } }, headers);
  const code = protocol.pairing(JSON.parse(connection.body.result.content[0].text).pairingCode);
  const paired = (await f.bridge('/pair', code.token, { scopes: ['status'] })).body;
  const message = { ...ping, method: 'tools/call', params: { name: 'module_engine_status' } };
  const first = f.post(message, headers); const job = (await f.bridge('/poll', paired.token)).body.request;
  const duplicate = await f.post(message, headers); assert.equal(duplicate.body.error.code, -32600);
  await f.bridge('/result', paired.token, { id: job.id, result: { ok: true, source: '"'.repeat(200000) } });
  const reply = await first; assert.equal(reply.body.result.isError, true); assert.match(reply.body.result.content[0].text, /transport limit/);
  assert.deepEqual((await f.post(ping, headers)).body.result, {});
});
test('HTTP bounds declared and chunked bodies and gives a slow sender a finite deadline', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(initialize, { 'Content-Length': protocol.MAX_BYTES + 1 })).status, 413);
  assert.equal((await f.post(Buffer.alloc(protocol.MAX_BYTES + 1, 32), { 'Transfer-Encoding': 'chunked' })).status, 413);
  const started = Date.now();
  const status = await new Promise((resolve, reject) => {
    const req = http.request(f.url, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Transfer-Encoding': 'chunked' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.write('{'); t.after(() => req.destroy());
  });
  assert.equal(status, 408); assert.ok(Date.now() - started < 10000);
  assert.equal((await f.post(initialize)).status, 200);
});
test('dropping an HTTP response does not cancel or replay its browser read', async t => {
  const f = await fixture(t), init = await f.post(initialize), headers = { 'MCP-Session-Id': init.headers['mcp-session-id'] };
  await f.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers);
  const connection = await f.post({ ...ping, method: 'tools/call', params: { name: 'module_engine_connection' } }, headers);
  const code = protocol.pairing(JSON.parse(connection.body.result.content[0].text).pairingCode);
  const paired = (await f.bridge('/pair', code.token, { scopes: ['status'] })).body;
  const message = { ...ping, method: 'tools/call', params: { name: 'module_engine_status' } };
  const req = http.request(f.url, { method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + f.token,
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } });
  req.on('error', () => {}); t.after(() => req.destroy()); req.end(JSON.stringify(message));
  const job = (await f.bridge('/poll', paired.token)).body.request;
  const closed = new Promise(resolve => req.once('close', resolve)); req.destroy(); await closed;
  assert.equal((await f.post(message, headers)).body.error.code, -32600);
  await f.bridge('/result', paired.token, { id: job.id, result: { ok: true, observed: 'discarded' } });
  assert.deepEqual((await f.post(ping, headers)).body.result, {});
});
test('HTTP concurrent bodies are bounded and authenticated DELETE remains available during saturation', async t => {
  const f = await fixture(t), init = await f.post(initialize), sessionId = init.headers['mcp-session-id'];
  const pending = [];
  t.after(() => { for (const req of pending) req.destroy(); });
  for (let i = 0; i < 16; i++) {
    const req = http.request(f.url, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token,
      'MCP-Session-Id': sessionId, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Expect: '100-continue', 'Content-Length': '100' } });
    req.on('error', () => {}); req.on('response', res => res.resume()); pending.push(req);
    const continuing = once(req, 'continue'); req.flushHeaders(); await continuing;
  }
  assert.equal((await f.post(ping, { 'MCP-Session-Id': sessionId })).status, 429);
  assert.equal((await httpRequest(f.url, f.token, { method: 'DELETE', headers: { 'MCP-Session-Id': sessionId } })).status, 204);
});
test('HTTP rechecks session ownership after a delayed request body', async t => {
  const f = await fixture(t), init = await f.post(initialize), sessionId = init.headers['mcp-session-id'];
  const payload = JSON.stringify({ ...ping, method: 'tools/call', params: { name: 'module_engine_connection' } });
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request(f.url, { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'MCP-Session-Id': sessionId,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Expect: '100-continue', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject);
  });
  const continuing = once(req, 'continue'); req.flushHeaders(); await continuing;
  await httpRequest(f.url, f.token, { method: 'DELETE', headers: { 'MCP-Session-Id': sessionId } });
  assert.equal((await f.post(initialize)).status, 200);
  req.end(payload); assert.equal(await response, 404);
});
test('HTTP listener failures and explicit shutdown release resources without taking over a busy port', async t => {
  const busy = http.createServer(); await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => busy.close(resolve)));
  const server = createServer({ http: { port: busy.address().port, token: randomBytes(32).toString('base64url') } });
  await assert.rejects(server.start(), { code: 'EADDRINUSE' }); await server.close(); assert.ok(busy.listening);
  const f = await fixture(t); await f.client.initialize(); await f.server.close();
  await assert.rejects(f.client.request('ping'), /ECONNREFUSED|ECONNRESET/);
  assert.equal(f.input.destroyed, false); // HTTP does not own stdin.
});
test('CLI HTTP needs explicit flags and a valid environment token; token generation is opt-in', () => {
  const command = path.join(__dirname, '..', 'mcp', 'server.cjs');
  for (const args of [['--http'], ['--http', '--stdio'], ['--port', '8765'], ['--http', '--port', '-1'], ['--http', '--port', '65536'], ['--host', '0.0.0.0']]) {
    // Process startup competes with the full test suite; this is not a startup-speed assertion.
    const child = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000, env: { ...process.env, MODULE_ENGINE_MCP_TOKEN: '' } });
    assert.ifError(child.error); assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.match(child.stderr, /Module Engine MCP:/);
  }
  const generated = spawnSync(process.execPath, [command, '--generate-token'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.ifError(generated.error); assert.equal(generated.status, 0); assert.equal(generated.stderr, ''); assert.ok(/^[A-Za-z0-9_-]{43}\r?\n$/.test(generated.stdout));
});
test('real HTTP process continues after stdin EOF, serves seven tools, then the owned fixture stops it', async () => {
  const c = await processClient({ transport: 'http' });
  try {
    c.child.stdin.end(); await c.initialize();
    assert.equal((await c.request('tools/list')).result.tools.length, 7); assert.equal((await c.tool('status')).ok, false);
  } finally {
    const exit = await c.close(); assert.equal(exit.stderr, ''); assert.equal(exit.stdout, '');
    assert.ok(exit.code === 0 || exit.signal === 'SIGTERM');
  }
});
