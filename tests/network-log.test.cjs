const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../src/background/network-log.js');
const { create, safeURL, cleanEntry, LIMIT, BYTE_LIMIT, CAPTURE_MS } = ModuleEngineNetworkLog;
const KEY = 'moduleEngineNetworkLog', clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = new Set();
  return { args: [], addListener(fn, ...args) { this.args.push(args); listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); },
    fire(...args) { return [...listeners].map(fn => fn(...args)); }, get size() { return listeners.size; } };
}
function fixture(t, stored = {}, configure = () => {}) {
  let now = 1000, serial = 0, request = 0;
  const timers = new Map(), state = { stored: clone(stored), reads: 0, writes: [], failRead: 0, failWrite: 0, getTab: null, writeGate: null };
  const api = { runtime: { id: 'owned', getURL: file => 'chrome-extension://owned/' + file, onConnect: event() },
    tabs: { onRemoved: event(), get: async id => state.getTab ? state.getTab(id) : { id, url: 'https://page.example.test/' } },
    storage: { session: {
      async get() { state.reads++; if (state.failRead) { state.failRead--; throw Error('Owned read failure'); } return clone(state.stored); },
      async set(value) { if (state.writeGate) await state.writeGate; if (state.failWrite) { state.failWrite--; throw Error('Owned write failure'); } state.writes.push(clone(value)); Object.assign(state.stored, clone(value)); }
    } }, webRequest: Object.fromEntries(['onBeforeRequest','onSendHeaders','onResponseStarted','onBeforeRedirect','onCompleted','onErrorOccurred'].map(name => [name,event()])) };
  configure(api);
  const host = create(api, { now: () => now, setTimer(fn, delay) { const id = ++serial; timers.set(id,{fn,time:now+delay}); return id; }, clearTimer: id => timers.delete(id) });
  t.after(async () => { state.failWrite = 0; state.writeGate = null; await host.close(); });
  function port(sender = { id: 'owned', url: api.runtime.getURL('src/ui/network/network.html') }) {
    const p = { name: 'ME_NETWORK_LOG', sender, onMessage: event(), onDisconnect: event(), sent: [], closed: false,
      postMessage(value) { p.sent.push(clone(value)); }, disconnect() { if (!p.closed) { p.closed = true; p.onDisconnect.fire(); } } };
    api.runtime.onConnect.fire(p); return p;
  }
  async function send(p, type, args = {}) {
    const id = ++request; p.onMessage.fire({ id, type, ...args });
    for (let i=0;i<30;i++) { const result=p.sent.find(item=>item.id===id); if(result)return result; await tick(); }
    return null;
  }
  function fire(stage, patch = {}) { return api.webRequest[stage].fire({ requestId:'r1', tabId:7, frameId:0, method:'GET', type:'xmlhttprequest', url:'https://api.example.test/item', timeStamp:now, ...patch }); }
  async function advance(ms) { now+=ms; for(const [id,timer] of [...timers])if(timer.time<=now){timers.delete(id);timer.fn();} await tick(); }
  return { api, host, state, port, send, fire, advance, timers, get now(){return now;} };
}

