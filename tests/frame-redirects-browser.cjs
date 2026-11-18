/* Browser-enforced frame navigation and actual local video playback. No live hosts. */
'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const http = require('node:http'), assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { chromium } = require('./browser-smoke.cjs');
const { files } = require('../scripts/extension-files.cjs');
const root = path.resolve(__dirname, '..'), name = process.argv[2] || 'chrome';
if (!['chrome', 'edge'].includes(name)) throw new Error('Choose chrome or edge');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'blockads-frame-media-' + name + '-'));
  const extension = path.join(temp, 'extension'); await fs.mkdir(extension);
  for (const file of files) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const report = { browser: name, temp, checks: [], requests: [], messages: [], denied: [], hashes: {}, started: new Date().toISOString() };
  for (const file of files) report.hashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  const check = (ok, label) => { assert.ok(ok, label); report.checks.push(label); };
  const until = async (fn, label) => {
    for (let i = 0; i < 150; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + label);
  };
  const proxy = http.createServer((req, res) => { report.denied.push(req.url); res.writeHead(403); res.end(); });
  proxy.on('connect', (req, socket) => {
    report.denied.push(req.url); socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let port;
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/report') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { report.messages.push(JSON.parse(body)); res.end('ok'); }); return;
    }
    report.requests.push(req.url); res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
    const test = url.searchParams.get('test') || 'player';
    if (url.pathname === '/strict') { res.setHeader('Content-Security-Policy', 'sandbox'); return res.end('<p>Strict site CSP</p><script>window.siteScriptRan=true</script>'); }
    if (url.pathname === '/destination') return res.end('<title>Local destination</title><p>Local destination</p>');
    if (url.pathname === '/hop') { res.writeHead(302, { Location: 'http://localhost:' + port + '/destination?test=' + test }); return res.end(); }
    if (url.pathname === '/frame-hop') { res.writeHead(302, { Location: 'http://127.0.0.1:' + port + '/frame-final?test=' + test }); return res.end(); }
    if (url.pathname === '/frame-final') return res.end(`<p>Frame navigated locally</p><script>navigator.sendBeacon('/report',JSON.stringify({test:${JSON.stringify(test)},action:'frame-loaded'}))</script>`);
    if (url.pathname === '/nested') return res.end(`<style>body{margin:0}iframe{border:0;width:610px;height:240px}</style><iframe allow="autoplay; fullscreen; picture-in-picture" allowfullscreen src="http://127.0.0.1:${port}/frame?test=${test}"></iframe>`);
    if (url.pathname === '/frame') return res.end(`<!doctype html><style>body{margin:0}button{position:absolute;top:0;width:120px;height:40px;margin:0}canvas,video{position:absolute;top:50px;width:160px;height:90px}video{left:170px}</style>
      <button id="play" style="left:0">Play</button><button id="pause" style="left:120px">Pause</button><button id="seek" style="left:240px">Seek</button><button id="full" style="left:360px">Fullscreen</button><button id="next" style="left:480px">Frame page</button>
      <canvas id="canvas" width="160" height="90"></canvas><video id="video" muted playsinline loop controls preload="auto"></video>
      <script>
      const test=${JSON.stringify(test)},video=document.getElementById('video'),canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d');
      const post=(action,extra={})=>navigator.sendBeacon('/report',JSON.stringify({test,action,paused:video.paused,time:video.currentTime,...extra}));
      post('initializing');video.onerror=()=>post('media-error',{code:video.error?.code,message:video.error?.message});
      window.addEventListener('error',event=>{post('error',{name:event.error?.name,message:event.message});if(event.error?.name==='SecurityError')event.preventDefault()});
      const stream=canvas.captureStream(20),recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}),chunks=[];
      recorder.ondataavailable=event=>chunks.push(event.data);
      recorder.onstop=()=>{const blob=new Blob(chunks,{type:'video/webm'});post('recorded',{bytes:blob.size});video.src=URL.createObjectURL(blob);video.load();stream.getTracks().forEach(track=>track.stop());};
      video.onloadedmetadata=()=>post('metadata');
      video.onloadeddata=()=>{let storage=false;try{localStorage.setItem('fixture','ok');storage=localStorage.getItem('fixture')==='ok';localStorage.removeItem('fixture')}catch{}post('ready',{storage});};
      let frame=0;recorder.start();const clock=setInterval(()=>{ctx.fillStyle=frame%2?'green':'blue';ctx.fillRect(0,0,160,90);if(++frame===20){clearInterval(clock);recorder.stop()}},50);
      video.ontimeupdate=()=>post('time');
      // Independent ad and player listeners: an ad's blocked navigation must not
      // prevent the normal player listener from receiving the same trusted click.
      document.getElementById('play').addEventListener('click',()=>{top.location.href='http://localhost:${port}/destination?test='+test});
      document.getElementById('play').addEventListener('click',async event=>{await video.play();post('play',{trusted:event.isTrusted})});
      document.getElementById('pause').onclick=()=>{video.pause();post('pause')};
      document.getElementById('seek').onclick=()=>{video.addEventListener('seeked',()=>post('seek'),{once:true});video.currentTime=.35};
      document.getElementById('full').onclick=async()=>{try{await video.requestFullscreen();post('fullscreen',{full:document.fullscreenElement===video});await document.exitFullscreen();post('exit-fullscreen')}catch(error){post('fullscreen',{error:error.message})}};
      document.getElementById('next').onclick=()=>location.assign('/frame-hop?test='+test);
      </script>`);
    res.end(`<!doctype html><title>Protected local player</title><style>iframe{display:block;border:0;width:610px;height:240px}button,a{padding:8px;margin:4px}video,canvas{width:140px;height:80px}</style>
      <button id="play">Play and redirect</button><button id="reload">Script reload</button><a id="link" href="/hop?test=link">Intentional navigation</a>
      <canvas id="canvas" width="140" height="80"></canvas><video id="video" muted playsinline></video>
      <iframe id="frame" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen src="http://localhost:${port}/frame?test=${test}"></iframe>
      <script>window.marker=crypto.randomUUID();const test=${JSON.stringify(test)},video=document.getElementById('video'),canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='green';ctx.fillRect(0,0,140,80);video.srcObject=canvas.captureStream(10);setInterval(()=>ctx.fillRect(0,0,140,80),100);
      document.getElementById('play').onclick=event=>{window.trusted=event.isTrusted;window.played=video.play();location.assign('/hop?test='+test)};
      document.getElementById('reload').onclick=()=>location.reload();window.ready=true;</script>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); port = fixture.address().port;
  let browser, page;
  const messages = (test, action) => report.messages.filter(item => item.test === test && item.action === action);
  const requested = test => report.requests.includes('/destination?test=' + test);
  try {
    browser = await chromium(extension, path.join(temp, 'profile'), proxy.address().port, { headless: name !== 'chrome' }); report.version = browser.version;
    const api = '(globalThis.browser||chrome)';
    const send = async message => { const result = await browser.evaluate(api + '.runtime.sendMessage(' + JSON.stringify(message) + ')'); assert.equal(result.ok, true); return result; };
    const open = async test => { if (page) await browser.closePage(page); page = await browser.open('http://127.0.0.1:' + port + '/player?test=' + test); };
    const click = async (id, frameX) => {
      await browser.send('Target.activateTarget', { targetId: page.id });
      const point = await browser.evaluate(`(async()=>{const el=document.getElementById(${JSON.stringify(id)});el.scrollIntoView({block:'center',behavior:'instant'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();return{x:r.x+el.clientLeft,y:r.y+el.clientTop,width:r.width,height:r.height}})()`, page);
      await browser.clickAt(point.x + (frameX ?? point.width / 2), point.y + (frameX === undefined ? point.height / 2 : 20), page);
    };
    const policy = () => browser.evaluate(api + '.declarativeNetRequest.getDynamicRules().then(rules=>rules.filter(rule=>rule.action.type==="modifyHeaders"))');
    await send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: false, rulesets: { ads_ruleset: false, trackers_ruleset: false, threats_ruleset: false, community_ruleset: false } } });
    check((await policy()).length === 0, 'guard policy is absent before site opt-in');
    await open('control'); await until(() => messages('control', 'ready').length, 'control media ready'); await click('frame', 60);
    await until(() => requested('control'), 'unguarded frame takeover'); check(true, 'control: an unguarded real frame click reaches the local destination');
    await open('server-control'); await click('play'); await until(() => requested('server-control'), 'unguarded HTTP redirect'); check(true, 'control: the unguarded server redirect reaches the local destination');
    await send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: true });
    const policies = await policy(); check(policies.length === 1, 'site opt-in installs one browser sandbox policy');
    check(policies[0].action.responseHeaders[0].operation === 'append', 'the existing server CSP is appended to, never replaced');
    check(policies[0].condition.resourceTypes.join() === 'main_frame', 'the policy does not rewrite media, script or API responses');
    await send({ type: 'ADD_ALLOWED_DOMAIN', domain: '127.0.0.1' });
    await open('protected'); await until(() => messages('protected', 'ready').length, 'protected media ready');
    check(messages('protected', 'ready')[0].storage, 'embedded player origin and local storage remain usable');
    const marker = await browser.evaluate('window.marker', page);
    await click('frame', 60); await until(() => messages('protected', 'play').length, 'player receives the click after the ad listener');
    check(messages('protected', 'play')[0].trusted, 'the real play click reaches the normal player listener');
    await until(() => messages('protected', 'time').some(item => item.time > .15 && !item.paused), 'decoded video clock advances');
    check(!requested('protected') && await browser.evaluate('window.marker===' + JSON.stringify(marker), page), 'frame takeover is blocked and the exact player document survives');
    check(messages('protected', 'error').some(item => item.name === 'SecurityError'), 'the browser enforces the frame navigation restriction');
    check(true, 'the locally recorded WebM decodes and advances after the blocked takeover');
    await click('frame', 180); await until(() => messages('protected', 'pause').length, 'pause'); check(messages('protected', 'pause')[0].paused, 'embedded video can pause');
    await click('frame', 300); await until(() => messages('protected', 'seek').length, 'seek'); check(Math.abs(messages('protected', 'seek')[0].time - .35) < .1, 'embedded video can seek');
    await click('frame', 60); await until(() => messages('protected', 'play').length === 2, 'resume'); check(!messages('protected', 'play')[1].paused, 'embedded video can resume');
    await click('frame', 420); await until(() => messages('protected', 'exit-fullscreen').length, 'fullscreen exit');
    check(messages('protected', 'fullscreen').some(item => item.full), 'embedded video can enter and exit fullscreen');
    await click('frame', 540); await until(() => messages('protected', 'frame-loaded').length, 'iframe-local HTTP redirect');
    check(await browser.evaluate('window.marker===' + JSON.stringify(marker), page), 'a player frame can follow its own HTTP redirect without replacing the top page');
    await open('nested');
    await browser.evaluate(`document.getElementById('frame').src='http://localhost:${port}/nested?test=nested-child'`, page);
    await until(() => messages('nested-child', 'ready').length, 'nested media ready'); await click('frame', 60);
    await until(() => messages('nested-child', 'play').length, 'nested playback');
    check(!requested('nested-child') && messages('nested-child', 'error').some(item => item.name === 'SecurityError'), 'nested frames inherit the restriction and still play');
    await open('server'); const serverMarker = await browser.evaluate('window.marker', page); await click('play');
    await browser.evaluate('window.played', page);
    check(!report.requests.includes('/hop?test=server') && !requested('server'), 'the scripted HTTP redirect is stopped before its first request');
    check(await browser.evaluate('window.marker===' + JSON.stringify(serverMarker) + ' && !document.getElementById("video").paused && window.trusted', page), 'top video playback survives its native play-button redirect attempt');
    await click('reload'); check(await browser.evaluate('window.marker===' + JSON.stringify(serverMarker), page), 'scripted reload cannot start an uninspected server redirect');
    await click('link'); await until(() => requested('link'), 'intentional HTTP redirect'); check(true, 'an intentional real link may still follow an HTTP redirect');
    const strict = await browser.open('http://127.0.0.1:' + port + '/strict');
    check(await browser.evaluate('window.siteScriptRan===undefined', strict), 'a pre-existing server sandbox still prevents site scripts');
    check(await browser.evaluate('(()=>{try{localStorage.getItem("fixture");return false}catch(error){return error.name==="SecurityError"}})()', strict), 'a pre-existing opaque-origin sandbox remains enforced');
    await browser.closePage(strict);
    for (const [test, change] of [
      ['paused', { type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: true }],
      ['disabled', { type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: false }]
    ]) {
      await send(change); await open(test); await until(() => messages(test, 'ready').length, test + ' media'); await click('frame', 60);
      await until(() => requested(test), test + ' restores frame navigation'); check(true, test + ': reload removes the inherited restriction');
      if (test === 'paused') await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: false });
    }
    check((await policy()).length === 0, 'disabling the guard removes its browser policy');
    check(!(await send({ type: 'GET_LOG' })).entries.some(entry => entry.kind === 'blocked'), 'sandbox header matches are not misreported as blocked requests');
    check(!report.messages.some(item => item.action === 'error' && item.name !== 'SecurityError'), 'fixtures report no unexpected player errors');
    report.success = true;
  } catch (error) { report.success = false; report.error = error.stack; report.exceptions = browser?.events.filter(event => event.method === 'Runtime.exceptionThrown'); process.exitCode = 1; }
  finally {
    try { if (browser) { report.cleanup = await browser.close(); if (!report.cleanup.closed) { report.success = false; process.exitCode = 1; } } }
    catch (error) { report.cleanupError = error.message; report.success = false; process.exitCode = 1; }
    finally {
      fixture.closeAllConnections(); proxy.closeAllConnections();
      await Promise.all([new Promise(resolve => fixture.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
      await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(report, null, 2));
      console.log(JSON.stringify({ browser: name, success: report.success, checks: report.checks.length, error: report.error, evidence: path.join(temp, 'evidence.json') }, null, 2));
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
