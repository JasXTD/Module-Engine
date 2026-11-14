const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { createServer, createFileReader, localPath, MAX_SOURCE, PAIR_MS, SESSION_MS } = require('../development/server.cjs');
const origin = 'chrome-extension://'+'a'.repeat(32);
const source='// ==UserScript==\r\n// @name Owned file\r\n// @match http://127.0.0.1/*\r\n// @grant none\r\n// ==/UserScript==\r\nglobalThis.__externalExecuted=true;';
async function fixture(t, options={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'module-engine-external-unit-')), file=path.join(dir,'owned.user.js');
  await fs.writeFile(file,source);const server=await createServer({file,...options});
  t.after(async()=>{await server.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,file,server,token:server.pairingCode.split('.')[2]};
}
function request(server,token,route='/read',body={},headers={},method='POST') {
  return new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port:server.port,path:route,method,headers:{Origin:origin,Authorization:'Bearer '+token,'Content-Type':'application/json',...headers}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,body:text?JSON.parse(text):null}));
    });req.on('error',reject);req.end(typeof body==='string'?body:JSON.stringify(body));
  });
}
test('pairing reads exactly one inert file, rotates tokens, suppresses unchanged bytes, and revokes on stop',async t=>{
  const f=await fixture(t);const pair=await request(f.server,f.token,'/pair');assert.equal(pair.status,200);
  const token=pair.body.token;assert.notEqual(token,f.token);assert.equal((await request(f.server,f.token,'/pair')).status,401);
  assert.equal((await request(f.server,f.token)).status,401);
  const read=await request(f.server,token);assert.equal(read.status,200);assert.equal(read.body.source,source);assert.equal(read.body.name,'owned.user.js');assert.ok(!read.text.includes(f.dir));
  assert.equal(read.headers['access-control-allow-origin'],undefined);assert.equal(read.headers['cache-control'],'no-store');
  assert.equal(read.body.hash,createHash('sha256').update(source).digest('hex'));assert.equal(globalThis.__externalExecuted,undefined);
  const unchanged=await request(f.server,token,'/read',{hash:read.body.hash});assert.equal(unchanged.body.source,undefined);
  await fs.writeFile(f.file,source+'\r\n// next ✓');assert.equal((await request(f.server,token,'/read',{hash:read.body.hash})).body.source,source+'\r\n// next ✓');
  assert.equal((await request(f.server,token,'/disconnect')).status,200);assert.equal((await request(f.server,token)).status,401);assert.equal((await request(f.server,f.token,'/pair')).status,401);
});
test('web origins, missing origins, rebinding hosts, paths, methods and unauthenticated reads are refused',async t=>{
  const f=await fixture(t);
  for(const headers of [{Origin:'https://example.test'},{Origin:'null'},{Origin:''},{Origin:origin+'/page'},{Origin:'moz-extension://not-a-valid-uuid'},{Host:'localhost:'+f.server.port},{Host:'example.test:'+f.server.port}])assert.equal((await request(f.server,f.token,'/pair',{},headers)).status,403);
  for(const route of ['/read?path=secret','/../read','/file','/mcp'])assert.equal((await request(f.server,f.token,route)).status,403);
  for(const method of ['GET','OPTIONS','PUT'])assert.equal((await request(f.server,f.token,'/pair',{}, {},method)).status,403);
  assert.equal((await request(f.server,'B'.repeat(43),'/pair')).status,401);
  assert.equal((await request(f.server,f.token,'/pair',{file:f.file})).status,400);
  const {token}= (await request(f.server,f.token,'/pair')).body;
  assert.equal((await request(f.server,token,'/read',{}, {Origin:'chrome-extension://'+'b'.repeat(32)})).status,401);
  for(const body of [{path:f.file},{hash:'bad'},{hash:['a'.repeat(64)]},[],null,{},'{' ]) {
    if(body && !Array.isArray(body)&&!Object.keys(body).length)continue;
    assert.equal((await request(f.server,token,'/read',body)).status,400);
  }
  assert.equal((await request(f.server,token,'/read','x'.repeat(300),{'Content-Length':'300'})).status,413);
});
test('concurrent pairing claims have one winner and a fixed session expiry',async t=>{
  let clock=Date.now();const f=await fixture(t,{now:()=>clock});
  const responses=await Promise.all([request(f.server,f.token,'/pair'),request(f.server,f.token,'/pair')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);const token=responses.find(r=>r.status===200).body.token;
  clock+=SESSION_MS+1;assert.equal((await request(f.server,token)).status,401);assert.equal((await request(f.server,f.token,'/pair')).status,401);
});
test('unclaimed pairing expires without extending itself',async t=>{
  let clock=Date.now();const f=await fixture(t,{now:()=>clock});clock+=PAIR_MS+1;assert.equal((await request(f.server,f.token,'/pair')).status,401);
});
test('atomic saves are tracked; missing, oversized and non-UTF8 files recover without leaking paths',async t=>{
  const f=await fixture(t),token=(await request(f.server,f.token,'/pair')).body.token;
  const next=path.join(f.dir,'replacement.user.js');await fs.writeFile(next,'\uFEFF'+source+'\n// atomic');await fs.rename(next,f.file);
  assert.equal((await request(f.server,token)).body.source,'\uFEFF'+source+'\n// atomic');
  await fs.unlink(f.file);let res=await request(f.server,token);assert.match(res.body.error,/unavailable/);assert.ok(!res.text.includes(f.dir));
  await fs.writeFile(f.file,Buffer.alloc(MAX_SOURCE+1));assert.match((await request(f.server,token)).body.error,/128 KiB/);
  await fs.writeFile(f.file,Buffer.from([0xff,0xfe]));assert.match((await request(f.server,token)).body.error,/UTF-8/);
  await fs.writeFile(f.file,source);assert.equal((await request(f.server,token)).body.source,source);
  await fs.unlink(f.file);await fs.mkdir(f.file);assert.match((await request(f.server,token)).body.error,/regular file/);
});
test('only local regular .user.js files are accepted; junction replacement cannot redirect reads',async t=>{
  for(const file of ['\\\\server\\share\\file.user.js','//server/share/file.user.js','file.js','file.user.js\0'])assert.throws(()=>localPath(file));
  if(process.platform==='win32')for(const file of ['C:\\file.user.js:secret','C:\\nul.user.js','C:\\dir.\\file.user.js','\\\\?\\C:\\file.user.js'])assert.throws(()=>localPath(file));
  const f=await fixture(t),dir=path.join(f.dir,'chosen'),other=path.join(f.dir,'other');await fs.mkdir(dir);await fs.mkdir(other);
  const file=path.join(dir,'one.user.js');await fs.writeFile(file,source);await fs.writeFile(path.join(other,'one.user.js'),'not approved');
  const read=await createFileReader(file);assert.equal((await read()).source,source);
  await fs.rename(dir,path.join(f.dir,'old'));await fs.symlink(other,dir,'junction');
  await assert.rejects(read,/approved regular file/);await assert.rejects(createFileReader(file),/real path/);
  await fs.unlink(dir); // Remove the owned link before recursive fixture cleanup.
});
test('slow partial requests have a fixed deadline and do not prevent a later approved read',async t=>{
  const f=await fixture(t), started=Date.now();
  const socket=net.connect(f.server.port,'127.0.0.1');t.after(()=>socket.destroy());
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  socket.write('POST /pair HTTP/1.1\r\nHost: 127.0.0.1:'+f.server.port+'\r\nOrigin: '+origin+'\r\nAuthorization: Bearer '+f.token+'\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{');
  const trickle=setInterval(()=>socket.write(' '),300);t.after(()=>clearInterval(trickle));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Socket exceeded its fixed deadline')),8000);socket.once('close',()=>{clearTimeout(timer);resolve();});socket.on('error',()=>{});});
  clearInterval(trickle);assert.ok(Date.now()-started<8000);
  const token=(await request(f.server,f.token,'/pair')).body.token;assert.equal((await request(f.server,token)).body.source,source);
});
test('the real CLI selects an owned file and accepts its one-use terminal code without package installation',async t=>{
  const f=await fixture(t);await f.server.close();
  const child=spawn(process.execPath,[path.resolve(__dirname,'../development/server.cjs'),'--file',f.file],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.setEncoding('utf8');child.stderr.on('data',data=>errors+=data);
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}});
  const code=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('CLI startup timed out: '+errors)),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{output+=data;const match=/MEF1\.([0-9]+)\.([A-Za-z0-9_-]{43})/.exec(output);if(match){clearTimeout(timer);resolve(match);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('CLI exited before pairing: '+errors));});});
  const server={port:Number(code[1])},token=(await request(server,code[2],'/pair')).body.token;
  assert.equal((await request(server,token)).body.source,source);assert.equal(errors,'');
  assert.equal((await request(server,token,'/disconnect')).status,200);
});
