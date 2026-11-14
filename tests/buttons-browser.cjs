/* Owned synthetic buttons and local destinations only. No download is executed. */
const fs = require('node:fs/promises');
const path = require('node:path');

function serve(req, res) {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (!url.pathname.startsWith('/button-fixture')) return false;
  if (url.pathname === '/button-fixture/guide.csv') {
    res.writeHead(200, {'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="guide.csv"'});
    res.end('name,value\nfixture,1\n'); return true;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname !== '/button-fixture') { res.end('<title>Harmless local destination</title><p>Owned fixture. No executable or external content.</p>'); return true; }
  const port = new URL('http://' + req.headers.host).port;
  res.end(`<!doctype html><meta charset="utf-8"><title>Local button protection fixture</title>
    <style>body{margin:24px;background:#f2f3ee;color:#172023;font:16px system-ui}main{max-width:850px}section{margin:20px 0;padding:16px;border:1px solid #b8bdb2;border-radius:10px;background:white}a,button{display:inline-block;padding:12px 18px;margin:6px;background:#c2f129;color:#172023;border:1px solid #819b31;border-radius:7px;font:inherit}video{display:block;width:360px;height:200px;background:#223e2e}#player{position:relative;width:360px;padding:0}#cover{position:absolute;inset:0;margin:0;display:grid;place-items:center;background:#152719aa;color:white}#adHidden{display:none}</style>
    <script>window.actions=[]; window.earlyActions=[]; window.watchAction=event=>{
      const node=event.composedPath().find(node=>node?.matches?.('[data-observe]'));
      if(node) earlyActions.push({id:node.id,type:event.type,trusted:event.isTrusted});
    }; ['pointerdown','mousedown','click','dblclick','auxclick','keydown','keyup','touchstart'].forEach(type=>window.addEventListener(type,watchAction,true));</script>
    <main><h1>Button protection</h1><p>Local fixtures for deceptive controls and ordinary downloads.</p>
      <section data-ad-slot="local"><span>Advertisement</span><br><a id="adDownload" data-observe href="#advert">Download</a><button id="adPlay" data-observe>Play video</button></section>
      <section><span>Sponsored</span><br><a id="sponsored" data-observe href="#sponsored">Start download</a></section>
      <section><button id="legitPlay" data-observe>Play video</button><button id="legitDownload" data-observe>Download file</button><a id="vendor" data-observe href="http://localhost:${port}/button-fixture/vendor" data-prevent>Download for Windows</a><a id="installer" data-observe data-prevent href="/button-fixture/app.exe">Download installer</a><a id="realDownload" data-observe href="/button-fixture/guide.csv" download="guide.csv">Download CSV</a></section>
      <section id="player"><video id="media" muted playsinline controls></video><a id="cover" data-observe href="http://localhost:${port}/button-fixture/advert" target="_blank">Play video</a></section>
      <section><a id="playInstaller" data-observe href="/button-fixture/player.EXE?name=video.mp4" target="_blank">Play now</a><a id="playMedia" data-observe data-prevent href="/button-fixture/movie.mp4">Play video</a></section>
      <article><p>How to avoid advertisements with fake download buttons.</p><a id="articleDownload" data-observe href="#article">Download guide</a></article>
      <div id="shadowHost"></div><div id="insertion"></div><div class="ad-slot" id="adCanary">Ad canary</div>
      <form id="legitForm"><input aria-label="Filename" value="guide.csv"><button id="formDownload" data-observe type="submit">Download</button></form>
    </main><script>
      const canvas=document.createElement('canvas');canvas.width=360;canvas.height=200;
      const context=canvas.getContext('2d');context.fillStyle='#20703c';context.fillRect(0,0,360,200);
      document.getElementById('media').srcObject=canvas.captureStream(1);
      window.buttonAction=event=>{const node=event.composedPath().find(node=>node?.matches?.('[data-observe]'));
        if(!node)return; actions.push({id:node.id,type:event.type,trusted:event.isTrusted});
        if(event.type==='click' && node.hasAttribute('data-prevent')) event.preventDefault();
        if(event.type==='click' && node.id==='legitPlay') window.playResult=document.getElementById('media').play().then(()=>true);
      };
      ['pointerdown','mousedown','click','dblclick','auxclick','keydown','keyup','touchstart'].forEach(type=>document.addEventListener(type,buttonAction));
      window.submits=0;document.getElementById('legitForm').addEventListener('submit',event=>{event.preventDefault();submits++;});
    </script>`);
  return true;
}