test('capture is off by default and registers only passive metadata observers', async t => {
  const f=fixture(t); for(const source of Object.values(f.api.webRequest))assert.deepEqual(source.args,[[{urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']}]]);
  for(let i=0;i<100;i++)assert.deepEqual(f.fire('onBeforeRequest'),[undefined]);
  assert.equal(f.state.reads,0);assert.equal(f.state.writes.length,0);
  const result=await f.send(f.port(),'read');assert.equal(result.status.active,false);assert.deepEqual(result.entries,[]);
});
test('only the exact extension Network page can connect and viewers are bounded', t => {
  const f=fixture(t), own=f.api.runtime.getURL('src/ui/network/network.html');
  for(const sender of [{id:'other',url:own},{id:'owned',url:own+'#x'},{id:'owned',url:own+'?x'},{id:'owned',url:'https://example.test/network.html'},{id:'owned',url:f.api.runtime.getURL('src/ui/manager/manager.html')}])assert.equal(f.port(sender).closed,true);
  for(let i=0;i<4;i++)assert.equal(f.port().closed,false);assert.equal(f.port().closed,true);
});
test('request and response stages correlate without recording headers, bodies or URL secrets', async t => {
  const f=fixture(t),p=f.port();assert.equal((await f.send(p,'start',{tabId:null})).ok,true);
  f.fire('onBeforeRequest',{url:'https://user:password@api.example.test/item?q=private#fragment',initiator:'https://user:password@page.example.test/private?q=secret',requestBody:{raw:'secret-body'}});
  await f.advance(10);f.fire('onSendHeaders',{requestHeaders:[{name:'Authorization',value:'private-header'}]});
  await f.advance(20);f.fire('onResponseStarted',{statusCode:201,responseHeaders:[{name:'Set-Cookie',value:'private-cookie'}]});
  await f.advance(40);f.fire('onCompleted',{statusCode:201,fromCache:true});
  const result=await f.send(p,'read'),row=result.entries[0];
  assert.equal(row.url,'https://api.example.test/item');assert.equal(row.initiator,'https://page.example.test');
  assert.deepEqual([row.startedAt,row.sentAt,row.responseAt,row.endedAt],[1000,1010,1030,1070]);
  assert.equal(row.statusCode,201);assert.equal(row.fromCache,true);assert.equal(row.state,'complete');
  assert.equal(/password|private|secret|requestHeaders|responseHeaders|requestBody/.test(JSON.stringify(result)),false);
  assert.equal((await f.send(p,'read',{after:result.status.revision})).entries,null);
});
test('URL and retained-record projections remove arbitrary metadata and bound fields', () => {
  assert.equal(safeURL('wss://user:pass@socket.example.test/route?q=secret#x'),'wss://socket.example.test/route');
  for(const value of ['data:text/plain,secret','file:///secret','chrome-extension://other/private','javascript:alert(1)',null,'x'.repeat(16385)])assert.equal(safeURL(value),'');
  const row=cleanEntry({url:'https://u:p@example.test/x?token=a',state:'sent',method:'x'.repeat(99),requestId:'x'.repeat(999),error:'failed https://example.test/?token=secret',cookies:'secret',headers:['secret'],startedAt:NaN});
  assert.equal(row.method.length,20);assert.equal(row.requestId.length,128);assert.equal(row.state,'interrupted');assert.equal(row.startedAt,null);
  assert.equal(row.error,'Browser error (details omitted)');assert.equal(/secret|token|cookies|headers/.test(JSON.stringify(row)),false);
});
test('redirects sharing a browser ID retain separate hops and request methods', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});
  f.fire('onBeforeRequest',{method:'POST'});f.fire('onBeforeRedirect',{statusCode:303,redirectUrl:'https://next.example.test/final?secret=value'});
  f.fire('onBeforeRequest',{method:'GET',url:'https://next.example.test/final?secret=value'});f.fire('onCompleted',{statusCode:200});
  const rows=(await f.send(p,'read')).entries;
  assert.equal(rows.length,2);assert.equal(rows[0].state,'redirect');assert.equal(rows[0].redirectTo,'https://next.example.test/final');
  assert.equal(rows[1].state,'complete');assert.equal(rows[1].method,'GET');assert.equal(rows[0].requestId,rows[1].requestId);
});
test('missing start events produce partial failures without invented timings or block attribution', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});f.fire('onErrorOccurred',{error:'net::ERR_BLOCKED_BY_CLIENT'});
  const row=(await f.send(p,'read')).entries[0];assert.equal(row.state,'error');assert.equal(row.error,'net::ERR_BLOCKED_BY_CLIENT');assert.equal(row.startedAt,null);assert.equal(row.partial,true);assert.equal(row.layer,undefined);
});
test('capture scope uses native tab IDs and closing that tab stops capture', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:7});
  f.fire('onBeforeRequest',{tabId:8});f.fire('onBeforeRequest',{tabId:7});
  assert.equal((await f.send(p,'read')).entries.length,1);f.api.tabs.onRemoved.fire(7);
  const result=await f.send(p,'read');assert.equal(result.status.active,false);assert.equal(result.status.tabId,7);assert.equal(result.entries[0].state,'interrupted');
});
test('closing the owner stops capture while another viewer can retain and review it', async t => {
  const f=fixture(t),owner=f.port(),viewer=f.port();await f.send(owner,'start',{tabId:null});f.fire('onBeforeRequest');
  assert.equal((await f.send(viewer,'start',{tabId:null})).ok,false);viewer.disconnect();assert.equal((await f.send(owner,'read')).status.active,true);
  const next=f.port();owner.disconnect();f.fire('onCompleted');const result=await f.send(next,'read');
  assert.equal(result.status.active,false);assert.equal(result.entries[0].state,'interrupted');assert.equal(result.entries[0].endedAt,null);
});
test('clear discards rows and prevents tracked in-flight replies from restoring them', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});f.fire('onBeforeRequest');
  const cleared=await f.send(p,'clear');assert.deepEqual(cleared.entries,[]);assert.equal(cleared.status.active,true);
  f.fire('onResponseStarted',{statusCode:200});f.fire('onCompleted',{statusCode:200});assert.deepEqual((await f.send(p,'read')).entries,[]);
  f.fire('onBeforeRequest',{requestId:'new'});assert.equal((await f.send(p,'read')).entries.length,1);
});
test('stop freezes records and a new explicit start replaces the earlier capture', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});f.fire('onBeforeRequest');await f.send(p,'stop');
  f.fire('onCompleted');f.fire('onBeforeRequest',{requestId:'new'});assert.equal((await f.send(p,'read')).entries.length,1);
  assert.deepEqual((await f.send(p,'start',{tabId:null})).entries,[]);
});
test('capture expires at its deadline even before the expiry timer runs', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});f.fire('onBeforeRequest');await f.advance(CAPTURE_MS);
  f.fire('onBeforeRequest',{requestId:'late'});const result=await f.send(p,'read');assert.equal(result.status.active,false);assert.equal(result.entries.length,1);assert.match(result.status.reason,/30 minutes/);
});
test('entry and byte bounds evict older rows and report the loss', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});
  for(let i=0;i<LIMIT+25;i++)f.fire('onBeforeRequest',{requestId:'r'+i});
  let result=await f.send(p,'read');assert.equal(result.entries.length,LIMIT);assert.equal(result.status.dropped,25);
  await f.send(p,'clear');
  for(let i=0;i<LIMIT;i++){const patch={requestId:'large'+i,url:'https://example.test/'+'x'.repeat(1200),redirectUrl:'https://next.example.test/'+'y'.repeat(1200)};f.fire('onBeforeRequest',patch);f.fire('onBeforeRedirect',patch);}
  result=await f.send(p,'read');assert.ok(result.entries.length<LIMIT);assert.ok(result.status.bytes<=BYTE_LIMIT);assert.ok(result.status.dropped>0);
  await f.send(p,'stop');assert.ok(Buffer.byteLength(JSON.stringify(f.state.stored))<BYTE_LIMIT);
});
test('storage restores only bounded metadata and never resumes capture', async t => {
  const stored={[KEY]:{schemaVersion:1,tabId:7,active:true,entries:[{url:'https://user:secret@example.test/a?q=private',requestId:'x',state:'request',observedAt:900,startedAt:900,headers:['secret']}],dropped:2}};
  const f=fixture(t,stored),p=f.port(),result=await f.send(p,'read');
  assert.equal(result.status.active,false);assert.equal(result.entries[0].state,'interrupted');assert.equal(result.entries[0].url,'https://example.test/a');assert.equal(result.status.dropped,2);assert.equal(result.status.tabId,7);
});
test('failed reads do not overwrite the retained log and can be retried', async t => {
  const f=fixture(t,{[KEY]:{schemaVersion:1,entries:[{url:'https://example.test/kept',state:'complete'}]}}),p=f.port();f.state.failRead=1;
  assert.equal((await f.send(p,'start',{tabId:null})).ok,false);assert.equal(f.state.writes.length,0);
  assert.equal((await f.send(p,'read')).entries[0].url,'https://example.test/kept');
});
test('storage failure stops capture visibly and explicit retry recovers', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});f.state.failWrite=1;f.fire('onBeforeRequest');await f.advance(500);
  let result=await f.send(p,'read');assert.equal(result.status.active,false);assert.match(result.status.error,/session memory/);assert.equal(result.entries.length,1);
  result=await f.send(p,'clear');assert.equal(result.ok,true);assert.equal(result.status.error,'');assert.deepEqual(f.state.stored[KEY].entries,[]);
});
test('a slow save followed by clear cannot publish the older snapshot last', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});let release;
  f.state.writeGate=new Promise(resolve=>{release=resolve;});f.fire('onBeforeRequest');await f.advance(500);
  const clearing=f.send(p,'clear');await tick();release();f.state.writeGate=null;
  assert.equal((await clearing).ok,true);assert.deepEqual(f.state.stored[KEY].entries,[]);assert.deepEqual((await f.send(p,'read')).entries,[]);
});
test('disconnect during asynchronous start cannot enable a stale capture', async t => {
  const f=fixture(t),p=f.port();let release;f.state.getTab=()=>new Promise(resolve=>{release=resolve;});
  p.onMessage.fire({id:99,type:'start',tabId:7});await tick();p.disconnect();release({id:7,url:'https://example.test/'});await tick();
  assert.equal((await f.send(f.port(),'read')).status.active,false);assert.equal(f.state.writes.length,0);
});
test('malformed commands cannot supply capture events or arbitrary storage fields', async t => {
  const f=fixture(t);for(const message of [{id:1,type:'__proto__'},{id:1,type:'toString'},{id:1,type:'start',tabId:-1},{id:1,type:'start',tabId:null,headers:true},{id:1,type:'append',url:'https://example.test/'},{id:1,type:'read',after:-1}]){
    const p=f.port();p.onMessage.fire(message);assert.equal(p.closed,true);
  }assert.equal(f.state.reads,0);
});
test('capture cannot start for a restricted tab', async t => {
  const f=fixture(t),p=f.port();f.state.getTab=async()=>({url:'chrome://settings/'});
  assert.equal((await f.send(p,'start',{tabId:7})).ok,false);assert.equal((await f.send(p,'read')).status.active,false);
});

