/* Stdio by default, opt-in localhost HTTP. Only a paired extension can answer reads. */
'use strict';
const http = require('node:http');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { TextDecoder, parseArgs } = require('node:util');
const protocol = require('../src/shared/debug-protocol.js');
const { createRPC, failure } = require('./rpc.cjs');
const { createHTTP, validateOptions } = require('./http.cjs');
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const extensionOrigin = value => typeof value === 'string' && /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/.test(value);
function createServer({ input = process.stdin, output = process.stdout, http: httpOptions } = {}) {
  if (httpOptions) validateOptions(httpOptions);
  const jobs = new Map();
  let session, pairing, poll, port, closed = false, closing, inputBytes = Buffer.alloc(0), outputBytes = 0;
  let writing = Promise.resolve();
  const wire = value => {
    if (closed) return;
    const line = JSON.stringify(value) + '\n', size = Buffer.byteLength(line);
    if (size > protocol.MAX_BYTES || outputBytes + size > 2 * protocol.MAX_BYTES) { void close(); return; }
    outputBytes += size;
    writing = writing.then(() => closed ? undefined : new Promise((resolve, reject) => output.write(line, error => error ? reject(error) : resolve())))
      .catch(() => { void close(); }).finally(() => { outputBytes -= size; });
  };
  const finish = (job, error, result) => {
    if (!jobs.delete(job.id)) return;
    clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
  };
  function disconnect(reason) {
    session = undefined;
    if (poll) { const waiting = poll; poll = undefined; clearTimeout(waiting.timer); sendHTTP(waiting.response, 410, { error: reason }); }
    for (const job of [...jobs.values()]) finish(job, new Error(reason));
  }
  function connection() {
    expire();
    if (session) return { connected: true, browser: session.browser, scopes: session.scopes, expiresAt: session.expiresAt };
    if (!pairing || pairing.expiresAt <= Date.now()) pairing = { token: secret(), expiresAt: Date.now() + 120000 };
    return { connected: false, pairingCode: 'ME1.' + port + '.' + pairing.token, pairingExpiresAt: pairing.expiresAt,
      instructions: 'Open Module Engine → Modules & scripts → MCP. Paste this code, choose what to share and click Connect read-only. Keep that page open.' };
  }
  function sendHTTP(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  }
  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > protocol.MAX_BYTES) throw new Error('Request exceeds the size limit.');
      chunks.push(chunk);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  }
  function dispatch() {
    if (!poll) return;
    const job = [...jobs.values()].find(item => !item.sent);
    if (!job) return;
    const waiting = poll; poll = undefined; clearTimeout(waiting.timer); job.sent = true;
    sendHTTP(waiting.response, 200, { request: { id: job.id, name: job.name, arguments: job.args } });
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void handleHTTP(req, res).catch(() => { sendHTTP(res, 400, { error: 'Invalid local bridge request.' }); });
  });
  server.maxConnections = 12; server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('clientError', (_error, socket) => socket.destroy());
  async function handleHTTP(req, res) {
    expire();
    if (closed || req.headers.host !== '127.0.0.1:' + port || !extensionOrigin(req.headers.origin) ||
        req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || !['/pair', '/poll', '/result', '/disconnect'].includes(req.url)) {
      sendHTTP(res, 403, { error: 'Local extension requests only.' }); req.resume(); return;
    }
    const supplied = req.headers.authorization?.replace(/^Bearer /, '');
    if (req.url === '/pair') {
      if (session || !pairing || pairing.expiresAt <= Date.now() || !equal(supplied, pairing.token)) { sendHTTP(res, 401, { error: 'Pairing code expired or unavailable.' }); req.resume(); return; }
      const expected = pairing, body = await readBody(req), approved = protocol.scopes(body.scopes);
      if (pairing !== expected || session || expected.expiresAt <= Date.now()) { sendHTTP(res, 409, { error: 'Pairing already consumed.' }); return; }
      session = { token: secret(), origin: req.headers.origin, scopes: approved, browser: typeof body.browser === 'string' ? body.browser.slice(0, 64) : 'Browser',
        expiresAt: Date.now() + protocol.SESSION_MS, seen: Date.now() };
      pairing = undefined;
      sendHTTP(res, 200, { token: session.token, expiresAt: session.expiresAt }); return;
    }
    const current = session;
    if (!current || current.expiresAt <= Date.now() || current.origin !== req.headers.origin || !equal(supplied, current.token)) {
      sendHTTP(res, 401, { error: 'Debug connection is unavailable.' }); req.resume(); return;
    }
    const body = await readBody(req);
    expire();
    if (session !== current) { sendHTTP(res, 410, { error: 'Debug connection ended.' }); return; }
    current.seen = Date.now();
    if (req.url === '/disconnect') { disconnect('The browser disconnected.'); sendHTTP(res, 200, { ok: true }); return; }
    if (req.url === '/result') {
      const job = jobs.get(body.id);
      if (job?.sent) {
        if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) { sendHTTP(res, 400, { error: 'Invalid result.' }); return; }
        finish(job, null, body.result);
      }
      sendHTTP(res, 200, { ok: true }); return;
    }
    if (poll) { sendHTTP(res, 409, { error: 'A poll is already pending.' }); return; }
    const waiting = { response: res, timer: setTimeout(() => { if (poll === waiting) { poll = undefined; sendHTTP(res, 200, {}); } }, 15000) };
    poll = waiting;
    res.on('close', () => { if (poll === waiting) { clearTimeout(waiting.timer); poll = undefined; } });
    dispatch();
  }
  function readTool(name, args, signal) {
    expire();
    if (signal?.aborted) throw new Error('Debug request cancelled.');
    const tool = protocol.call(name, args);
    if (!tool.scope) return Promise.resolve(connection());
    if (!session) throw new Error('Connect a browser first with module_engine_connection.');
    if (!session.scopes.includes(tool.scope)) throw new Error('The browser has not approved this read scope.');
    if (jobs.size >= 8) throw new Error('Too many pending debugging reads.');
    return new Promise((resolve, reject) => {
      const job = { id: randomUUID(), name, args, signal, resolve, reject, sent: false };
      job.abort = () => finish(job, new Error('Debug request cancelled.'));
      job.timer = setTimeout(() => finish(job, new Error('Browser read timed out. No operation was retried.')), 10000);
      jobs.set(job.id, job); signal?.addEventListener('abort', job.abort, { once: true }); dispatch();
    });
  }
  const rpc = createRPC(readTool);
  const httpServer = httpOptions ? createHTTP({ ...httpOptions, readTool,
    revokeBrowser(reason) { pairing = undefined; disconnect(reason); }
  }) : null;
  function expire() { if (session && (session.expiresAt <= Date.now() || session.seen + 30000 <= Date.now())) disconnect('Debug connection expired.'); }
  const sweep = setInterval(expire, 1000);
  sweep.unref();
  function close() {
    if (closing) return closing;
    closed = true; clearInterval(sweep); pairing = undefined; disconnect('MCP server stopped.');
    rpc.close();
    if (!httpServer) {
      input.removeListener('data', onData); input.removeListener('end', close); input.removeListener('error', close);
      input.pause(); input.destroy();
    }
    inputBytes = Buffer.alloc(0); server.closeAllConnections();
    closing = Promise.all([httpServer?.close(), server.listening ? new Promise(resolve => server.close(resolve)) : undefined]).then(() => {});
    return closing;
  }
  function onData(chunk) {
    inputBytes = Buffer.concat([inputBytes, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let newline;
    while ((newline = inputBytes.indexOf(10)) !== -1) {
      const line = inputBytes.subarray(0, newline); inputBytes = inputBytes.subarray(newline + 1);
      if (line.length > protocol.MAX_BYTES) { void close(); return; }
      try { void rpc.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))).then(result => { if (result) wire(result); }).catch(() => wire(failure(null, -32603, 'Internal protocol error.'))); }
      catch { wire(failure(null, -32700, 'Invalid JSON.')); }
    }
    if (inputBytes.length > protocol.MAX_BYTES) void close();
  }
  return {
    async start() {
      try {
        await new Promise((resolve, reject) => {
          const failed = error => { server.removeListener('listening', ready); reject(error); };
          const ready = () => { server.removeListener('error', failed); resolve(); };
          server.once('error', failed); server.once('listening', ready); server.listen(0, '127.0.0.1');
        });
        port = server.address().port;
        if (httpServer) return { port, ...await httpServer.start() };
        input.on('data', onData); input.once('end', close); input.once('error', close); output.once('error', close);
        return { port };
      } catch (error) { await close(); throw error; }
    }, close
  };
}
module.exports = { createServer };
if (require.main === module) {
  try {
    const { values } = parseArgs({ options: { http: { type: 'boolean' }, stdio: { type: 'boolean' },
      port: { type: 'string' }, help: { type: 'boolean' }, 'generate-token': { type: 'boolean' } } });
    if (values.help || values['generate-token']) {
      if (Object.keys(values).length !== 1) throw new Error('Use --help or --generate-token on its own.');
      process.stdout.write(values.help ? 'Module Engine MCP (Node 22+)\n  node mcp/server.cjs [--stdio]\n  node mcp/server.cjs --http [--port 8765]\n  node mcp/server.cjs --generate-token\nHTTP requires MODULE_ENGINE_MCP_TOKEN. Binds only 127.0.0.1; approve browser reads separately.\n' : secret() + '\n');
    } else {
      if (values.http && values.stdio || values.port !== undefined && !values.http) throw new Error('Choose stdio (default) or --http [--port 8765].');
      if (values.port !== undefined && !/^(0|[1-9][0-9]{0,4})$/.test(values.port)) throw new Error('Invalid HTTP port.');
      const server = createServer(values.http ? { http: { port: Number(values.port ?? 8765), token: process.env.MODULE_ENGINE_MCP_TOKEN } } : {});
      server.start().then(address => { if (address.url) process.stderr.write('Module Engine MCP listening at ' + address.url + '\n'); })
        .catch(() => { process.stderr.write('Module Engine MCP could not start. Check that the local port is available.\n'); process.exitCode = 1; void server.close(); });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void server.close(); process.stdin.destroy(); });
    }
  } catch (error) { process.stderr.write('Module Engine MCP: ' + error.message + '\n'); process.exitCode = 1; }
}
