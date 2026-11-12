/* Real input and real navigation, confined to disposable profiles and loopback. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createHash}=require('node:crypto');
const {chromium}=require('./browser-smoke.cjs');
const root=path.resolve(__dirname,'..'),browserName=process.argv[2]||'chrome';
if (!['chrome','edge'].includes(browserName)) throw new Error('Choose chrome or edge.');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
(async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'blockads-popup-guard-'+browserName+'-')),extension=path.join(temp,'extension');
  await fs.mkdir(extension);
  const files=(await fs.readdir(root)).filter(name=>/\.(js|css|html)$/.test(name)||name==='manifest.json').concat('rules','icons');
  for (const file of files) await fs.cp(path.join(root,file),path.join(extension,file),{recursive:true});
  const evidence={browser:browserName,temp,checks:[],requests:[],denied:[],hashes:{},started:new Date().toISOString()};
  for (const file of files.filter(name=>!['rules','icons'].includes(name)).concat('rules/ads.json')) evidence.hashes[file]=createHash('sha256').update(await fs.readFile(path.join(extension,file))).digest('hex');
  const check=(ok,message)=>{assert.ok(ok,message);evidence.checks.push(message);};
  const proxy=http.createServer((req,res)=>{evidence.denied.push(req.url);res.writeHead(403);res.end('Offline fixture');});
  proxy.on('connect',(req,socket)=>{evidence.denied.push(req.url);socket.on('error',()=>{});socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  let port;
  const fixture=http.createServer((req,res)=>{
    evidence.requests.push(req.url);res.setHeader('Content-Type','text/html');res.setHeader('Cache-Control','no-store');
    if (req.url.startsWith('/vendor')||req.url==='/ordinary') return res.end('<title>Local ordinary destination</title><p>Harmless fixture content</p>');
    const vendor='http://localhost:'+port+'/vendor';
    res.end(`<!doctype html><meta charset="utf-8"><title>Popup guard fixture</title>
      <style>body{margin:24px;font:16px sans-serif}button,a,img{margin:8px}button,a{display:inline-block;padding:14px;border:1px solid}video{width:120px;height:75px}img{width:100px;height:60px;background:skyblue}</style>
      <canvas id="canvas" width="120" height="75"></canvas><video id="video" muted playsinline></video>
      <button id="play">Play video</button><img id="hover" alt="Hover fixture" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='60'/%3E">
      <a id="off" target="_blank" href="${vendor}?case=off">Ordinary vendor link</a>
      <a id="image" target="_blank" href="${vendor}?case=image"><img alt="Image link" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='60'/%3E"></a>
      <a id="ordinary" target="_self" href="/ordinary">Ordinary same-tab navigation</a><a id="fragment" target="_self" href="#chapter">Chapter</a>
      <script>
      window.playClicks=0;window.hoverAttempts=0;
      const canvas=document.getElementById('canvas'),video=document.getElementById('video');
      const ctx=canvas.getContext('2d');ctx.fillStyle='seagreen';ctx.fillRect(0,0,120,75);video.srcObject=canvas.captureStream(5);
      setInterval(()=>{ctx.fillRect(0,0,120,75)},100);
      document.getElementById('play').onclick=event=>{window.playClicks++;window.playTrusted=event.isTrusted;window.playOpen=window.open('${vendor}?case=play');window.playPromise=video.play().then(()=>true);};
      document.getElementById('hover').onpointerenter=event=>{window.hoverAttempts++;window.hoverTrusted=event.isTrusted;window.hoverOpen=window.open('${vendor}?case=hover');};
      document.getElementById('image').onclick=()=>{window.imageHandlerRan=true;};
      </script>`);
  });
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));port=fixture.address().port;
  let browser,page;
  const api='(globalThis.browser||chrome)';
  const send=message=>browser.evaluate(api+'.runtime.sendMessage('+JSON.stringify(message)+')');
  const until=async(predicate,message)=>{for(let i=0;i<100;i++){if(await predicate())return;await pause(50);}throw new Error('Timed out: '+message);};
  const click=async expression=>{
    const point=await browser.evaluate(`(()=>{const node=${expression};node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,page);
    await browser.clickAt(point.x,point.y,page);
  };
  const tabs=()=>browser.evaluate(api+'.tabs.query({}).then(tabs=>tabs.map(tab=>tab.id))');
  try {
    browser=await chromium(extension,path.join(temp,'profile'),proxy.address().port,{headless:browserName!=='chrome'});
    evidence.version=browser.version;
    check((await send({type:'GET_STATE'})).ok,'the current extension loads and verifies its state');
    if (!process.argv.includes('--guard-only')) {
      const ads=JSON.parse(await fs.readFile(path.join(extension,'rules/ads.json'),'utf8'));
      const rule=ads.find(item=>item.condition.regexFilter?.includes('pxl\\.wheelroot\\.com'));
      check(!!rule,'the requested exact-host rule is packaged in the ad layer');
      const matches=(url,type='main_frame')=>browser.evaluate(`${api}.declarativeNetRequest.testMatchOutcome(${JSON.stringify({url,type,initiator:'https://ordinary.example'})}).then(result=>result.matchedRules.some(item=>item.rulesetId==='ads_ruleset'&&item.ruleId===${rule.id}))`);
      for (const type of ['main_frame','sub_frame','script','image','stylesheet','font','object','xmlhttprequest','ping','media','websocket','other']) check(await matches('https://pxl.wheelroot.com/fixture',type),'requested host blocks '+type+' in the native rule engine without a request');
      for (const url of ['https://PXL.WHEELROOT.COM./fixture','https://user:pass@pxl.wheelroot.com:8443/fixture','http://pxl.wheelroot.com/fixture']) check(await matches(url),'exact host handles URL normalization: '+url);
      for (const url of ['https://wheelroot.com/fixture','https://other.wheelroot.com/fixture','https://child.pxl.wheelroot.com/fixture','https://pxl.wheelroot.com.other.example/fixture','https://ordinary.example/?next=pxl.wheelroot.com']) check(!await matches(url),'requested rule does not expand scope: '+url);
      await send({type:'ADD_ALLOWED_DOMAIN',domain:'pxl.wheelroot.com'});
      check(!await matches('https://pxl.wheelroot.com/fixture'),'Always Allowed still overrides the requested ad block');
      await send({type:'REMOVE_ALLOWED_DOMAIN',domain:'pxl.wheelroot.com'});
      const previous=(await send({type:'GET_STATE'})).settings.customNetworkFilters;
      const exception='@@|https://pxl.wheelroot.com/needed.js|$script';
      check((await send({type:'SAVE_NETWORK_FILTERS',previous,text:exception})).ok &&
        !await matches('https://pxl.wheelroot.com/needed.js','script') && await matches('https://pxl.wheelroot.com/other.js','script'),
        'an explicit request exception allows only the selected path');
      await send({type:'SAVE_NETWORK_FILTERS',previous:exception,text:previous});
      await send({type:'UPDATE_SETTINGS',patch:{rulesets:{ads_ruleset:false}}});
      check(!await matches('https://pxl.wheelroot.com/fixture'),'turning off the ad layer disables the requested-host rule');
      await send({type:'UPDATE_SETTINGS',patch:{rulesets:{ads_ruleset:true}}});
    }
    check((await send({type:'UPDATE_SETTINGS',patch:{cosmeticFiltering:false,rulesets:{ads_ruleset:false,trackers_ruleset:false,threats_ruleset:false,community_ruleset:false}}})).ok,'popup fixtures run with network blocking disabled');
    page=await browser.open('http://127.0.0.1:'+port+'/test');
    const before=await tabs();await click('document.getElementById("off")');
    await until(()=>evidence.requests.includes('/vendor?case=off'),'unprotected ordinary vendor tab loads');
    const opened=(await tabs()).filter(id=>!before.includes(id));
    check(opened.length>0,'control: an unlisted ordinary destination loads when pop-up protection is off');
    await browser.evaluate(api+'.tabs.remove('+JSON.stringify(opened)+')');
    check((await send({type:'SET_SITE_POPUPS',domain:'127.0.0.1',blocked:true})).ok,'per-site protection is enabled through the existing settings interface');
    await browser.navigate(page,'http://127.0.0.1:'+port+'/test?protected');
    await click('document.getElementById("play")');
    check(await browser.evaluate('window.playClicks===1 && window.playTrusted && window.playOpen===null',page),'a real play-button click cannot open a vendor tab');
    check(await browser.evaluate('window.playPromise',page) && await browser.evaluate('!document.getElementById("video").paused',page),'the locally generated video still starts playing');
    const point=await browser.evaluate('(r=>({x:r.x+r.width/2,y:r.y+r.height/2}))(document.getElementById("hover").getBoundingClientRect())',page);
    await browser.send('Target.activateTarget',{targetId:page.id});
    await browser.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y},page);
    check(await browser.evaluate('window.hoverAttempts>0 && window.hoverTrusted && window.hoverOpen===null',page),'moving the pointer over an image cannot open a vendor tab');
    const protectedTabs=await tabs();
    await click('document.getElementById("image")');
    await until(()=>evidence.requests.includes('/vendor?case=image'),'an ordinary visible image link remains usable');
    check(await browser.evaluate('window.imageHandlerRan===true',page),'an ordinary visible image link and its click handler remain usable');
    await browser.evaluate(api+'.tabs.remove('+JSON.stringify((await tabs()).filter(id=>!protectedTabs.includes(id)))+')');
    await click('document.getElementById("fragment")');
    await until(()=>browser.evaluate('location.hash==="#chapter"',page),'same-tab fragment navigation');
    check(true,'ordinary same-tab links remain usable');
    check(!evidence.requests.some(url=>/^\/vendor\?case=(play|hover)/.test(url)),'play and hover pop-up attempts never reach the unlisted vendor fixture');
    await click('document.getElementById("ordinary")');
    await until(()=>browser.evaluate('location.pathname==="/ordinary"',page),'normal page navigation');
    check(true,'normal same-tab page navigation still succeeds');
    check((await send({type:'SET_SITE_POPUPS',domain:'127.0.0.1',blocked:false})).ok,'the per-site protection can be disabled');
    await browser.navigate(page,'http://127.0.0.1:'+port+'/test?disabled');await click('document.getElementById("play")');
    await until(()=>evidence.requests.includes('/vendor?case=play'),'disabled protection restores scripted windows');
    check(true,'disabling the guard and reloading restores scripted windows');
    check(!evidence.denied.some(url=>url.includes('wheelroot.com')),'no requested-host connection was attempted');
    evidence.success=true;
  } catch(error) {evidence.success=false;evidence.error=error.stack;process.exitCode=1;}
  finally {
    if(browser){evidence.cleanup=await browser.close();if(!evidence.cleanup.closed){evidence.success=false;process.exitCode=1;}}
    fixture.closeAllConnections();proxy.closeAllConnections();
    await Promise.all([new Promise(resolve=>fixture.close(resolve)),new Promise(resolve=>proxy.close(resolve))]);
    await fs.writeFile(path.join(temp,'evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({browser:browserName,success:evidence.success,checks:evidence.checks.length,evidence:path.join(temp,'evidence.json'),error:evidence.error},null,2));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
