/* Owned page-world, CSP and GM fixtures; no public URL is fetched or resolved. */
const fs = require('node:fs/promises');
const path = require('node:path');
function pageFixture(request, response) {
  if (!request.url.startsWith('/page-compat/')) return false;
  if (request.url === '/page-compat/api/redirect') {
    response.writeHead(307, { Location: '/page-compat/api/echo' }); response.end(); return true;
  }
  if (request.url === '/page-compat/api/echo') {
    const chunks = []; let size = 0;
    request.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) request.destroy(); else chunks.push(chunk); });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ method: request.method, type: request.headers['content-type'], body: Buffer.concat(chunks).toString() }));
    });
    return true;
  }
  const strict = request.url.includes('/csp'), trusted = request.url.includes('/trusted');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': request.url.startsWith('/page-compat/lifecycle/') ? 'private, max-age=0' : 'no-store',
    ...(strict ? { 'Content-Security-Policy': "script-src 'none'; object-src 'none'" }
      : trusted ? { 'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types 'none'" } : {}) });
  const port = /:(\d+)$/.exec(request.headers.host || '')?.[1];
  response.end('<!doctype html><html><head><script>window.pageObject={count:7,add(n){return this.count+=n;}};const pageLexical=11;' +
    'window.startObserved=document.documentElement.dataset.pageStart;</script></head><body><h1>Owned page fixture</h1>' +
    (port ? '<script src="http://localhost:' + port + '/ad.js"></script>' : '') +
    (request.url.endsWith('/frames') ? '<iframe src="child"></iframe>' : '') + '</body></html>');
  return true;
}
async function runPage({ b, manager, send, check, until, browse, scriptSource, evidence, click, temp }) {
  const api = '(globalThis.browser||chrome)', ids = [], pages = [];
  const install = async (name, scope, metadata, body) => {
    const saved = await send({ type: 'US_SAVE', source: scriptSource(name, metadata, body).replace('http://127.0.0.1/*', 'http://127.0.0.1' + scope) });
    check('Page source saved: ' + name, saved.ok); ids.push(saved.selectedId);
    const script = saved.scripts.find(s => s.id === saved.selectedId);
    const result = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true });
    if (!result.ok) evidence.pageEnableError = result.error;
    check('Page source enabled: ' + name, result.ok); return script.id;
  };
  const page = async route => { const target = await browse(route); pages.push(target); return target; };
  const list = async () => (await send({ type: 'US_LIST' })).scripts;
  const disable = async id => {
    const script = (await list()).find(s => s.id === id);
    check('Page script disabled', (await send({ type: 'US_ENABLE', id, revision: script.revision, enabled: false })).ok);
  };
  try {
    const gm = await install('Page globals with GM', '/page-compat/gm/*',
      '// @inject-into page\n// @grant unsafeWindow\n// @grant GM_info\n// @grant GM_getValue\n// @grant GM_setValue\n// @grant GM.getValue\n// @grant GM.setValue\n// @grant GM_addValueChangeListener\n// @grant GM_registerMenuCommand\n// @grant GM.xmlHttpRequest\n// @grant GM.cookie\n// @connect self\n// @top-level-await\n', `
      const d=document.documentElement.dataset;
      d.global=String(unsafeWindow===window&&unsafeWindow.pageObject.add(1)===8&&pageLexical===11);
      d.legacy=String(!(GM_getValue('count',7) instanceof Promise));d.count=String(GM_getValue('count',7));
      GM_addValueChangeListener('count',(_key,_old,value,remote)=>{d.count=String(value);d.remote=String(remote);});
      GM_registerMenuCommand('Page increment',()=>{d.writeReturn=String(GM_setValue('count',GM_getValue('count',7)+1));},{id:'increment'});
      unsafeWindow.ownedPageAPI={read:()=>GM.getValue('count',7),write:value=>GM.setValue('count',value),cookies:GM.cookie,network:async()=>{
        const form=new FormData();form.append('owned','page-form');form.append('file',new Blob(['offline-bytes'],{type:'text/plain'}),'fixture.log');
        const response=await GM.xmlHttpRequest({url:location.origin+'/page-compat/api/redirect',method:'POST',data:form,responseType:'json'});
        return {status:response.status,url:response.finalUrl,...response.response};
      }};
      d.mode=GM_info.injectInto;d.modern=String(await GM.getValue('count',7));d.pageReady='true';
    `);
    const first = await page('/page-compat/gm/a'), second = await page('/page-compat/gm/b');
    for (const target of [first, second]) await until('document.documentElement.dataset.pageReady', target);
    check('Page unsafeWindow reads real objects, methods and global lexical declarations with GM APIs', await b.evaluate('document.documentElement.dataset.global==="true"&&pageObject.count===8', first));
    check('Page legacy values are synchronous and modern values await native storage', await b.evaluate('document.documentElement.dataset.legacy==="true"&&document.documentElement.dataset.modern==="7"&&document.documentElement.dataset.mode==="page"', first));
    check('Granted helpers stay in the script closure, not page global properties', await b.evaluate('typeof GM==="undefined"&&typeof GM_getValue==="undefined"&&typeof GM_cookie==="undefined"', first));
    check('Local ad canary remains blocked with the page bridge active', await b.evaluate('typeof fixtureAd==="undefined"', first));
    const tabId = await b.evaluate(api + '.tabs.query({}).then(t=>t.find(x=>x.url?.endsWith("/page-compat/gm/a")).id)', manager);
    const menus = await until(api + '.runtime.sendMessage({type:"US_MENU_LIST",tabId:' + tabId + '}).then(r=>r.commands?.length?r.commands:null)', manager);
    check('Page menu is bound to the native tab', menus.length === 1);
    check('Extension can invoke the page menu', (await send({ type: 'US_MENU_RUN', tabId, connectionId: menus[0].connectionId, menuId: 'increment' })).ok);
    await until('document.documentElement.dataset.count==="8"', second);
    check('Menu callbacks and legacy writes use the page closure', await b.evaluate('document.documentElement.dataset.writeReturn==="undefined"&&document.documentElement.dataset.remote==="false"', first));
    check('Cross-tab value listeners reach the page and report remote changes', await b.evaluate('document.documentElement.dataset.remote==="true"', second));
    check('Page cookie calls require native optional permission', await b.evaluate('ownedPageAPI.cookies.list({}).then(()=>false,()=>true)', first));
    await click('refresh'); await until('!document.getElementById("refresh").disabled');
    await b.evaluate('document.querySelector(' + JSON.stringify('button[data-id="' + gm + '"]') + ').id="pageSelected"', manager);
    await click('pageSelected');
    check('Manager warns that the site can invoke granted page helpers', await b.evaluate('document.getElementById("scriptPreview").textContent.includes("invoke its granted helpers")', manager));
    for (const width of evidence.browser === 'firefox' ? [await b.evaluate('innerWidth', manager)] : [1280, 390]) {
      if (b.send) await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
      await b.evaluate('document.getElementById("scriptPreview").scrollIntoView({block:"center"})', manager);
      check('Page-access review fits at ' + width, await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1', manager));
      const output = path.join(temp, 'page-review-' + width + '.png');
      if (b.send) { const shot = await b.send('Page.captureScreenshot', { format: 'png' }, manager); await fs.writeFile(output, Buffer.from(shot.data, 'base64')); }
      else await b.screenshot(output, manager);
    }
    if (b.send) await b.send('Emulation.clearDeviceMetricsOverride', {}, manager);
    await until('!document.getElementById("grantHelpers").hidden'); await click('grantHelpers');
    if (evidence.browser === 'firefox') {
      for (let i = 0; i < 100; i++) {
        if (await b.evaluate(api + '.permissions.contains({permissions:["cookies","webRequestBlocking"]})', manager)) break;
        evidence.pageHelperPrompt = await b.userscriptPermissionPrompt(true, 'helpers');
        if (evidence.pageHelperPrompt.accepted) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      await until(api + '.permissions.contains({permissions:["webRequestBlocking"]})');
    }
    await until(api + '.permissions.contains({permissions:["cookies"]})');
    await b.evaluate('ownedPageAPI.cookies.set({name:"owned_page_bridge",value:"synthetic",httpOnly:true,path:"/page-compat/"})', first);
    const cookies = await b.evaluate('ownedPageAPI.cookies.list({name:"owned_page_bridge"})', first);
    check('Page cookie helper uses the calling browser store and can read its synthetic HttpOnly cookie', cookies.length === 1 && cookies[0].value === 'synthetic' && cookies[0].httpOnly);
    check('Page cookie helper enforces its declared destination scope', await b.evaluate('ownedPageAPI.cookies.list({url:"https://outside.invalid/"}).then(()=>false,()=>true)', first));
    await b.evaluate('ownedPageAPI.cookies.delete({name:"owned_page_bridge"})', first);
    check('Page cookie deletion confirms the actual native result', (await b.evaluate('ownedPageAPI.cookies.list({name:"owned_page_bridge"})', first)).length === 0);
    const network = await b.evaluate('ownedPageAPI.network()', first);
    check('Page FormData and Blob uploads survive an owned redirect through GM HTTP', network.status === 200 && network.method === 'POST' && network.url.endsWith('/page-compat/api/echo') && network.type.startsWith('multipart/form-data; boundary=') && network.body.includes('page-form') && network.body.includes('offline-bytes'));
    await b.evaluate('history.pushState({},"","/page-compat/outside")', second);
    check('Page GM calls recheck the live URL after same-document navigation', await b.evaluate('ownedPageAPI.write(99).then(()=>false,()=>true)', second));
    await disable(gm);
    check('Disabling revokes retained page GM handles', await b.evaluate('ownedPageAPI.write(99).then(()=>false,()=>true)', first));
    check('Disabling also revokes page cookie handles', await b.evaluate('ownedPageAPI.cookies.set({name:"owned_denied",value:"no"}).then(()=>false,()=>true)', first));
    await until(api + '.runtime.sendMessage({type:"US_MENU_LIST",tabId:' + tabId + '}).then(r=>r.commands?.length===0)', manager);
    check('Disabling removes page menus', true);
    const stored = await b.evaluate(api + '.storage.local.get("userscriptManager").then(r=>r.userscriptManager.scripts.find(s=>s.id===' + JSON.stringify(gm) + ').values.count)', manager);
    check('Rejected writes preserve the native value store', stored === 8);

    await install('Automatic page or content', '/page-compat/auto/*', '// @inject-into auto\n// @grant unsafeWindow\n// @grant GM_info\n// @grant GM.getValue\n// @grant GM.setValue\n// @top-level-await\n', `
      const d=document.documentElement.dataset;d.autoRuns=String(Number(d.autoRuns||0)+1);
      await GM.setValue('auto',23);d.autoValue=String(await GM.getValue('auto'));d.autoWorld=GM_info.injectInto;
      d.autoGlobal=String(typeof unsafeWindow.pageObject!=='undefined');d.autoReady='true';
    `);
    for (const kind of ['open', 'csp', 'trusted']) {
      const target = await page('/page-compat/auto/' + kind); await until('document.documentElement.dataset.autoReady', target);
      const data = await b.evaluate('({...document.documentElement.dataset})', target);
      (evidence.pageModes ||= []).push({ kind, data });
      const trustedTypesEnforced = kind === 'trusted' && await b.evaluate('(()=>{try{document.createElement("script").textContent="void 0";return false;}catch{return true;}})()', target);
      const expected = kind === 'csp' || trustedTypesEnforced ? 'content' : 'page';
      check('Auto executes exactly once with real GM storage: ' + kind, data.autoRuns === '1' && data.autoValue === '23');
      check('Auto chooses the correct native world without weakening site policy: ' + kind, data.autoWorld === expected);
      check('unsafeWindow follows the actual auto world: ' + kind, data.autoGlobal === String(expected === 'page'));
    }
    await install('Page refuses blocked startup', '/page-compat/explicit/csp', '// @inject-into page\n// @grant GM_info\n', 'document.documentElement.dataset.forbiddenRun=GM_info.injectInto;');
    const blocked = await page('/page-compat/explicit/csp');
    check('Explicit page mode does not silently fall back when CSP blocks it', await b.evaluate('!document.documentElement.dataset.forbiddenRun', blocked));
    for (const async of [false, true]) {
      await install('Auto failure ' + async, '/page-compat/failure/' + async, '// @inject-into auto\n// @grant GM_info\n' + (async ? '// @top-level-await\n' : ''),
        'const d=document.documentElement.dataset;d.failureRuns=String(Number(d.failureRuns||0)+1);' + (async ? 'await Promise.resolve();' : '') + 'throw new Error("Owned page failure");');
      const target = await page('/page-compat/failure/' + async); await until('document.documentElement.dataset.failureRuns', target);
      check('Runtime ' + (async ? 'rejection' : 'exception') + ' never reruns the script in content mode', await b.evaluate('document.documentElement.dataset.failureRuns==="1"', target));
    }
    for (const timing of ['start', 'body', 'end', 'idle']) {
      await install('Page timing ' + timing, '/page-compat/timing', '// @inject-into page\n// @grant GM_info\n// @run-at document-' + timing + '\n',
        'document.documentElement.dataset.page' + timing[0].toUpperCase() + timing.slice(1) + '=JSON.stringify({body:!!document.body,state:document.readyState,mode:GM_info.injectInto});');
    }
    const timed = await page('/page-compat/timing'); await until('document.documentElement.dataset.pageIdle', timed);
    const timing = await b.evaluate('({observed:startObserved,data:{...document.documentElement.dataset}})', timed);
    check('Page document-start runs before the first site script', JSON.parse(timing.observed).mode === 'page' && JSON.parse(timing.observed).state === 'loading');
    check('Page document-body waits for body', JSON.parse(timing.data.pageBody).body);
    check('Page document-end and idle run after parsing', ['interactive','complete'].includes(JSON.parse(timing.data.pageEnd).state) && JSON.parse(timing.data.pageIdle).body);

    await install('Page order A', '/page-compat/order', '// @inject-into page\n// @grant GM_info\n', 'globalThis.ownedPageOrder=(globalThis.ownedPageOrder||[]).concat("a");');
    const orderB = await install('Page order B', '/page-compat/order', '// @inject-into auto\n// @grant GM_info\n', 'globalThis.ownedPageOrder=(globalThis.ownedPageOrder||[]).concat("b");');
    const ordered = await page('/page-compat/order');
    // Native navigation completion can precede Firefox's document-end userscript
    // tasks. Wait for both executions, then assert their exact order separately.
    await until('Array.isArray(globalThis.ownedPageOrder) && ownedPageOrder.length >= 2', ordered);
    check('Page and auto bridges preserve configured start order within one timing phase', await b.evaluate('ownedPageOrder.join(",")==="a,b"', ordered));
    const orderedScripts = await list();
    check('Page script order can be changed transactionally', (await send({ type: 'US_MOVE', id: orderB,
      revision: orderedScripts.find(s => s.id === orderB).revision, direction: -1, order: orderedScripts.map(s => s.id) })).ok);
    const reordered = await page('/page-compat/order');
    await until('Array.isArray(globalThis.ownedPageOrder) && ownedPageOrder.length >= 2', reordered);
    check('Changed page script order reaches native registrations', await b.evaluate('ownedPageOrder.join(",")==="b,a"', reordered));

    await install('Page matching frames', '/page-compat/frames/*', '// @inject-into page\n// @grant GM.getValue\n// @exclude-match http://127.0.0.1/page-compat/frames/excluded*\n// @top-level-await\n', 'document.documentElement.dataset.frameGM=await GM.getValue("frame","owned");');
    await install('Page noframes', '/page-compat/frames/*', '// @inject-into page\n// @grant GM_info\n// @noframes\n', 'document.documentElement.dataset.topGM="owned";');
    const framed = await page('/page-compat/frames/frames');
    await until('document.querySelector("iframe")?.contentDocument?.documentElement.dataset.frameGM', framed);
    check('Page bridge works in matching subframes with native GM authorization', await b.evaluate('document.documentElement.dataset.frameGM==="owned"&&document.querySelector("iframe").contentDocument.documentElement.dataset.frameGM==="owned"', framed));
    check('Page noframes leaves the child untouched', await b.evaluate('document.documentElement.dataset.topGM==="owned"&&!document.querySelector("iframe").contentDocument.documentElement.dataset.topGM', framed));
    const excluded = await page('/page-compat/frames/excluded');
    check('Page native exclusions prevent source execution', await b.evaluate('!document.documentElement.dataset.frameGM', excluded));
    const lifecycleId = await install('Page lifecycle', '/page-compat/lifecycle/*', '// @inject-into page\n// @grant unsafeWindow\n// @grant GM_getValue\n// @grant GM.getValue\n// @grant GM_setValue\n// @grant GM.setValue\n// @grant GM_registerMenuCommand\n', `
      unsafeWindow.lifeRuns=(unsafeWindow.lifeRuns||0)+1;
      unsafeWindow.life={stamp:crypto.randomUUID(),read:()=>GM.getValue('life',0),local:()=>GM_getValue('life',0),write:value=>GM.setValue('life',value)};
      GM_registerMenuCommand('Lifecycle increment',()=>GM_setValue('life',GM_getValue('life',0)+1),{id:'life'});
      addEventListener('pageshow',event=>{if(event.isTrusted)document.documentElement.dataset.lifePersisted=String(event.persisted);});
    `);
    const life = await page('/page-compat/lifecycle/a'), peer = await page('/page-compat/lifecycle/b');
    for (const target of [life, peer]) await until('window.life && lifeRuns === 1', target);
    const lifeTab = await b.evaluate(api + '.tabs.query({}).then(t=>t.find(x=>x.url?.endsWith("/page-compat/lifecycle/a")).id)', manager);
    const lifeMenus = api + '.runtime.sendMessage({type:"US_MENU_LIST",tabId:' + lifeTab + '}).then(r=>r.commands?.filter(c=>c.id==="life"))';
    await until(lifeMenus + '.then(m=>m?.length===1)', manager);
    const firstConnection = (await b.evaluate(lifeMenus, manager))[0].connectionId;
    await b.evaluate('(dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})),dispatchEvent(new PageTransitionEvent("pagehide",{persisted:false})),true)', life);
    await b.evaluate('life.write(3)', life); await until('life.local()===3', peer);
    check('Synthetic lifecycle events preserve the page connection, values and single execution', (await b.evaluate(lifeMenus, manager))[0].connectionId === firstConnection && await b.evaluate('lifeRuns===1', life));
    if (b.send) {
      await require('./userscripts-compatibility.cjs').stopNativeWorker(b, manager);
      await until(lifeMenus + '.then(m=>m?.length===1&&m[0].connectionId!==' + JSON.stringify(firstConnection) + ')', manager);
      await b.evaluate('life.write(4)', peer); await until('life.local()===4', life);
      check('A real worker restart reconnects page menus and values without rerunning source', await b.evaluate('lifeRuns===1', life));
    }
    const stamp = await b.evaluate('life.stamp', life);
    await b.evaluate('(location.href="/page-compat/away",true)', life);
    await until('location.pathname==="/page-compat/away"&&document.readyState==="complete"', life);
    await b.evaluate('life.write(9)', peer);
    await b.evaluate('(history.back(),true)', life);
    await until('location.pathname==="/page-compat/lifecycle/a"&&window.life', life);
    await until(lifeMenus + '.then(m=>m?.length===1)', manager);
    await until('life.local()===9', life);
    const restored = await b.evaluate('({stamp:life.stamp,runs:lifeRuns,persisted:document.documentElement.dataset.lifePersisted})', life);
    evidence.pageHistory = { cachedDocumentRestored: restored.stamp === stamp, ...restored };
    check('Native history return hydrates current GM values and has one source execution per document', restored.runs === 1 && await b.evaluate('life.read().then(value=>value===9)', life));
    check('A cached history return does not re-execute source', restored.stamp !== stamp || restored.persisted === 'true');
    const command = (await b.evaluate(lifeMenus, manager))[0];
    check('Restored page command can run', (await send({ type: 'US_MENU_RUN', tabId: lifeTab, connectionId: command.connectionId, menuId: 'life' })).ok);
    await until('life.local()===10', peer);
    check('Restored legacy writes reach the peer and the local ad canary remains blocked', await b.evaluate('typeof fixtureAd==="undefined"', life));
    await b.evaluate('(location.href="/page-compat/away",true)', life);
    await until('location.pathname==="/page-compat/away"&&document.readyState==="complete"', life);
    await disable(lifecycleId);
    await b.evaluate('(history.back(),true)', life);
    await until('location.pathname==="/page-compat/lifecycle/a"&&document.readyState==="complete"', life);
    check('Disabling while away cannot revive GM writes on history return', await b.evaluate('window.life?life.write(99).then(()=>false,()=>true):true', life));
    check('Revoked page menus stay absent', (await b.evaluate(lifeMenus, manager)).length === 0);
    check('The ad-blocker module is still enabled after page compatibility tests', (await send({ type: 'GET_STATE' })).settings.enabled);
    check('No unexpected proxy errors during page compatibility tests', evidence.proxyErrors.length === 0);
  } finally {
    for (const id of ids) {
      const script = (await list()).find(s => s.id === id);
      if (script) await send({ type: 'US_DELETE', id, revision: script.revision });
    }
    for (const target of pages) await b.closePage(target);
  }
}
module.exports = { pageFixture, runPage };