test('partial observer attachment failure removes listeners without throwing into the blocker', async t => {
  const f=fixture(t,{},api=>{api.webRequest.onResponseStarted.addListener=()=>{throw Error('Owned API failure');};});
  assert.equal(f.api.webRequest.onBeforeRequest.size,0);assert.equal(f.api.webRequest.onSendHeaders.size,0);
  const result=await f.send(f.port(),'start',{tabId:null});assert.equal(result.ok,false);assert.match(result.error,/attach the network observers/);
  assert.equal(f.state.writes.length,0);
});

test('per-page pending commands are bounded while a native tab lookup is unresolved', async t => {
  const f=fixture(t),p=f.port();let release;f.state.getTab=()=>new Promise(resolve=>{release=resolve;});
  p.onMessage.fire({id:100,type:'start',tabId:7});await tick();
  p.onMessage.fire({id:101,type:'read'});p.onMessage.fire({id:102,type:'clear'});
  assert.equal(p.sent.find(r=>r.id===102).ok,false);assert.equal(f.state.writes.length,0);
  release({id:7,url:'https://example.test/'});await tick();
  assert.equal((await f.send(p,'read')).status.active,true);
});

test('duplicate pending command IDs revoke the owner and cannot start stale work', async t => {
  const f=fixture(t),p=f.port();let release;f.state.getTab=()=>new Promise(resolve=>{release=resolve;});
  p.onMessage.fire({id:100,type:'start',tabId:7});await tick();p.onMessage.fire({id:100,type:'read'});
  assert.equal(p.closed,true);release({id:7,url:'https://example.test/'});await tick();
  assert.equal((await f.send(f.port(),'read')).status.active,false);
});

