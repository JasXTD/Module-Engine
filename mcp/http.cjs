/* Native-client Streamable HTTP: loopback, bearer authentication, one expiring session. */
'use strict';
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { TextDecoder } = require('node:util');
const protocol = require('../src/shared/debug-protocol.js');
const { createRPC, failure } = require('./rpc.cjs');
const tokenShape = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function validateOptions({ port, token }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('HTTP port must be an integer from 0 to 65535.');
  if (!tokenShape(token)) throw new Error('Set MODULE_ENGINE_MCP_TOKEN to a locally generated 32-byte base64url token.');
}
function createHTTP({ port: requestedPort, token, readTool, revokeBrowser, allowChanges = false }) {
  validateOptions({ port: requestedPort, token });
  let port, session, active = 0, closed = false, closing;
  const auth = value => tokenShape(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token));
  function revoke(reason) {
    const previous = session; session = undefined;
    previous?.rpc.close(); revokeBrowser(reason);
  }
  function expire() { if (session && session.expiresAt <= Date.now()) revoke('HTTP MCP session expired.'); }
  const sweep = setInterval(expire, 1000); sweep.unref();
  function reply(res, status, body, headers = {}) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Connection: 'close', ...headers });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  }
  const deny = (res, status, message, headers) => reply(res, status, { error: message }, headers);
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      const finish = (error, value) => {
        clearTimeout(timer); req.removeListener('data', data); req.removeListener('end', end);
        req.removeListener('error', aborted); req.removeListener('aborted', aborted);
        if (error) { req.resume(); reject(error); } else resolve(value);
      };
      const data = chunk => {
        size += chunk.length;
        if (size > protocol.MAX_BYTES) finish(Object.assign(new Error('Request exceeds 512 KiB.'), { status: 413 }));
        else chunks.push(chunk);
      };
      const end = () => {
        try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
        catch { finish(Object.assign(new Error('Invalid JSON.'), { status: 400, parse: true })); }
      };
      const aborted = () => finish(Object.assign(new Error('Request interrupted.'), { status: 400 }));
      const timer = setTimeout(() => finish(Object.assign(new Error('Request body timed out.'), { status: 408 })), 5000);
      req.on('data', data); req.once('end', end); req.once('error', aborted); req.once('aborted', aborted);
    });
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    void handle(req, res).catch(() => deny(res, 500, 'Local MCP request failed.'));
  });
  server.maxConnections = 24; server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  server.setTimeout(15000, socket => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  function accepts(value, type) {
    return typeof value === 'string' && value.split(',').some(part => {
      const [media, ...parameters] = part.trim().toLowerCase().split(';');
      const q = parameters.find(parameter => /^\s*q\s*=/.test(parameter));
      return media.trim() === type && (!q || Number(q.split('=')[1]) > 0);
    });
  }
  async function handle(req, res) {
    // Reject ambiguous headers and all browser Origins before inspecting credentials.
    const seen = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (seen.has(name)) { deny(res, 400, 'Duplicate headers are not accepted.'); req.resume(); return; }
      seen.add(name);
    }
    if (closed || req.headers.host !== '127.0.0.1:' + port || Object.hasOwn(req.headers, 'origin')) {
      deny(res, 403, 'Native loopback clients only.'); req.resume(); return;
    }
    if (!auth(req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1])) {
      deny(res, 401, 'A valid MCP bearer token is required.', { 'WWW-Authenticate': 'Bearer realm="module-engine"' }); req.resume(); return;
    }
    if (req.url !== '/mcp') { deny(res, 404, 'Endpoint not found.'); req.resume(); return; }
    if (!['POST', 'DELETE'].includes(req.method)) {
      deny(res, 405, 'Use POST or DELETE. No SSE stream is offered.', { Allow: 'POST, DELETE' }); req.resume(); return;
    }
    expire();
    const suppliedId = req.headers['mcp-session-id'];
    const current = session;
    if (suppliedId !== undefined && (!current || !tokenShape(suppliedId) || !timingSafeEqual(Buffer.from(suppliedId), Buffer.from(current.id)))) {
      deny(res, 404, 'MCP session is unavailable. Initialize a new session.'); req.resume(); return;
    }
    if (suppliedId !== undefined && req.headers['mcp-protocol-version'] !== undefined && req.headers['mcp-protocol-version'] !== current.rpc.version) {
      deny(res, 400, 'MCP protocol version does not match this session.'); req.resume(); return;
    }
    if (req.method === 'DELETE') {
      if (!suppliedId) deny(res, 400, 'MCP-Session-Id is required.');
      else { revoke('HTTP MCP client disconnected.'); reply(res, 204); }
      req.resume(); return;
    }
    if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) {
      deny(res, 415, 'Use uncompressed application/json with UTF-8.'); req.resume(); return;
    }
    if (!accepts(req.headers.accept, 'application/json') || !accepts(req.headers.accept, 'text/event-stream')) {
      deny(res, 406, 'Accept must include application/json and text/event-stream.'); req.resume(); return;
    }
    if (Number(req.headers['content-length']) > protocol.MAX_BYTES) { deny(res, 413, 'Request exceeds 512 KiB.'); req.resume(); return; }
    if (active >= 16) { deny(res, 429, 'Too many pending MCP requests.'); req.resume(); return; }
    active++;
    try {
      let message;
      try { message = await readBody(req); }
      catch (error) { reply(res, error.status || 400, error.parse ? failure(null, -32700, error.message) : { error: error.message }); return; }
      expire();
      if (suppliedId !== undefined && session !== current) { deny(res, 404, 'MCP session ended.'); return; }
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
        reply(res, 400, failure(null, -32600, 'One JSON-RPC request or notification is required.')); return;
      }
      if (suppliedId === undefined) {
        if (message.method !== 'initialize' || !Object.hasOwn(message, 'id')) { deny(res, 400, 'Initialize first; then send MCP-Session-Id.'); return; }
        if (session) { deny(res, 409, 'This server already has an MCP client. Disconnect it before connecting another.'); return; }
        // Reserve before awaiting, so concurrent initialization cannot take over approval.
        const candidate = { id: randomBytes(32).toString('base64url'), expiresAt: Date.now() + protocol.SESSION_MS,
          rpc: createRPC(readTool, { replyOnCancel: true, allowChanges }) };
        session = candidate;
        const result = await candidate.rpc.receive(message);
        if (!result?.result) { candidate.rpc.close(); if (session === candidate) session = undefined; reply(res, 400, result); return; }
        reply(res, 200, result, { 'MCP-Session-Id': candidate.id }); return;
      }
      const result = await current.rpc.receive(message);
      // Results belong to the session that accepted the request, even across DELETE/reconnect.
      if (session !== current) { deny(res, 404, 'MCP session ended.'); return; }
      reply(res, result ? 200 : 202, result || undefined);
    } finally { active--; }
  }
  return {
    async start() {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready); server.listen(requestedPort, '127.0.0.1');
      });
      port = server.address().port; return { url: 'http://127.0.0.1:' + port + '/mcp' };
    },
    close() {
      if (closing) return closing;
      closed = true; clearInterval(sweep); revoke('HTTP MCP server stopped.'); server.closeAllConnections();
      closing = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
      return closing;
    }
  };
}
module.exports = { createHTTP, validateOptions };