async function verify({ browser: b, page: existing, send, state, until, check, temporary, baseline = false }) {
  const original = (await state()).settings;
  const keys = ['enabled', 'cosmeticFiltering', 'notificationPromptBlocking', 'deceptivePromptBlocking', 'deceptiveButtonBlocking', 'promptAllowedDomains', 'whitelistedDomains', 'popupBlockedDomains'];
  const saved = Object.fromEntries(keys.filter(key => key in original).map(key => [key, original[key]]));
  const originalHostname=await b.evaluate('activeHostname');
  const origin = await b.evaluate('location.origin', existing);
  const patch = async patch => { const result = await send({type:'UPDATE_SETTINGS',patch}); if(!result.ok) throw new Error(result.error); };
  let page, lastActivation;
  const evaluate = expression => b.evaluate(expression, page);
  const wait = expression => until(b, expression, page);
  const node = id => id==='shadowPlay' ? "document.getElementById('shadowHost').shadowRoot.getElementById('shadowPlay')" : `document.getElementById(${JSON.stringify(id)})`;
  const click = async (id, button='left', target=page) => {
    // Firefox's browser-owned Picture-in-Picture toggle can cover the center of
    // a small video. Aim at the page link's top-left area, outside that native UI.
    const point = await b.evaluate(`(() => { const node=${node(id)};node.scrollIntoView({block:'center'});const box=node.getBoundingClientRect();return {x:box.x+${id==='cover'?'24':'box.width/2'},y:box.y+${id==='cover'?'24':'box.height/2'}};})()`,target);
    await b.clickAt(point.x, point.y, target, button==='double'?'left':button);
    if (button==='double') await b.clickAt(point.x, point.y, target, 'left', 2);
  };
  const reset = () => evaluate('(actions=[],earlyActions=[],history.replaceState(null,"",location.pathname),true)');
  const settled = async enabled => {
    await wait(`document.getElementById('adDownload').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}))===${!enabled}`);
    await reset();
  };
  const capture = async (name,target=page) => {
    const file=path.join(temporary,`buttons-${name}.png`);
    if(b.send) {await b.front(target); const {data}=await b.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},target);await fs.writeFile(file,Buffer.from(data,'base64'));}
    else await b.screenshot(file,target);
  };
  const tabs = () => b.evaluate('api.tabs.query({}).then(tabs=>tabs.map(({id,url})=>({id,url})))');
  const blocked = async (id,reason,gesture='left') => {
    await reset();await evaluate('(document.querySelector("[data-module-engine-button-notice]")?.remove(),true)');
    lastActivation={id,gesture,before:await tabs()};
    if (['Enter','Space'].includes(gesture)) {await evaluate(`(${node(id)}.focus(),true)`);await b.pressKey(gesture,page);}
    else await click(id,gesture);
    check(await evaluate('actions.length===0 && earlyActions.length===0 && location.hash===""'),`deceptive ${id} ${gesture} activation stops before early page handlers and navigation`);
    lastActivation.after=await tabs();
    check(lastActivation.after.length===lastActivation.before.length,`${id} ${gesture} activation creates no tab`);
    check(await evaluate(`document.querySelector('[data-module-engine-button-notice]')?.getAttribute('data-module-engine-button-notice')===${JSON.stringify(reason)}`),`${id} ${gesture} produces fresh trusted-input feedback with the fixed blocking reason`);
  };
  const allowed = async id => {
    await reset();await click(id);
    check(await evaluate(`actions.some(event=>event.id===${JSON.stringify(id)} && event.type==='click' && event.trusted) && earlyActions.some(event=>event.id===${JSON.stringify(id)} && event.type==='click' && event.trusted)`),`ordinary ${id} receives a native click through page capture and target handlers`);
  };
  try {
    await patch({ enabled:true, cosmeticFiltering:false, promptAllowedDomains:[], whitelistedDomains:[], popupBlockedDomains:[],
      ...(baseline ? {} : {deceptiveButtonBlocking:true}) });
    page = await b.open(origin + '/button-fixture');
    await b.evaluate(`(() => { globalThis.buttonTabEvents=[];globalThis.buttonCreated=tab=>buttonTabEvents.push({id:tab.id,url:tab.url,pendingUrl:tab.pendingUrl});api.tabs.onCreated.addListener(buttonCreated); })()`);
    const canary=await b.evaluate(`api.tabs.create({url:${JSON.stringify(origin+'/button-fixture/tab-canary')},active:false}).then(tab=>tab.id)`);
    await until(b,`buttonTabEvents.some(tab=>tab.id===${canary})`);
    await b.evaluate(`api.tabs.remove(${canary})`);
    await b.evaluate('(buttonTabEvents=[],true)');
    if (!baseline) await settled(true);
    await click('adDownload');
    check(await evaluate('actions.length===0 && earlyActions.length===0 && location.hash===""'),
      'recognized advertising Download control is stopped before page handlers and navigation');
    await blocked('adDownload','ad-button');
    await blocked('adPlay','ad-button');
    await blocked('adDownload','ad-button','Enter');
    await blocked('adPlay','ad-button','Space');
    await blocked('adDownload','ad-button','middle');
    await blocked('adDownload','ad-button','double');
    await blocked('sponsored','ad-button');
    await blocked('cover','player-overlay');
    await evaluate('(document.getElementById("cover").textContent="",true)');
    for (let repeat=0;repeat<5;repeat++) await blocked('cover','player-overlay');
    await blocked('cover','player-overlay','Enter');
    await blocked('playInstaller','play-installer');
    check(await b.evaluate('buttonTabEvents.length===0'),'blocked play/download controls create no delayed tabs before ordinary controls are exercised');
    await capture('blocked');
    check(await evaluate('document.querySelectorAll("[data-module-engine-button-notice]").length===1 && getComputedStyle(document.querySelector("[data-module-engine-button-notice]")).pointerEvents==="none" && !document.body.inert && getComputedStyle(document.body).overflow!=="hidden"'),'feedback uses one nonmodal, click-through notice and adds no page locks');
    for (const id of ['legitPlay','legitDownload','vendor','installer','playMedia','articleDownload','formDownload']) await allowed(id);
    await wait('playResult && !document.getElementById("media").paused');
    check(await evaluate('submits===1 && document.getElementById("media").currentTime>0'),'normal form submission and real local video playback remain functional');
    await allowed('realDownload');
    const downloadFile=path.join(temporary,'downloads','guide.csv');
    await until({evaluate:async()=>await fs.readFile(downloadFile,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})==='name,value\nfixture,1\n'},'byte-exact local CSV download');
    check(await fs.readFile(downloadFile,'utf8')==='name,value\nfixture,1\n','a normal browser download saves byte-exact local CSV in the disposable directory');
    await evaluate(`(() => {
      document.getElementById('insertion').innerHTML='<section data-ad-container><button id="dynamic" data-observe>Help</button></section><section><span style="display:none">Sponsored</span><button id="hiddenLabel" data-observe>Download</button></section><article><span>Sponsored</span><button id="newsDownload" data-observe>Download</button></article><div><span>Sponsored</span><div><div><button id="distantDownload" data-observe>Download</button></div></div></div>';
      document.getElementById('shadowHost').attachShadow({mode:'open'}).innerHTML='<div data-ad-slot="local"><button id="shadowPlay" data-observe style="padding:16px">Play</button></div>';
    })()`);
    await allowed('dynamic');
    await evaluate('(document.getElementById("dynamic").textContent="Play video",true)');
    await blocked('dynamic','ad-button');
    await evaluate('(document.getElementById("dynamic").textContent="Help",true)');await allowed('dynamic');
    await allowed('hiddenLabel');await allowed('newsDownload');await allowed('distantDownload');
    await evaluate(`(() => {const box=document.createElement('div');box.setAttribute('data-ad-slot','local');box.innerHTML='<button id="complex" data-observe>'+ '<span></span>'.repeat(80)+'Play</button>';document.getElementById('insertion').append(box);})()`);
    await allowed('complex');
    await evaluate('(document.getElementById("complex").setAttribute("aria-label","Play video"),true)');
    await blocked('complex','ad-button');
    await blocked('shadowPlay','ad-button');
    await evaluate('(document.getElementById("cover").href="#media",document.getElementById("cover").removeAttribute("target"),document.getElementById("cover").textContent="Play video",true)');
    await allowed('cover');
    await evaluate(`(() => {const frame=document.createElement('iframe');frame.id='guardFrame';frame.width=600;frame.height=250;frame.src=${JSON.stringify(origin+'/button-fixture?child=1')};document.body.append(frame);})()`);
    await wait(`document.getElementById('guardFrame').contentDocument?.getElementById('adDownload') && !document.getElementById('guardFrame').contentDocument.getElementById('adDownload').dispatchEvent(new MouseEvent('pointerdown',{bubbles:true,cancelable:true,button:0}))`);
    const framePoint=await evaluate(`(() => {const frame=document.getElementById('guardFrame');frame.scrollIntoView({block:'center'});const doc=frame.contentDocument;doc.getElementById('adDownload').scrollIntoView({block:'center'});frame.contentWindow.actions=[];frame.contentWindow.earlyActions=[];const outer=frame.getBoundingClientRect(),box=doc.getElementById('adDownload').getBoundingClientRect();return {x:outer.x+frame.clientLeft+box.x+box.width/2,y:outer.y+frame.clientTop+box.y+box.height/2};})()`);
    await b.clickAt(framePoint.x,framePoint.y,page);
    check(await evaluate('document.getElementById("guardFrame").contentWindow.actions.length===0 && document.getElementById("guardFrame").contentWindow.earlyActions.length===0 && !!document.getElementById("guardFrame").contentDocument.querySelector("[data-module-engine-button-notice]")'),'native input in an HTTP iframe receives button protection before frame handlers');
    await evaluate('(document.getElementById("guardFrame").remove(),true)');
    await patch({deceptiveButtonBlocking:false});await settled(false);await allowed('adDownload');
    check(!await evaluate('document.querySelector("[data-module-engine-button-notice]")!==null'),'switching the guard off removes its notice');
    await patch({deceptiveButtonBlocking:true});await settled(true);await blocked('adDownload','ad-button');
    for (const patchOff of [{promptAllowedDomains:['127.0.0.1']},{whitelistedDomains:['127.0.0.1']},{enabled:false}]) {
      await patch(patchOff);await settled(false);await allowed('adDownload');
      await patch({promptAllowedDomains:[],whitelistedDomains:[],enabled:true});await settled(true);
      await blocked('adDownload','ad-button');
    }
    await patch({cosmeticFiltering:true,promptAllowedDomains:['127.0.0.1']});
    await wait('getComputedStyle(document.getElementById("adCanary")).display==="none"');
    check(true,'trusted button exception leaves cosmetic ad blocking active');
    check((await state()).settings.rulesets.ads_ruleset===original.rulesets.ads_ruleset,'button settings preserve the ad-network ruleset');
    await patch({cosmeticFiltering:false,promptAllowedDomains:[],popupBlockedDomains:['127.0.0.1']});
    await b.navigate(page,origin+'/button-fixture');await settled(true);await blocked('adDownload','ad-button');
    await allowed('legitPlay');await wait('playResult && !document.getElementById("media").paused');
    check(true,'button guard coexists with selected-site popup and notification guards');
    await patch({popupBlockedDomains:[]});
    await b.navigate(page,origin+'/button-fixture/away');
    await evaluate('(history.back(),true)');
    await wait('location.pathname==="/button-fixture" && !!document.getElementById("adDownload")');await settled(true);
    await blocked('adDownload','ad-button');
    check(true,'button capture resumes after navigating away and back');
    await until(b,'!busy && currentSettings.deceptiveButtonBlocking');
    await b.evaluate('(activeHostname="127.0.0.1",currentDomainEl.textContent=activeHostname,renderUI(),true)');
    await click('toggleDeceptiveButtons','left',b.popup);
    await until(b,'!busy && !currentSettings.deceptiveButtonBlocking');await settled(false);await allowed('adDownload');
    check(await b.evaluate('currentSettings.notificationPromptBlocking && currentSettings.deceptivePromptBlocking && currentSettings.rulesets.ads_ruleset'),'native button toggle leaves notification, install and ad filters on');
    await click('toggleDeceptiveButtons','left',b.popup);await until(b,'!busy && currentSettings.deceptiveButtonBlocking');await settled(true);
    await click('toggleSitePrompts','left',b.popup);await until(b,'!busy && currentSettings.promptAllowedDomains.includes("127.0.0.1")');await settled(false);await allowed('adDownload');
    await click('toggleSitePrompts','left',b.popup);await until(b,'!busy && !currentSettings.promptAllowedDomains.includes("127.0.0.1")');await settled(true);
    if(b.send)await b.send('Emulation.setDeviceMetricsOverride',{width:350,height:600,deviceScaleFactor:1,mobile:false},b.popup);
    await b.evaluate('(document.getElementById("toggleDeceptiveButtons").scrollIntoView({block:"center"}),true)');
    await capture('popup',b.popup);
    check(await b.evaluate('document.documentElement.scrollWidth<=innerWidth && !toggleDeceptiveButtons.disabled && toggleDeceptiveButtons.checked'),'new popup button control fits the narrow layout and renders verified state');
    await blocked('playInstaller','play-installer');
    await wait('!document.querySelector("[data-module-engine-button-notice]")');
    check(true,'the feedback notice expires and removes itself');
    check(await b.evaluate('buttonTabEvents.length===0'),'native tab-created observer sees no delayed or transient tabs from any blocked activation');
    await evaluate('(document.getElementById("vendor").removeAttribute("data-prevent"),document.getElementById("vendor").target="_blank",true)');
    await allowed('vendor');
    await until(b,'buttonTabEvents.length===1');
    const normalTab=await b.evaluate('buttonTabEvents[0].id');
    await until(b,`api.tabs.get(${normalTab}).then(tab=>tab.url===${JSON.stringify(origin.replace('127.0.0.1','localhost')+'/button-fixture/vendor')})`);
    check(true,'an ordinary external Download link still opens its intended local tab');
    await b.evaluate(`api.tabs.remove(${normalTab})`);
  } catch (error) {
    if (page) {await capture('failure');await fs.writeFile(path.join(temporary,'buttons-failure.json'), JSON.stringify({lastActivation,page:await evaluate('({actions,earlyActions,href:location.href})'),tabs:await tabs(),created:await b.evaluate('globalThis.buttonTabEvents')},null,2));}
    throw error;
  } finally {
    if(page) await b.closePage(page);
    await b.evaluate('(() => {if(globalThis.buttonCreated)api.tabs.onCreated.removeListener(buttonCreated);delete globalThis.buttonCreated;delete globalThis.buttonTabEvents;})()');
    await patch(saved);
    await b.evaluate(`(activeHostname=${JSON.stringify(originalHostname)},currentDomainEl.textContent=activeHostname||'Browser / unsupported page',renderUI(),true)`);
    if(b.send)await b.send('Emulation.clearDeviceMetricsOverride',{},b.popup);
  }
}
module.exports = {serve,verify};
