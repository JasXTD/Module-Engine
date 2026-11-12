/* Owned, inert loopback responses. No third-party code or external destinations. */
const assets = {
  '/usnet/first.js': ['text/javascript', 'var offlineOrder = ["first"]; var offlineLibrary = { value: 41 };'],
  '/usnet/second.js': ['text/javascript', 'offlineOrder.push("second"); offlineLibrary.value++;'],
  '/usnet/style.css': ['text/css', '/* locally authored */\nbody { --offline-resource: "✓"; }'],
  '/usnet/bytes.bin': ['application/octet-stream', Buffer.from([0, 1, 127, 128, 255])],
  '/usnet/bad.js': ['text/html', '<!doctype html><h1>Not a library</h1>'],
  '/usnet/bad-utf8.js': ['text/javascript', Buffer.from([255, 254, 255])],
  '/usnet/large.js': ['text/javascript', 'x'.repeat(262145)]
};
function fixtureHandler(state = { hits: [], aborted: 0 }) {
  return (request, response) => {
    const pathname = request.url.split('?')[0];
    if (!pathname.startsWith('/usnet/')) return false;
    state.hits.push({ url: request.url, method: request.method, cookie: request.headers.cookie || '', referer: request.headers.referer || '',
      authorization: request.headers.authorization || '', custom: request.headers['x-test'] || '' });
    const source = state.sources?.[pathname];
    if (source) {
      const finish = () => { response.writeHead(source.status || 200, { 'Content-Type': source.mime || 'text/javascript', ...source.headers });
        if (source.chunked) response.write(source.body.slice(0, 32)); response.end(source.chunked ? source.body.slice(32) : source.body); };
      if (source.delay) {
        const timer = setTimeout(finish, source.delay);
        response.on('close', () => { clearTimeout(timer); state.aborted++; });
      } else finish();
      return true;
    }
    if (pathname === '/usnet/redirect') { response.writeHead(302, { Location: '/usnet/json' }); response.end(); return true; }
    if (pathname === '/usnet/slow') {
      const timer = setTimeout(() => response.end('delayed local fixture'), 10000);
      response.on('close', () => { clearTimeout(timer); state.aborted++; }); return true;
    }
    if (assets[pathname]) { const [type, body] = assets[pathname]; response.writeHead(200, { 'Content-Type': type }); response.end(body); return true; }
    if (pathname === '/usnet/oversize') { response.writeHead(200, { 'Content-Type': 'application/octet-stream' }); response.end(Buffer.alloc(16777217)); return true; }
    if (pathname === '/usnet/stream') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': 131072 });
      response.write('a'.repeat(65536)); setImmediate(() => response.end('b'.repeat(65536))); return true;
    }
    if (pathname === '/usnet/html') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Parsed offline</h1>'); return true; }
    if (pathname === '/usnet/cookie') { response.writeHead(200, { 'Set-Cookie': 'offline_cookie=yes; SameSite=Lax; Path=/' }); response.end('cookie set'); return true; }
    if (pathname === '/usnet/invalid-json') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('not json'); return true; }
    const chunks = []; request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      response.writeHead(pathname === '/usnet/missing' ? 404 : 200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Offline-Fixture': 'yes' });
      response.end(JSON.stringify({ value: 42, method: request.method, body: Buffer.concat(chunks).toString(),
        bodyBase64: pathname === '/usnet/multipart' ? Buffer.concat(chunks).toString('base64') : undefined,
        contentType: request.headers['content-type'] || '', cookie: request.headers.cookie || '', header: request.headers['x-test'] || '' }));
    });
    return true;
  };
}
module.exports = { fixtureHandler, assets };