test('WebSocket handshake metadata contains no frames or protocol headers', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});
  f.fire('onBeforeRequest',{url:'wss://socket.example.test/chat?token=secret',type:'websocket'});
  f.fire('onCompleted',{url:'wss://socket.example.test/chat?token=secret',type:'websocket',statusCode:101});
  const row=(await f.send(p,'read')).entries[0];assert.equal(row.url,'wss://socket.example.test/chat');assert.equal(row.statusCode,101);assert.equal(row.type,'websocket');
});

test('read capability restores sanitized entries without capture, timers or writes', async t => {
  const f=fixture(t,{[KEY]:{schemaVersion:1,entries:[{url:'https://user:secret@example.test/retained?q=secret#private',method:'GET',state:'complete',headers:['secret'],body:'secret'}]}});
  const before=clone(f.state.stored),result=await f.host.read();
  assert.equal(result.ok,true);assert.equal(result.capture.active,false);assert.equal(result.entries[0].url,'https://example.test/retained');
  assert.equal(/secret|headers|body/.test(JSON.stringify(result.entries)),false);assert.deepEqual(f.state.stored,before);assert.equal(f.state.writes.length,0);assert.equal(f.timers.size,0);
  result.entries[0].url='https://changed.test/';assert.equal((await f.host.read()).entries[0].url,'https://example.test/retained');
});

