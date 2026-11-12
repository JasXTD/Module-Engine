/* Native-browser integration for cached dependencies and brokered HTTP. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assets } = require('./userscripts-network-fixtures.cjs');
async function runAssetsAndNetwork({ b, manager, send, check, until, browse, scriptSource, temp, evidence, base, other, fixtureState }) {
  const ids = [], pages = [];
  const save = async (name, metadata, body = '') => {
    const result = await send({ type: 'US_SAVE', source: scriptSource(name, '', body, metadata).replace('http://127.0.0.1/*', 'http://127.0.0.1/asset-page*') });
    check('Saved offline fixture: ' + name, result.ok); ids.push(result.selectedId);
    return result.scripts.find(item => item.id === result.selectedId);
  };
  const refresh = async id => (await send({ type: 'US_LIST' })).scripts.find(script => script.id === id);
  const pointClick = async selector => {
    if(b.front)await b.front(manager);else await b.send('Target.activateTarget',{targetId:manager.id});
    for(let attempt=1;attempt<=5;attempt++) {
      await until('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||e.disabled)return false;e.scrollIntoView({block:"center",behavior:"instant"});return true;})()',manager);
      await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',manager);
      const point=await until('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');if(!e||e.disabled)return null;const r=e.getBoundingClientRect(),p={x:r.x+r.width/2,y:r.y+r.height/2};if(!r.width||!r.height||!e.contains(document.elementFromPoint(p.x,p.y)))return null;globalThis.__assetClickProbe?.abort();const probe=new AbortController();globalThis.__assetClickProbe=probe;globalThis.__assetClickArrived=false;e.addEventListener("click",()=>{globalThis.__assetClickArrived=true;probe.abort();},{capture:true,signal:probe.signal});return p;})()',manager);
      await b.clickAt(point.x,point.y,manager);
      if(await b.evaluate('globalThis.__assetClickArrived',manager))return;
      (evidence.lostAssetClicks||=[]).push({selector,attempt});
    }
    throw new Error('Pointer click did not reach '+selector);
  };
  const screenshot = async (name, width = 1200) => {
    if (b.send) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
      await b.evaluate('document.getElementById("dependencies").scrollIntoView({block:"start",behavior:"instant"})', manager);
      await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', manager);
      check('Dependency manager has no horizontal overflow at ' + width + 'px', await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1', manager));
      const capture = await b.send('Page.captureScreenshot', { format: 'png' }, manager);
      await fs.writeFile(path.join(temp, name), Buffer.from(capture.data, 'base64'));
    } else await b.screenshot(path.join(temp, name), manager);
  };
  const pin = createHash('sha256').update(assets['/usnet/first.js'][1]).digest('hex');
  const metadata = '// @require ' + base + '/usnet/first.js#sha256=' + pin + '\n// @require ' + base + '/usnet/second.js\n' +
    '// @resource style ' + base + '/usnet/style.css\n// @resource binary ' + base + '/usnet/bytes.bin\n' +
    '// @grant GM_getResourceText\n// @grant GM_getResourceURL\n// @grant GM.getResourceText\n// @grant GM.getResourceUrl\n// @grant GM_addStyle\n';
  const before = fixtureState.hits.length;
  let script = await save('Offline dependencies', metadata, `
    (async()=>{ const result={value:offlineLibrary.value,order:offlineOrder,grant:GM_info.script.grant,runAt:GM_info.script.runAt,
      phase:document.readyState,text:GM_getResourceText('style'),modernText:await GM.getResourceText('style')};
      const url=GM_getResourceURL('binary'); result.sameUrl=url===await GM.getResourceUrl('binary');
      result.bytes=Array.from(new Uint8Array(await (await fetch(url)).arrayBuffer()));
      result.styleThen=await GM_addStyle(':root { --native-style-check: yes; }').then(style=>style.tagName);
      document.body.dataset.assets=JSON.stringify(result);
    })().catch(error=>document.body.dataset.assetError=error.message);`);
  check('Saving dependencies makes no HTTP request', fixtureState.hits.length === before);
  const denied = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true });
  check('Unprepared dependencies cannot be enabled', !denied.ok && /Prepare and review/.test(denied.error));
  await pointClick('[data-id="' + script.id + '"]');
  await until('document.querySelector("#dependencyList").children.length===4');
  check('Manager explains dependencies before download', await b.evaluate('document.getElementById("scriptEnabled").disabled&&!document.getElementById("prepareAssets").disabled', manager));
  await pointClick('#prepareAssets');
  await until('document.getElementById("dependencyStatus").textContent.startsWith("Cached.")');
  script = await refresh(script.id);
  check('Manager caches every dependency with sizes and verified hashes', script.assets.length === 4 && script.assets[0].sha256 === pin && script.assets.every(asset => asset.size > 0));
  check('Prepared scripts remain disabled', !script.enabled);
  await until('!document.getElementById("refresh").disabled');
  await screenshot('dependencies-manager.png');
  if (b.send) await screenshot('dependencies-manager-narrow.png', 520);
  await pointClick('#dependencyList li button');
  await until('document.getElementById("assetDialog").open');
  check('Dependency review is read-only text', await b.evaluate('document.getElementById("assetSource").readOnly&&document.getElementById("assetSource").value.includes("offlineLibrary")&&!globalThis.offlineLibrary', manager));
  check('Dependency review opens with its heading visible and focused', await b.evaluate('document.activeElement.id==="assetTitle"&&document.getElementById("assetTitle").getBoundingClientRect().top>=document.getElementById("assetDialog").getBoundingClientRect().top', manager));
  await screenshot('dependency-review.png', 520);
  await pointClick('#assetDialog button');
  await pointClick('#scriptEnabled');
  await until('(globalThis.browser||chrome).runtime.sendMessage({type:"US_LIST"}).then(r=>r.scripts.find(s=>s.id===' + JSON.stringify(script.id) + ')?.enabled)', manager);
  const page = await browse('/asset-page'); pages.push(page);
  await until('document.body.dataset.assets||document.body.dataset.assetError', page);
  const output = await b.evaluate('document.body.dataset.assetError||JSON.parse(document.body.dataset.assets)', page);
  evidence.dependencies = output;
  check('Native libraries run in order before the main source', output.value === 42 && JSON.stringify(output.order) === '["first","second"]');
  check('Legacy and modern resource APIs agree and preserve binary bytes', output.text === output.modernText && output.text.includes('✓') && output.sameUrl && JSON.stringify(output.bytes) === '[0,1,127,128,255]');
  check('Default native timing is document-end with canonical GM_info grants', output.runAt === 'document-end' && ['interactive', 'complete'].includes(output.phase) && output.grant.includes('GM.getResourceUrl'));
  check('GM_addStyle supports its element and then callback', output.styleThen === 'STYLE');
  check('Page-world globals cannot see isolated dependencies', await b.evaluate('globalThis.offlineLibrary===undefined', page));
  check('Page runs use cached assets without refetching', fixtureState.hits.length === before + 4);
  check('The fixture ad remains blocked during dependency execution', await b.evaluate('window.fixtureAd===undefined', page));

  const httpScript = await save('Offline HTTP', '// @connect 127.0.0.1\n// @connect localhost\n// @grant GM.xmlHttpRequest\n// @grant GM_xmlhttpRequest\n', `
    (async()=>{
      const base=${JSON.stringify(base)}, other=${JSON.stringify(other)}, checks={}, request=GM.xmlHttpRequest;
      const data=await request({url:other+'/usnet/json',method:'POST',data:'native ✓',headers:{'X-Test':'native'},responseType:'json',anonymous:true});
      checks.crossOrigin=data.status===200&&data.response.body==='native ✓'&&data.response.header==='native';
      checks.responseHeaders=/x-offline-fixture: yes/i.test(data.responseHeaders);
      checks.binary=JSON.stringify(Array.from(new Uint8Array((await request({url:other+'/usnet/bytes.bin',responseType:'arraybuffer'})).response)))==='[0,1,127,128,255]';
      checks.blob=(await (await request({url:other+'/usnet/bytes.bin',responseType:'blob'})).response.arrayBuffer()).byteLength===5;
      checks.document=(await request({url:other+'/usnet/html',responseType:'document'})).response.querySelector('h1').textContent==='Parsed offline';
      checks.httpError=(await request({url:other+'/usnet/missing'})).status===404;
      checks.invalidJSON=(await request({url:other+'/usnet/invalid-json',responseType:'json'})).response===null;
      const events=[]; await new Promise((resolve,reject)=>GM_xmlhttpRequest({url:other+'/usnet/stream',onloadstart:()=>events.push('start'),
        onreadystatechange:r=>{if(r.readyState===4)events.push('ready4');},onprogress:r=>{if(r.loaded>0)checks.progress=true;},
        onload:r=>{events.push('load');checks.legacyText=r.responseText.length===131072;},onloadend:()=>{events.push('end');resolve();},onerror:reject}));
      checks.callbacks=events.join(',')==='start,ready4,load,end';
      checks.redirect=await request({url:other+'/usnet/redirect',redirect:'error'}).then(()=>false,()=>true);
      checks.connect=await request({url:'https://never-contacted.invalid/'}).then(()=>false,e=>e.message.includes('@connect'));
      checks.headers=await request({url:other+'/usnet/json',headers:{Cookie:'invalid'}}).then(()=>false,e=>e.message.includes('header'));
      checks.timeout=await request({url:other+'/usnet/slow',timeout:80}).then(()=>false,e=>e.message.includes('timed out'));
      const aborted=request({url:other+'/usnet/slow'}); const abortResult=aborted.then(()=>false,e=>e.message.includes('aborted')); aborted.abort(); checks.abort=await abortResult;
      checks.oversize=await request({url:other+'/usnet/oversize'}).then(()=>false,e=>e.message.includes('size limit'));
      await request({url:base+'/usnet/cookie'});
      checks.cookies=(await request({url:base+'/usnet/json',responseType:'json'})).response.cookie.includes('offline_cookie=yes');
      checks.anonymous=!(await request({url:base+'/usnet/json',responseType:'json',anonymous:true})).response.cookie;
      checks.blocker=await request({url:base.replace('127.0.0.1','localhost')+'/ad.js'}).then(()=>false,()=>true);
      document.body.dataset.http=JSON.stringify(checks);
      document.addEventListener('offline-start-slow',()=>{
        request({url:other+'/usnet/slow'}).then(()=>document.body.dataset.revoked='load',()=>document.body.dataset.revoked='revoked');
        document.body.dataset.slowStarted='true';
      });
    })().catch(error=>document.body.dataset.httpError=error.message);`);
  check('Native request fixture enabled', (await send({ type: 'US_ENABLE', id: httpScript.id, revision: httpScript.revision, enabled: true })).ok);
  const httpPage = await browse('/asset-page-http'); pages.push(httpPage);
  await until('document.body.dataset.http||document.body.dataset.httpError', httpPage);
  const httpOutput = await b.evaluate('document.body.dataset.httpError||JSON.parse(document.body.dataset.http)', httpPage);
  evidence.http = httpOutput;
  check('Native HTTP fixture completed', typeof httpOutput === 'object');
  for (const [name, passed] of Object.entries(httpOutput)) check('Native HTTP: ' + name, passed);
  await b.evaluate('document.dispatchEvent(new Event("offline-start-slow"))', httpPage);
  await until('document.body.dataset.slowStarted==="true"', httpPage);
  const start = Date.now();
  check('Module disables during slow native HTTP', (await send({ type: 'MODULE_SET', id: 'userscripts', enabled: false })).ok);
  evidence.httpDisableMs = Date.now() - start;
  check('Native HTTP does not hold the disable control', evidence.httpDisableMs < 3000);
  await until('document.body.dataset.revoked==="revoked"', httpPage);
  check('Disabling revokes the existing native network API', true);
  check('Ad blocker stays active after network cancellation', (await send({ type: 'GET_STATE' })).settings.enabled);
  for (const id of ids) { const current = await refresh(id); check('Deleted dependency/network fixture', (await send({ type: 'US_DELETE', id, revision: current.revision })).ok); }
  check('Restored userscript module', (await send({ type: 'MODULE_SET', id: 'userscripts', enabled: true })).ok);
  for (const target of pages) await b.closePage(target);
  evidence.assetsNetworkCompleted = true;
}
module.exports = { runAssetsAndNetwork };
