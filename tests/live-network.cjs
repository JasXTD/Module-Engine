/* Shared guard for opt-in live harnesses. Offline suites never use real DNS. */
'use strict';
const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns/promises');

// Conservative public-unicast policy, reviewed against IANA's special-purpose
// registries. Do not admit transition/mapped IPv6 or special-purpose exceptions.
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const deniedV4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8], ['10.0.0.0',8], ['100.64.0.0',10], ['127.0.0.0',8],
  ['169.254.0.0',16], ['172.16.0.0',12], ['192.0.0.0',24], ['192.0.2.0',24],
  ['192.88.99.0',24], ['192.168.0.0',16], ['198.18.0.0',15], ['198.51.100.0',24],
  ['203.0.113.0',24], ['224.0.0.0',4], ['240.0.0.0',4]
]) deniedV4.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const deniedV6 = new net.BlockList();
for (const [address, prefix] of [['2001::',23], ['2001:db8::',32], ['2002::',16], ['3fff::',20]]) {
  deniedV6.addSubnet(address, prefix, 'ipv6');
}
function isPublicAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = net.isIP(address);
  return family === 4 ? !deniedV4.check(address, 'ipv4') : family === 6 &&
    globalV6.check(address, 'ipv6') && !deniedV6.check(address, 'ipv6');
}
const within = (host, domain) => host === domain || host.endsWith('.' + domain);
function connectHost(authority) {
  if (typeof authority !== 'string' || !/^(?:\[[a-f0-9:.]+\]|[a-z0-9.-]+):443$/i.test(authority)) return null;
  let host;
  try { host = new URL('https://' + authority).hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''); }
  catch { return null; }
  if (net.isIP(host)) return host;
  // Require a fully qualified hostname, with no search-suffix expansion.
  if (host.length > 253 || !host.includes('.') || !/^[a-z]/.test(host.split('.').at(-1)) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      ['localhost','local','internal','home.arpa'].some(domain => within(host, domain))) return null;
  return host;
}

const NETWORK_POLICY = 'HTTPS CONNECT :443 to validated public IPs only; every DNS answer checked; selected IP pinned; loopback bypass disabled; plain HTTP denied';
function siteRunOptions(argv) {
  const popupsOnly = argv.includes('--popups-only');
  const click = popupsOnly || argv.includes('--click');
  return { headless: !argv.includes('--visible'), popupsOnly, click,
    policy: NETWORK_POLICY + '; reported/unverified hosts refused; downloads denied; ' +
      (click ? 'one native click attempted per phase when a suitable point exists; no typing' : 'no clicks or typing') +
      '; page body text not recorded (titles, URLs, element metadata and screenshots are retained)' };
}

function createLiveProxy({ prohibited = [], allowedDomains = null, record = () => {}, onError = () => {},
  lookup = dns.lookup, connect = net.connect, dnsTimeoutMs = 10000, connectTimeoutMs = 15000 } = {}) {
  const sockets = new Set();
  let closing = false;
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
  const proxy = http.createServer((request, response) => {
    let host;
    try { host = new URL(request.url).hostname; } catch { host = 'invalid'; }
    // A .cer/.crt-looking path says nothing about its destination or content.
    record('denied', 'http:' + host);
    response.writeHead(403, { Connection: 'close' }); response.end();
  });
  proxy.on('connection', socket => { track(socket); socket.on('error', () => {}); });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('upgrade', (request, socket) => {
    record('denied', 'http-upgrade');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  proxy.on('connect', (request, client, head) => {
    const host = connectHost(request.url);
    const deny = () => {
      record('denied', host || 'invalid-connect');
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    };
    if (closing || !host || prohibited.some(domain => within(host, domain)) ||
        (allowedDomains && !allowedDomains.some(domain => within(host, domain)))) { deny(); return; }
    let cancelled = false, upstream, timer;
    const stop = () => { cancelled = true; clearTimeout(timer); upstream?.destroy(); };
    client.once('close', stop);
    client.once('end', stop);
    // The deadline includes DNS. A late answer after timeout, disconnect or
    // shutdown cannot create a socket. Connect only the checked literal IP.
    timer = setTimeout(() => { cancelled = true; deny(); }, dnsTimeoutMs);
    void (async () => {
      try {
        const family = net.isIP(host);
        const answers = family ? [{ address: host, family }] : await lookup(host + '.', { all: true, verbatim: true });
        if (cancelled || closing || client.destroyed) return;
        clearTimeout(timer);
        if (!Array.isArray(answers) || !answers.length || answers.some(answer =>
          !answer || net.isIP(answer.address) !== answer.family || !isPublicAddress(answer.address))) { deny(); return; }
        // Prefer IPv4 for machines without IPv6 connectivity; no second lookup
        // or unchecked address-family fallback is permitted at connection time.
        const address = answers.find(answer => answer.family === 4) || answers[0];
        upstream = track(connect({ host: address.address, family: address.family, port: 443 }));
        timer = setTimeout(() => upstream.destroy(new Error('Upstream connection timeout')), connectTimeoutMs);
        upstream.once('connect', () => {
          if (cancelled || closing || client.destroyed) { upstream.destroy(); return; }
          clearTimeout(timer);
          record('allowed', host);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          client.pipe(upstream); upstream.pipe(client);
        });
        upstream.on('error', error => {
          if (error.code !== 'ECONNRESET') onError(host, error);
          client.destroy();
        });
        upstream.once('close', () => { clearTimeout(timer); client.destroy(); });
      } catch (error) {
        if (cancelled || closing || client.destroyed) return;
        clearTimeout(timer); onError(host, error); deny();
      }
    })();
  });
  return { proxy, async close() {
    closing = true;
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
  } };
}

module.exports = { createLiveProxy, isPublicAddress, connectHost, NETWORK_POLICY, siteRunOptions };