test('read capability selects newest matches without mutating active capture or pending rows', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});
  for(let i=0;i<60;i++){const event={requestId:'r'+i,url:'https://example.test/api/'+i,method:i%2?'POST':'GET',tabId:i%2?8:7};f.fire('onBeforeRequest',event);f.fire('onCompleted',{...event,statusCode:i%2?418:200});}
  f.fire('onBeforeRequest',{requestId:'pending',url:'https://example.test/pending'});
  const before=await f.send(p,'read'),writes=f.state.writes.length,timers=f.timers.size;
  const result=await f.host.read({limit:3,url:'/API/',method:'get',tabId:7,statusCode:200,type:'xmlhttprequest',state:'complete'});
  assert.equal(result.matched,30);assert.equal(result.truncated,true);assert.deepEqual(result.entries.map(r=>r.url),[54,56,58].map(i=>'https://example.test/api/'+i));
  assert.equal((await f.host.read({state:'request'})).entries[0].state,'request');
  assert.equal((await f.host.read({url:'no-match'})).matched,0);
  assert.deepEqual(await f.send(p,'read'),{...before,id:before.id+1});assert.equal(f.state.writes.length,writes);assert.equal(f.timers.size,timers);
  assert.equal(result.capture.active,true);assert.equal((await f.host.read()).entries.length,50);
});

test('network read byte budget leaves room for the MCP transport and reports truncation', async t => {
  const f=fixture(t),p=f.port();await f.send(p,'start',{tabId:null});
  for(let i=0;i<110;i++){const event={requestId:'r'+i,url:'https://example.test/'+i+'x'.repeat(1100),redirectUrl:'https://next.test/'+'y'.repeat(1100)};f.fire('onBeforeRequest',event);f.fire('onBeforeRedirect',event);}
  const result=await f.host.read({limit:100});assert.equal(result.matched,110);assert.equal(result.truncated,true);assert.ok(result.entries.length>0&&result.entries.length<100);
  assert.ok(Buffer.byteLength(JSON.stringify(result))<=128*1024);assert.ok(Buffer.byteLength(JSON.stringify({content:[{type:'text',text:JSON.stringify(result)}]}))<512*1024);
});

test('a read failure preserves retained data and cannot silently enable or clear capture', async t => {
  const f=fixture(t,{[KEY]:{schemaVersion:1,entries:[{url:'https://example.test/kept',state:'complete'}]}});f.state.failRead=1;
  await assert.rejects(f.host.read(),/Could not read/);assert.equal(f.state.writes.length,0);
  assert.equal((await f.host.read()).entries[0].url,'https://example.test/kept');assert.equal(f.timers.size,0);
});
