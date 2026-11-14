/* Optional, first-party external-editor helper. Reads one file; never executes or writes it. */
'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const { constants } = require('node:fs');
const { randomBytes, timingSafeEqual, createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const MAX_SOURCE = 128 * 1024, PAIR_MS = 120000, SESSION_MS = 30 * 60 * 1000;
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && /^[A-Za-z0-9_-]{43}$/.test(a) && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const extensionOrigin = value => typeof value === 'string' && /^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value);
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function localPath(file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Choose a local .user.js file.');
  // Exclude UNC shares, device paths and alternate streams, including on Windows.
  if (/^(?:\\\\|\/\/)/.test(file)) throw new Error('Network and device paths are not supported.');
  const absolute = path.resolve(file);
  if (process.platform === 'win32' && (!/^[a-z]:\\/i.test(absolute) || /[:*?]/.test(absolute.slice(3)) ||
      absolute.slice(3).split('\\').some(part => /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part) || /[. ]$/.test(part)))) {
    throw new Error('Choose a normal local file path, without device names or alternate streams.');
  }
  if (!absolute.toLowerCase().endsWith('.user.js')) throw new Error('The chosen file must end in .user.js.');
  return absolute;
}
async function createFileReader(file) {
  const selected = localPath(file), canonical = await fs.realpath(selected);
  const initial = await fs.lstat(selected, { bigint: true });
  const samePath = process.platform === 'win32' ? canonical.toLowerCase() === selected.toLowerCase() : canonical === selected;
  if (!initial.isFile() || initial.isSymbolicLink() || !samePath) throw new Error('Choose a regular file at its real path, without symlinks or junctions.');
  let cached;
  return async function read() {
    const before = await fs.lstat(selected, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || await fs.realpath(selected) !== canonical) throw new Error('The selected path no longer names the approved regular file.');
    if (before.size > BigInt(MAX_SOURCE)) throw new Error('The file exceeds 128 KiB. Your draft is unchanged.');
    if (cached && sameFile(before, cached.stat)) return cached.value;
    let handle;
    try {
      handle = await fs.open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || !sameFile(before, opened)) throw new Error('The file changed while opening. Waiting for a stable save.');
      const bytes = Buffer.alloc(MAX_SOURCE + 1); let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true }), current = await fs.lstat(selected, { bigint: true });
      if (size > MAX_SOURCE) throw new Error('The file exceeds 128 KiB. Your draft is unchanged.');
      if (!sameFile(opened, after) || !sameFile(after, current) || current.isSymbolicLink() || await fs.realpath(selected) !== canonical) {
        throw new Error('The file changed while reading. Waiting for a stable save.');
      }
      const data = bytes.subarray(0, size);
      let source;
      try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data); }
      catch { throw new Error('Save the file as UTF-8. Your draft is unchanged.'); }
      const value = { name: path.basename(selected), hash: createHash('sha256').update(data).digest('hex'), source };
      cached = { stat: after, value }; return value;
    } finally { await handle?.close(); }
  };
}
async function createServer({ file, now = Date.now } = {}) {
  const read = await createFileReader(file);
  await read(); // Validate the chosen file before advertising a pairing code.
  let port, session, reading = false, closed = false, closing;
  let pairing = { token: secret(), expiresAt: now() + PAIR_MS };
  function reply(res, status, body) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', Connection: 'close' });
    res.end(JSON.stringify(body));
  }
  async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256) throw new Error('Invalid request.');
      chunks.push(chunk);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
    return value;
  }
  function expire() {
    if (pairing?.expiresAt <= now()) pairing = undefined;
    if (session?.expiresAt <= now()) session = undefined;
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => { void handle(req, res).catch(() => { reply(res, 400, { error: 'Invalid request.' }); req.resume(); }); });
  server.maxConnections = 8; server.headersTimeout = server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  server.on('connection', socket => {
    // A fixed lifetime also bounds clients that trickle a byte before each idle timeout.
    const deadline = setTimeout(() => socket.destroy(), 5000); deadline.unref();
    socket.once('close', () => clearTimeout(deadline)); socket.on('error', () => {});
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('checkContinue', (req, res) => { reply(res, 400, { error: 'Invalid request.' }); req.resume(); });
  async function handle(req, res) {
    expire();
    const critical = ['host', 'origin', 'authorization', 'content-type'];
    const duplicate = critical.some(name => req.rawHeaders.filter((_value, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length > 1);
    if (closed || duplicate || req.headers.host !== '127.0.0.1:' + port || !extensionOrigin(req.headers.origin) ||
        req.method !== 'POST' || req.headers['content-type'] !== 'application/json' || !['/pair', '/read', '/disconnect'].includes(req.url)) {
      reply(res, 403, { error: 'Request refused.' }); req.resume(); return;
    }
    const supplied = req.headers.authorization?.replace(/^Bearer /, '');
    const expected = req.url === '/pair' ? pairing : session;
    if (!expected || !equal(supplied, expected.token) || (req.url !== '/pair' && req.headers.origin !== expected.origin)) {
      reply(res, 401, { error: 'Pairing or session expired. Restart the helper to connect again.' }); req.resume(); return;
    }
    if (Number(req.headers['content-length']) > 256) { reply(res, 413, { error: 'Request too large.' }); req.resume(); return; }
    const value = await body(req); expire();
    if (closed || expected !== (req.url === '/pair' ? pairing : session)) { reply(res, 401, { error: 'Session closed.' }); return; }
    const keys = Object.keys(value);
    if (req.url === '/read' ? keys.some(key => key !== 'hash') || value.hash !== undefined && (typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) : keys.length) {
      reply(res, 400, { error: 'Invalid request.' }); return;
    }
    if (req.url === '/pair') {
      session = { token: secret(), origin: req.headers.origin, expiresAt: now() + SESSION_MS }; pairing = undefined;
      reply(res, 200, { token: session.token, expiresAt: session.expiresAt }); return;
    }
    if (req.url === '/disconnect') { session = undefined; reply(res, 200, { closed: true }); return; }
    if (reading) { reply(res, 429, { error: 'A file read is already in progress.' }); return; }
    reading = true;
    try {
      let result;
      try { result = await read(); }
      catch (error) {
        // Filesystem errors can contain absolute paths. Keep them out of HTTP and UI.
        result = { error: error.code ? 'The selected file is unavailable. Waiting for it to be saved again.' : error.message };
      }
      expire();
      if (closed || expected !== session) { reply(res, 401, { error: 'Session closed.' }); return; }
      reply(res, 200, result.hash && value.hash === result.hash ? { name: result.name, hash: result.hash } : result);
    } finally { reading = false; }
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const sweep = setInterval(expire, 1000); sweep.unref();
  return Object.freeze({ port, pairingCode: 'MEF1.' + port + '.' + pairing.token,
    close() {
      if (closing) return closing;
      closed = true; pairing = session = undefined; clearInterval(sweep);
      closing = new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); return closing;
    }
  });
}
if (require.main === module) {
  void (async () => {
    const { values } = parseArgs({ options: { file: { type: 'string' }, help: { type: 'boolean' } }, strict: true, allowPositionals: false });
    if (values.help) { console.log('Usage: node development/server.cjs --file "C:\\path\\script.user.js"\nReads only this local UTF-8 file. No dependencies, writes or script execution.'); return; }
    const helper = await createServer({ file: values.file });
    console.log('Module Engine external editor · read-only\nOpen a script → External editor. Paste this code within two minutes:\n' + helper.pairingCode +
      '\nKeep this terminal open. Stop with Ctrl+C. The connection expires after 30 minutes.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void helper.close(); });
  })().catch(error => { console.error('External editor: ' + error.message); process.exitCode = 1; });
}
module.exports = { createServer, createFileReader, localPath, MAX_SOURCE, PAIR_MS, SESSION_MS };
