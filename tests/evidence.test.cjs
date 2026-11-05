'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {webcrypto,createHash}=require('node:crypto');
let requests=0;
const context=vm.createContext({URL,Uint8Array,TextDecoder,crypto:webcrypto,fetch(){ requests++; throw new Error('Evidence must stay offline'); }});
vm.runInContext(fs.readFileSync(path.join(__dirname,'../evidence.js'),'utf8'),context);
const verify=context.BlockAdsEvidence.verify;
const original=['threat-evidence.json','threats.json','threat-policy.json'].map(file=>fs.readFileSync(path.join(__dirname,'../rules',file)));
const json=bytes=>JSON.parse(bytes.toString()),bytes=value=>Buffer.from(JSON.stringify(value));
const changed=change=>{const bundle=json(original[0]);change(bundle);return [bytes(bundle),original[1],original[2]];};

test('bundled evidence verifies offline and retains exact scope and report date precision',async()=>{
  const result=await verify(...original);
  assert.equal(result.catalog.domains.length,24);
  assert.ok(result.catalog.domains.every(item=>item.match==='exact' && /^2026-09(?:-\d{2})?$/.test(item.observedOn)));
  assert.equal(result.policy.expiresAt,'2026-11-30T00:00:00Z');
  assert.equal(requests,0);
});
test('evidence refuses mismatched rule and policy bytes',async()=>{
  await assert.rejects(verify(original[0],Buffer.concat([original[1],Buffer.from(' ')]),original[2]),/does not match/);
  await assert.rejects(verify(original[0],original[1],Buffer.concat([original[2],Buffer.from(' ')])),/does not match/);
});
test('evidence refuses a substituted host even with valid packaged hashes',async()=>{
  await assert.rejects(verify(...changed(b=>{b.catalog.domains[0].host='safe.example';})),/does not match its packaged/);
});
test('evidence refuses expanded scope, duplicates and missing source references',async()=>{
  for (const change of [b=>{b.catalog.domains[0].match='subdomains';},b=>{b.catalog.domains[1].host=b.catalog.domains[0].host;},b=>{b.catalog.domains[0].sourceId='missing';}]) {
    await assert.rejects(verify(...changed(change)),/Invalid evidence entry/);
  }
});
test('evidence never accepts credentialed, remote-text or unapproved source links',async()=>{
  for (const url of ['http://www.proofpoint.com/report','https://www.proofpoint.com.evil.example/report','https://user@www.proofpoint.com/report','https://www.proofpoint.com:8443/report','https://www.proofpoint.com/report%2ETxT?view=html']) {
    await assert.rejects(verify(...changed(b=>{b.catalog.sources[0].url=url;})),/Unsupported evidence source/);
  }
});
test('evidence refuses malformed dates, future observations and expiry drift',async()=>{
  for (const observedOn of ['2026-09-31','2026-10-01','2026-09-02']) {
    await assert.rejects(verify(...changed(b=>{for(const item of b.catalog.domains) item.observedOn=observedOn;})),/Invalid evidence entry|newer than|expiry policy/);
  }
});
test('evidence refuses unsupported catalogs and source duplication',async()=>{
  for (const change of [b=>{b.schemaVersion=2;},b=>{b.catalog.maxAgeDays=900;},b=>{b.catalog.sources.push(b.catalog.sources[0]);},b=>{b.catalog.domains=[];}]) {
    await assert.rejects(verify(...changed(change)),/format|inconsistent|source/);
  }
});
test('evidence checks rule semantics, even if its hash was recomputed',async()=>{
  for (const change of [r=>{r[0].priority=1;},r=>{r[0].condition.resourceTypes=['script'];},r=>{r[0].condition.excludedRequestDomains=['safe.example'];},r=>{r[0].action.type='allow';}]) {
    const rules=json(original[1]);change(rules);const rulesBytes=bytes(rules),bundle=json(original[0]);
    bundle.rulesSha256=createHash('sha256').update(rulesBytes).digest('hex');
    await assert.rejects(verify(bytes(bundle),rulesBytes,original[2]),/does not match its packaged/);
  }
});
test('evidence rejects oversized inputs and invalid UTF-8',async()=>{
  await assert.rejects(verify(Buffer.alloc(128*1024+1),original[1],original[2]),/size limit/);
  await assert.rejects(verify(original[0],Buffer.alloc(128*1024+1),original[2]),/format/);
  await assert.rejects(verify(original[0],original[1],Buffer.alloc(2049)),/size limit/);
  await assert.rejects(verify(Buffer.from([0xff]),original[1],original[2]));
});
