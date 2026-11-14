/* Test-only native clients. Never log bearer/pairing tokens or tool source bodies. */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
function httpRequest(url, token, { method = 'POST', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers: { Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers } }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, headers: res.headers, body: raw ? JSON.parse(raw) : undefined }); } catch (error) { reject(error); } });
    });
    req.setTimeout(12000, () => req.destroy(new Error('Offline HTTP MCP request timed out.')));
    req.on('error', reject); req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}
function httpClient(url, token) {
  let next = 0, session, version;
  const post = body => httpRequest(url, token, { body, headers: session ? { 'MCP-Session-Id': session, 'MCP-Protocol-Version': version } : {} });
  const request = (method, params) => {
    const id = ++next;
    const pending = post({ jsonrpc: '2.0', id, method, params }).then(reply => {
      if (reply.status !== 200) throw new Error('HTTP MCP request failed: ' + reply.status);
      if (method === 'initialize' && reply.body.result) { session = reply.headers['mcp-session-id']; version = reply.body.result.protocolVersion; }
      return reply.body;
    });
    pending.id = id; return pending;
  };
  const notify = async (method, params) => {
    const reply = await post({ jsonrpc: '2.0', method, params });
    if (reply.status !== 202 || reply.body !== undefined) throw new Error('HTTP MCP notification failed: ' + reply.status);
  };
  return { request, notify,
    async initialize() {
      const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } });
      await notify('notifications/initialized', {}); return result;
    },
    async tool(name, args = {}) { const reply = await request('tools/call', { name: 'module_engine_' + name, arguments: args }); return reply.error ? reply : JSON.parse(reply.result.content[0].text); },
    async disconnect() {
      if (!session) return;
      const reply = await httpRequest(url, token, { method: 'DELETE', headers: { 'MCP-Session-Id': session, 'MCP-Protocol-Version': version } });
      if (![204, 404].includes(reply.status)) throw new Error('HTTP MCP disconnect failed: ' + reply.status);
      session = undefined; version = undefined;
    },
    dispose() {}
  };
}
function client(input, output) {
  let next = 0, buffer = ''; const pending = new Map(), received = [];
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk; let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1); received.push(message);
      const job = pending.get(message.id);
      if (job) { clearTimeout(job.timer); pending.delete(message.id); job.resolve(message); }
    }
  });
  const notify = (method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const request = (method, params) => {
    const id = ++next;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Test MCP request timed out: ' + method)); }, 12000);
      pending.set(id, { resolve, reject, timer }); input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    promise.id = id; return promise;
  };
  return { request, notify, received,
    async initialize() { const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } }); notify('notifications/initialized', {}); return result; },
    async tool(name, args = {}) { const reply = await request('tools/call', { name: 'module_engine_' + name, arguments: args }); if (reply.error) return reply; return JSON.parse(reply.result.content[0].text); },
    dispose() { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Test client closed.')); } pending.clear(); }
  };
}
async function processClient({ transport = 'stdio' } = {}) {
  if (!['stdio', 'http'].includes(transport)) throw new Error('Unknown MCP test transport.');
  const token = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'server.cjs'), ...(transport === 'http' ? ['--http', '--port', '0'] : [])],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MODULE_ENGINE_MCP_TOKEN: token } });
  let stderr = '', stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.on('error', error => { stderr += error.message; });
  let c;
  if (transport === 'http') {
    child.stdout.on('data', chunk => { stdout += chunk; });
    try {
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(new Error('Offline HTTP MCP startup timed out.')); }, 10000);
        const ready = () => { const match = /^Module Engine MCP listening at (http:\/\/127\.0\.0\.1:[0-9]+\/mcp)\r?\n/.exec(stderr); if (match) { cleanup(); resolve(match[1]); } };
        const failed = () => { cleanup(); reject(new Error('Offline HTTP MCP could not start.')); };
        function cleanup() { clearTimeout(timer); child.stderr.removeListener('data', ready); child.removeListener('exit', failed); child.removeListener('error', failed); }
        child.stderr.on('data', ready); child.once('exit', failed); child.once('error', failed); ready();
      });
      c = httpClient(url, token);
    } catch (error) { child.kill(); throw error; }
  } else c = client(child.stdin, child.stdout);
  return { ...c, child,
    async close() {
      if (transport === 'http') { try { await c.disconnect(); } finally { child.kill(); } }
      else child.stdin.end();
      const timer = setTimeout(() => child.kill(), 4000);
      try {
        const exit = await ended;
        return { ...exit, stderr: transport === 'http' ? stderr.replace(/^Module Engine MCP listening at http:\/\/127\.0\.0\.1:[0-9]+\/mcp\r?\n/, '') : stderr,
          ...(transport === 'http' ? { stdout, stoppedByFixture: true } : {}) };
      } finally { clearTimeout(timer); c.dispose(); }
    }
  };
}
module.exports = { client, processClient, httpRequest, httpClient };
