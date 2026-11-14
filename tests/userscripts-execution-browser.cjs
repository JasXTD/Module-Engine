/* Owned execution/cookie fixtures. No public URL is fetched or resolved. */
const fs = require('node:fs/promises');
const path = require('node:path');
function executionFixture(request, response) {
  if (!request.url.startsWith('/execution/')) return false;
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    ...(request.url.startsWith('/execution/cookies') ? { 'Set-Cookie': 'offline_execution_http=owned; HttpOnly; Path=/execution/; SameSite=Lax' } : {}) });
  response.end('<!doctype html><html><head><script>window.pageObject={count:7};const pageLexical=11;' +
    'window.rawObserved=typeof rawFunction==="function"?{value:rawFunction(),lexical:rawLexical,constant:rawConstant,variable:rawVariable}:null;' +
    'window.awaitObserved=document.documentElement.dataset.awaitStarted;</script></head><body><h1>Owned execution fixture</h1>' +
    (request.url === '/execution/raw/frames' ? '<iframe src="/execution/raw/child"></iframe>' : '') + '</body></html>');
  return true;
}
async function runExecution({ b, manager, send, check, until, browse, scriptSource, evidence, click, temp }) {
  const api = '(globalThis.browser||chrome)', ids = [], pages = [];
  const save = async (name, scope, metadata, body) => {
    const result = await send({ type: 'US_SAVE', source: scriptSource(name, metadata, body).replace('http://127.0.0.1/*', 'http://127.0.0.1' + scope) });
    check('Execution source saved: ' + name, result.ok); ids.push(result.selectedId);
    const script = result.scripts.find(item => item.id === result.selectedId);
    const enabled = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true });
    if (!enabled.ok) evidence.executionEnableError = enabled.error;
    check('Execution source enabled: ' + name, enabled.ok);
    return script.id;
  };
  const page = async route => { const target = await browse(route); pages.push(target); return target; };
  const request = async (target, method, details = {}, legacy = false) => {
    await b.evaluate('(()=>{const d=document.documentElement.dataset;delete d.cookieResult;d.cookieCommand=' +
      JSON.stringify(JSON.stringify({ method, details, legacy })) + ';document.dispatchEvent(new Event("cookie-run"));})()', target);
    return JSON.parse(await until('document.documentElement.dataset.cookieResult', target));
  };
  const select = async id => {
    await click('refresh'); await until('!document.getElementById("refresh").disabled');
    await b.evaluate('document.querySelector(' + JSON.stringify('button[data-id="' + id + '"]') + ').id="executionSelected"', manager);
    await click('executionSelected');
  };
  const grant = async () => {
    await until('!document.getElementById("grantHelpers").hidden'); await click('grantHelpers');
    if (evidence.browser === 'firefox') for (let i = 0; i < 100; i++) {
      if (await b.evaluate(api + '.permissions.contains({permissions:["cookies"]})', manager)) break;
      evidence.cookiePermissionPrompt = await b.userscriptPermissionPrompt(true, 'helpers');
      if (evidence.cookiePermissionPrompt.accepted) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await until(api + '.permissions.contains({permissions:["cookies"]})');
  };
  try {
    check('Cookie permission is optional and initially absent', !await b.evaluate(api + '.permissions.contains({permissions:["cookies"]})', manager));
    await save('Isolated unsafeWindow', '/execution/isolated', '// @grant unsafeWindow\n// @grant GM_info\n',
      'unsafeWindow.contentOnly=41;document.documentElement.dataset.isolatedWindow=String(unsafeWindow===globalThis&&typeof unsafeWindow.pageObject==="undefined"&&GM_info.injectInto==="content");');
    const isolated = await page('/execution/isolated');
    await until('document.documentElement.dataset.isolatedWindow', isolated);
    check('Content-mode unsafeWindow stays isolated from page globals', await b.evaluate('document.documentElement.dataset.isolatedWindow==="true"&&typeof contentOnly==="undefined"&&pageObject.count===7', isolated));
    await save('Page unsafeWindow', '/execution/page', '// @grant unsafeWindow\n// @inject-into page\n',
      'unsafeWindow.pageObject.count++;document.documentElement.dataset.pageWindow=String(unsafeWindow===window&&unsafeWindow.pageObject.count===8&&typeof GM_cookie==="undefined");');
    const shared = await page('/execution/page'); await until('document.documentElement.dataset.pageWindow', shared);
    check('Page-mode unsafeWindow reads and changes the actual page object without privileged APIs', await b.evaluate('pageObject.count===8&&document.documentElement.dataset.pageWindow==="true"', shared));
    await save('Top-level await', '/execution/await', '// @top-level-await\n// @run-at document-start\n// @grant GM.getValue\n// @grant GM.setValue\n',
      'document.documentElement.dataset.awaitStarted="yes";await GM.setValue("await-value",23);const value=await GM.getValue("await-value");document.documentElement.dataset.awaitFinished=String(value);');
    const awaited = await page('/execution/await'); await until('document.documentElement.dataset.awaitFinished', awaited);
    check('Top-level await keeps document-start prefix timing and awaits real GM storage', await b.evaluate('awaitObserved==="yes"&&document.documentElement.dataset.awaitFinished==="23"', awaited));
    await save('Unwrapped page', '/execution/raw/*', '// @unwrap\n// @run-at document-start\n// @inject-into page\n// @noframes\n// @grant GM_cookie\n// @exclude-match http://127.0.0.1/execution/raw/skip*\n',
      'var rawVariable=2;let rawLexical=3;const rawConstant=5;function rawFunction(){return rawVariable+rawLexical+rawConstant;}globalThis.rawAPIs=typeof GM_cookie+":"+typeof GM;');
    const raw = await page('/execution/raw/frames');
    await until('document.querySelector("iframe")?.contentDocument?.readyState==="complete"', raw);
    check('Unwrap preserves page globals and lexical declarations before page scripts run', await b.evaluate('rawObserved.value===10&&rawObserved.lexical===3&&rawObserved.constant===5&&rawObserved.variable===2&&rawAPIs==="undefined:undefined"', raw));
    check('Unwrap respects native noframes', await b.evaluate('document.querySelector("iframe").contentWindow.rawObserved===null', raw));
    const excluded = await page('/execution/raw/skip');
    check('Unwrap exclusion prevents even hoisted global declarations', await b.evaluate('rawObserved===null&&typeof rawFunction==="undefined"&&typeof rawVariable==="undefined"', excluded));
    await save('Unwrapped isolated', '/execution/raw-isolated', '// @unwrap\n// @grant GM_cookie\n',
      'var rawPrivate=1;let rawPrivateLexical=2;document.documentElement.dataset.rawIsolated=String(rawPrivate+rawPrivateLexical);');
    const rawIsolated = await page('/execution/raw-isolated'); await until('document.documentElement.dataset.rawIsolated', rawIsolated);
    check('Unwrap in content mode keeps globals off the page', await b.evaluate('document.documentElement.dataset.rawIsolated==="3"&&typeof rawPrivate==="undefined"', rawIsolated));
    const cookieId = await save('Owned cookie helpers', '/execution/cookies*', '// @grant GM_cookie\n// @grant GM.cookie\n// @connect self\n', `
      const d=document.documentElement.dataset;
      document.addEventListener('cookie-run',async()=>{
        const command=JSON.parse(d.cookieCommand);
        try {
          const value=command.legacy?await new Promise((resolve,reject)=>{
            const callback=command.method==='list'?(cookies,error)=>error?reject(new Error(error)):resolve(cookies):error=>error?reject(new Error(error)):resolve();
            d.cookieCallbackReturn=String(GM_cookie[command.method](command.details,callback)===undefined);
          }):await GM.cookie[command.method](command.details);
          d.cookieResult=JSON.stringify({ok:true,value});
        }catch(error){d.cookieResult=JSON.stringify({ok:false,error:error.message});}
      });d.cookieReady='yes';`);
    let cookies = await page('/execution/cookies'); await until('document.documentElement.dataset.cookieReady', cookies);
    const denied = await request(cookies, 'list');
    check('Native cookie access fails before optional permission is granted', !denied.ok && denied.error.includes('Allow cookie access'));
    await select(cookieId);
    check('Manager explains HttpOnly access and cookie scope', await until('document.getElementById("helperAccessText").textContent.includes("HttpOnly")&&document.getElementById("scriptPreview").textContent.includes("calling tab")'));
    if (evidence.browser !== 'firefox') for (const width of [1280, 390]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
      check('Cookie review fits width ' + width, await b.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth', manager));
      const height = await b.evaluate('document.documentElement.scrollHeight+1', manager);
      await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, manager);
      const shot = await b.send('Page.captureScreenshot', { format: 'png' }, manager);
      await fs.writeFile(path.join(temp, 'execution-review-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    }
    if (evidence.browser !== 'firefox') await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
    await grant(); check('Manager button grants native optional cookie access', true);
    const initial = await request(cookies, 'list', { name: 'offline_execution_http' }, true);
    check('Legacy list callback reads only the synthetic HttpOnly cookie', initial.ok && initial.value.length === 1 && initial.value[0].value === 'owned' && initial.value[0].httpOnly);
    check('HttpOnly remains inaccessible through page document.cookie', await b.evaluate('!document.cookie.includes("offline_execution_http=")&&document.documentElement.dataset.cookieCallbackReturn==="true"', cookies));
    check('Promise cookie set accepts native options', (await request(cookies, 'set', { name: 'offline_execution_set', value: 'synthetic', httpOnly: true, path: '/execution/', sameSite: 'lax' })).ok);
    const read = await request(cookies, 'list', { name: 'offline_execution_set' });
    check('Promise list confirms the native cookie value and flags', read.ok && read.value.length === 1 && read.value[0].value === 'synthetic' && read.value[0].httpOnly && read.value[0].sameSite === 'lax');
    check('Legacy deletion callback succeeds', (await request(cookies, 'delete', { name: 'offline_execution_set' }, true)).ok);
    check('Native cookie deletion is observable', (await request(cookies, 'list', { name: 'offline_execution_set' })).value.length === 0);
    for (const details of [{ url: 'https://unrelated.invalid/' }, { storeId: 'foreign-store' }, { partitionKey: { topLevelSite: 'https://unrelated.invalid' } }, { partitionKey: {} }]) {
      check('Cookie scope/options fail closed: ' + JSON.stringify(details), !(await request(cookies, 'list', details)).ok);
    }
    const ownSite = await b.evaluate('location.protocol+"//"+location.hostname', cookies);
    evidence.ownPartitionList = await request(cookies, 'list', { partitionKey: { topLevelSite: ownSite } });
    check('Cookie lists can address the calling tab’s own top-level partition', evidence.ownPartitionList.ok);
    const firstParty = await request(cookies, 'list', { firstPartyDomain: '' });
    check('firstPartyDomain is accepted only by Firefox', evidence.browser === 'firefox' ? firstParty.ok : !firstParty.ok && /only in Firefox/.test(firstParty.error));
    await b.evaluate('history.pushState({},"","/execution/outside-cookie-scope")', cookies);
    check('Same-document scope exit revokes cookie access', !(await request(cookies, 'set', { name: 'offline_execution_denied' })).ok);
    cookies = await page('/execution/cookies-again'); await until('document.documentElement.dataset.cookieReady', cookies);
    await b.evaluate(api + '.permissions.remove({permissions:["cookies"]})', manager);
    check('Removing native cookie permission rejects existing script calls', !(await request(cookies, 'list')).ok);
    await click('refresh'); await until('!document.getElementById("refresh").disabled'); await grant();
    const current = (await send({ type: 'US_LIST' })).scripts.find(script => script.id === cookieId);
    check('Cookie script disables cleanly', (await send({ type: 'US_ENABLE', id: cookieId, revision: current.revision, enabled: false })).ok);
    check('Disabling revokes old cookie API handles even with native permission present', !(await request(cookies, 'set', { name: 'offline_execution_denied' })).ok);
    const url = await b.evaluate('location.href', cookies);
    check('Rejected cookie writes never reached the native jar', (await b.evaluate(api + '.cookies.getAll({url:' + JSON.stringify(url) + ',name:"offline_execution_denied"})', manager)).length === 0);
    check('No privileged cookie API leaks into the page world', await b.evaluate('typeof GM_cookie==="undefined"&&typeof GM==="undefined"', cookies));
    if (evidence.browser === 'firefox') {
      // Firefox containers: inherit the source container, or honor an index.
      // The cookies permission is granted above; Firefox requires it for this.
      const origin = await b.evaluate('location.origin', cookies);
      await save('Firefox containers', '/execution/container-*', '// @grant GM.openInTab\n',
        'const tag=location.pathname.split("-").pop();GM.openInTab(location.origin+"/execution/target-"+tag,tag==="explicit"?{container:2,active:false}:{active:false});');
      const opened = api + '.tabs.query({}).then(tabs=>tabs.filter(tab=>/\\/execution\\/(container|target)-/.test(tab.url)))';
      await b.evaluate(api + '.tabs.create({url:' + JSON.stringify(origin + '/execution/container-inherit') + ',cookieStoreId:"firefox-container-1",active:false}).then(()=>true)', manager);
      await page('/execution/container-explicit');
      await until(opened + '.then(tabs=>["inherit","explicit"].every(tag=>tabs.some(tab=>tab.url.endsWith("/execution/target-"+tag))))');
      const stores = await b.evaluate(opened + '.then(tabs=>Object.fromEntries(tabs.map(tab=>[tab.url.replace(/^.*\\/execution\\//,""),tab.cookieStoreId])))', manager);
      evidence.firefoxContainers = stores;
      check('Firefox GM.openInTab keeps the source tab’s container', stores['container-inherit'] === 'firefox-container-1' && stores['target-inherit'] === 'firefox-container-1');
      check('Firefox GM.openInTab honors an explicit container index', stores['container-explicit'] === 'firefox-default' && stores['target-explicit'] === 'firefox-container-2');
      await b.evaluate(opened + '.then(tabs=>' + api + '.tabs.remove(tabs.filter(tab=>tab.cookieStoreId!=="firefox-default"||/target-/.test(tab.url)).map(tab=>tab.id))).then(()=>true)', manager);
    }
    check('Ad blocker remains enabled during execution compatibility tests', (await send({ type: 'GET_STATE' })).settings.enabled);
  } finally {
    for (const id of ids) {
      const script = (await send({ type: 'US_LIST' })).scripts?.find(item => item.id === id);
      if (script) await send({ type: 'US_DELETE', id, revision: script.revision });
    }
    for (const target of pages) await b.closePage(target);
    await b.evaluate(api + '.permissions.remove({permissions:["cookies"]})', manager);
  }
}
module.exports = { executionFixture, runExecution };
