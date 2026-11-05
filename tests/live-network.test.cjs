/* No real DNS or external sockets: synthetic answers and loopback transports. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { createLiveProxy, isPublicAddress, connectHost, siteRunOptions } = require('./live-network.cjs');

const forbidden = [
  '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255',
  '127.0.0.1', '127.255.255.255', '169.254.169.254', '172.16.0.1', '172.31.255.255',
  '192.0.0.9', '192.0.2.1', '192.88.99.2', '192.168.1.1', '198.18.0.1',
  '198.19.255.255', '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255',
  '240.0.0.1', '255.255.255.255', '::', '::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
  '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b:1::a00:1', '100::1', '100:0:0:1::1',
  '2001::1', '2001:2::1', '2001:20::1', '2001:db8::1', '2002:7f00:1::1',
  '3fff::1', '5f00::1', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%1', 'ff02::1',
  '8.8.8.8%1', '', 'garbage', '127.1', '2130706433', '0x7f000001'
];
test('only ordinary public IPv4 and IPv6 unicast addresses are eligible', () => {
  for (const address of forbidden) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8','1.1.1.1','100.63.255.255','100.128.0.0','172.15.255.255',
    '172.32.0.0','192.0.1.1','198.17.255.255','198.20.0.0','223.255.255.255',
    '2001:4860:4860::8888','2606:4700:4700::1111','3ffe::1']) assert.equal(isPublicAddress(address), true, address);
});

test('CONNECT authorities are canonicalized and cannot smuggle credentials, ports or local suffixes', () => {
  for (const authority of ['localhost:443','x.localhost:443','router.local:443','host.internal:443','a.home.arpa:443',
    'intranet:443','example.test:80','example.test:444','example.test:443/path','user@example.test:443',
    'example.test:443?x','example.test:443#x','example.test..:443','bad_.test:443','[fe80::1%1]:443',
    'example.test:443\r\nX: y','example.test:443@127.0.0.1:443']) assert.equal(connectHost(authority),null,authority);
  assert.equal(connectHost('EXAMPLE.test.:443'),'example.test');
  for (const authority of ['127.1:443','2130706433:443','0x7f000001:443','0177.0.0.1:443']) {
    assert.equal(connectHost(authority),'127.0.0.1',authority);
  }
  assert.equal(connectHost('[2001:4860:4860::8888]:443'),'2001:4860:4860::8888');
});

async function startGuard(t, options = {}) {
  const calls = { lookup: [], connect: [], records: [], errors: [] };
  const guard = createLiveProxy({
    lookup: async (...args) => { calls.lookup.push(args); throw new Error('Unexpected DNS request'); },
    connect: options => { calls.connect.push(options); throw new Error('Unexpected outgoing connection'); },
    record: (...args) => calls.records.push(args), onError: (...args) => calls.errors.push(args), ...options
  });
  t.after(() => guard.close());
  guard.proxy.listen(0,'127.0.0.1'); await once(guard.proxy,'listening');
  return { ...guard, calls, port: guard.proxy.address().port };
}
function exchange(port, request, done = text => text.includes('\r\n\r\n')) {
  return new Promise((resolve,reject) => {
    const socket = net.connect({host:'127.0.0.1',port});
    let text = '', settled = false;
    const finish = error => {
      if (settled) return; settled = true; socket.destroy();
      error ? reject(error) : resolve(text);
    };
    socket.setTimeout(3000, () => finish(new Error('Proxy response timed out')));
    socket.on('connect', () => socket.write(request));
    socket.on('data', chunk => { text += chunk; if (done(text)) finish(); });
    socket.on('end', () => finish()); socket.on('error', finish);
  });
}
const tunnel = authority => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;

test('all HTTP requests, certificate-looking paths and WebSocket upgrades are denied without DNS', async t => {
  const guard = await startGuard(t);
  for (const url of ['http://127.0.0.1/x.cer','http://169.254.169.254/x.crt',
    'http://public.test/x.der','http://public.test/x.p7c','http://public.test/ordinary']) {
    assert.match(await exchange(guard.port,`GET ${url} HTTP/1.1\r\nHost: public.test\r\n\r\n`),/^HTTP\/1.1 403/);
  }
  assert.match(await exchange(guard.port,'GET http://127.0.0.1/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'),/^HTTP\/1.1 403/);
  assert.equal(guard.calls.lookup.length,0); assert.equal(guard.calls.connect.length,0);
});

test('private literals, numeric aliases, mapped IPv6, forbidden domains and allowlist lookalikes never connect', async t => {
  const guard = await startGuard(t, {prohibited:['blocked.test']});
  for (const authority of ['127.0.0.1:443','127.1:443','2130706433:443','0x7f000001:443','10.0.0.1:443',
    '169.254.169.254:443','[::1]:443','[::ffff:127.0.0.1]:443','[fc00::1]:443','[2002:7f00:1::1]:443',
    'blocked.test:443','sub.blocked.test:443','localhost:443','example.test:80']) {
    assert.match(await exchange(guard.port,tunnel(authority)),/^HTTP\/1.1 403/,authority);
  }
  assert.equal(guard.calls.lookup.length,0); assert.equal(guard.calls.connect.length,0);
  const restricted = await startGuard(t,{allowedDomains:['allowed.test']});
  for (const host of ['other.test','allowed.test.evil.test','notallowed.test']) {
    assert.match(await exchange(restricted.port,tunnel(host+':443')),/^HTTP\/1.1 403/);
  }
  assert.equal(restricted.calls.lookup.length,0);
});

test('every DNS answer must be public, including mixed families and malformed records', async t => {
  for (const answers of [[],[{address:'127.0.0.1',family:4}],
    [{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],
    [{address:'8.8.8.8',family:4},{address:'::1',family:6}],
    [{address:'2606:4700:4700::1111',family:6},{address:'192.168.0.1',family:4}],
    [{address:'::ffff:8.8.8.8',family:6}], [{address:'8.8.8.8',family:6}], [null]]) {
    const guard = await startGuard(t,{lookup:async () => answers});
    assert.match(await exchange(guard.port,tunnel('public.test:443')),/^HTTP\/1.1 403/,JSON.stringify(answers));
    assert.equal(guard.calls.connect.length,0);
  }
});

test('public results are pinned and tunneled, and a subsequent private DNS result is refused', async t => {
  const echo = net.createServer(socket => { socket.on('error',()=>{}); socket.pipe(socket); });
  echo.listen(0,'127.0.0.1'); await once(echo,'listening');
  t.after(() => new Promise(resolve => echo.close(resolve)));
  let lookups = 0;
  const connections = [];
  const guard = await startGuard(t, {allowedDomains:['public.test'], lookup:async (host,options) => {
    assert.equal(host,'sub.public.test.'); assert.deepEqual(options,{all:true,verbatim:true});
    return ++lookups === 1 ? [{address:'2606:4700:4700::1111',family:6},{address:'8.8.8.8',family:4}] : [{address:'127.0.0.1',family:4}];
  }, connect: options => {
    connections.push(options);
    // The guard must supply a literal, pinned address, never a hostname. Only
    // this test transport redirects that already-validated address to loopback.
    assert.deepEqual(options,{host:'8.8.8.8',family:4,port:443});
    return net.connect({host:'127.0.0.1',port:echo.address().port});
  }});
  const response = await exchange(guard.port,tunnel('sub.public.test:443')+'fixture-payload',text=>text.endsWith('fixture-payload'));
  assert.match(response,/^HTTP\/1.1 200/); assert.ok(response.endsWith('fixture-payload'));
  assert.equal(lookups,1); assert.equal(connections.length,1);
  assert.match(await exchange(guard.port,tunnel('sub.public.test:443')),/^HTTP\/1.1 403/);
  assert.equal(lookups,2); assert.equal(connections.length,1);
  assert.deepEqual(guard.calls.records,[['allowed','sub.public.test'],['denied','sub.public.test']]);
});

test('DNS errors and timeouts fail closed, and a late answer cannot start a connection', async t => {
  const failed = await startGuard(t,{lookup:async()=>{throw Object.assign(new Error('fixture lookup failure'),{code:'ENOTFOUND'});}});
  assert.match(await exchange(failed.port,tunnel('public.test:443')),/^HTTP\/1.1 403/);
  assert.equal(failed.calls.connect.length,0); assert.equal(failed.calls.errors.length,1);
  let resolveLookup;
  const delayed = await startGuard(t,{lookup:()=>new Promise(resolve=>{resolveLookup=resolve;}),dnsTimeoutMs:20});
  assert.match(await exchange(delayed.port,tunnel('public.test:443')),/^HTTP\/1.1 403/);
  resolveLookup([{address:'8.8.8.8',family:4}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(delayed.calls.connect.length,0);
});

test('shutdown during DNS cannot create a late upstream socket', async t => {
  let resolveLookup, started;
  const pending = new Promise(resolve=>{started=resolve;});
  const guard = await startGuard(t,{lookup:()=>new Promise(resolve=>{resolveLookup=resolve;started();})});
  const response = exchange(guard.port,tunnel('public.test:443'));
  await pending; await guard.close(); await response;
  resolveLookup([{address:'8.8.8.8',family:4}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(guard.calls.connect.length,0);
});

test('disconnect during DNS cancels the pending tunnel', {timeout:3000}, async t => {
  let resolveLookup, started;
  const pending = new Promise(resolve=>{started=resolve;});
  const guard = await startGuard(t,{lookup:()=>new Promise(resolve=>{resolveLookup=resolve;started();})});
  const connection = once(guard.proxy,'connection');
  const client = net.connect({host:'127.0.0.1',port:guard.port});
  t.after(()=>client.destroy());
  const [serverSocket] = await connection;
  client.write(tunnel('public.test:443')); await pending;
  const ended = once(serverSocket,'end'); client.end(); await ended;
  resolveLookup([{address:'8.8.8.8',family:4}]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(guard.calls.connect.length,0);
});

test('public IPv6 is pinned without DNS and upstream failures never report an allowed tunnel', async t => {
  for (const mode of ['error','timeout']) {
    let upstream;
    const guard = await startGuard(t,{connectTimeoutMs:20,connect:options=>{
      assert.deepEqual(options,{host:'2606:4700:4700::1111',family:6,port:443});
      upstream = new net.Socket();
      if (mode === 'error') queueMicrotask(()=>upstream.destroy(Object.assign(new Error('fixture failure'),{code:'ECONNREFUSED'})));
      return upstream;
    }});
    assert.equal(await exchange(guard.port,tunnel('[2606:4700:4700::1111]:443')),'');
    assert.equal(guard.calls.lookup.length,0); assert.ok(upstream.destroyed);
    assert.equal(guard.calls.errors.length,1);
    assert.ok(!guard.calls.records.some(([kind])=>kind === 'allowed'));
  }
});

test('evidence policy follows the actual run options, including popups-only implied clicks', () => {
  for (const argv of [[],['--visible'],['--click'],['--popups-only'],['--visible','--popups-only']]) {
    const options = siteRunOptions(argv);
    assert.equal(options.click,argv.includes('--click') || argv.includes('--popups-only'));
    assert.equal(options.headless,!argv.includes('--visible'));
    assert.equal(options.popupsOnly,argv.includes('--popups-only'));
    assert.equal(options.policy.includes('no clicks or typing'),!options.click);
    assert.equal(options.policy.includes('one native click attempted per phase'),options.click);
    assert.ok(options.policy.includes('plain HTTP denied'));
    assert.ok(options.policy.includes('loopback bypass disabled'));
  }
});
