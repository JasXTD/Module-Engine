/* Same-tab navigation tests: disposable browsers, generated media and loopback only. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('./browser-smoke.cjs');
const { files } = require('../scripts/extension-files.cjs');
const root = path.resolve(__dirname, '..');
const browserName = process.argv[2] || 'chrome';
if (!['chrome', 'edge'].includes(browserName)) throw new Error('Choose chrome or edge.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'blockads-redirects-' + browserName + '-'));
  const extension = path.join(temp, 'extension');
  await fs.mkdir(extension);
  for (const file of files) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const evidence = { browser: browserName, temp, started: new Date().toISOString(), checks: [], limitations: [], requests: [], denied: [], navigations: [], hashes: {} };
  for (const file of files) evidence.hashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  const check = (ok, message) => { assert.ok(ok, message); evidence.checks.push(message); };
  const proxy = http.createServer((req, res) => { evidence.denied.push(req.url); res.writeHead(403); res.end('Offline fixture'); });
  proxy.on('connect', (req, socket) => {
    evidence.denied.push(req.url); socket.on('error', () => {});
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  let port;
  const fixture = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/observe') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { evidence.navigations.push(JSON.parse(body)); res.end('ok'); });
      return;
    }
    evidence.requests.push(req.url);
    res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/destination') return res.end('<title>Local destination</title><p>Harmless local destination</p>');
    const destination = 'http://localhost:' + port + '/destination';
    if (url.pathname === '/redirect') { res.writeHead(302, { Location: destination + '?case=httpRedirect' }); return res.end(); }
    if (url.pathname === '/frame') return res.end(`<!doctype html><button id="framePlay" style="position:fixed;left:0;top:0;width:180px;height:45px;margin:0" onclick="navigator.sendBeacon('/observe',JSON.stringify({frameClick:true,trusted:event.isTrusted}));try{top.location.href='${destination}?case=frame'}catch(error){navigator.sendBeacon('/observe',JSON.stringify({test:'frame',blocked:error.name==='SecurityError'}))}">Frame play</button>`);
    res.end(`<!doctype html><meta charset="utf-8"><title>Same-tab player fixture</title>
      <style>body{font:16px sans-serif;margin:16px}button,a,input{display:inline-block;padding:8px;margin:4px}video{width:120px;height:75px}iframe{width:300px;height:65px}</style>
      <canvas id="canvas" width="120" height="75"></canvas><video id="video" muted playsinline></video>
      <div id="buttons"></div>
      <a id="link" href="${destination}?case=link">Ordinary external link</a>
      <a id="keyboard" href="${destination}?case=keyboard">Keyboard external link</a>
      <a id="scriptLink" href="${destination}?case=scriptLink">Script-handled link</a>
      <a id="hijackLink" href="#chapter">Internal chapter link</a>
      <a id="mutatedLink" href="${destination}?case=intended">Link changed during click</a>
      <a id="lateLink" href="${destination}?case=lateLink">Link with delayed handler</a>
      <form id="getForm" action="${destination}" method="get"><input name="case" value="getForm" type="hidden"><button id="getSubmit">Search</button></form>
      <form id="postForm" action="${destination}?case=postForm" method="post"><input name="q" value="local"><button id="postSubmit">Submit</button></form>
      <form id="autoForm" action="${destination}?case=scriptForm" method="post"><input name="q" value="local"></form>
      <a id="sameLink" href="/destination?case=sameLink">Same-host page</a><a id="hashLink" href="#chapter">Chapter</a>
      <iframe id="frame" src="http://localhost:${port}/frame"></iframe>
      <script>
      const destination=${JSON.stringify(destination)},key=new URLSearchParams(location.search).get('test');
      window.attempts=[];window.navEvents=[];
      navigation.addEventListener('navigate',event=>{
        const record={test:key,url:event.destination.url,cancelable:event.cancelable,prevented:event.defaultPrevented,userInitiated:event.userInitiated,type:event.navigationType,source:event.sourceElement?.tagName||null};
        window.navEvents.push(record);navigator.sendBeacon('/observe',JSON.stringify(record));
      });
      const canvas=document.getElementById('canvas'),video=document.getElementById('video'),ctx=canvas.getContext('2d');
      ctx.fillStyle='seagreen';ctx.fillRect(0,0,120,75);video.srcObject=canvas.captureStream(5);setInterval(()=>ctx.fillRect(0,0,120,75),100);
      const run={
        href:()=>{location.href=destination+'?case=href'},
        assign:()=>location.assign(destination+'?case=assign'),
        replace:()=>location.replace(destination+'?case=replace'),
        timer:()=>setTimeout(()=>{location.href=destination+'?case=timer';window.timerDone=true},0),
        navigation:()=>{const result=navigation.navigate(destination+'?case=navigation');result.committed.catch(()=>{});result.finished.catch(()=>{})},
        synthetic:()=>{const a=document.createElement('a');a.href=destination+'?case=synthetic';a.click()},
        scriptForm:()=>document.getElementById('autoForm').submit(),
        sameScript:()=>{location.href='/destination?case=sameScript'},
        history:()=>history.pushState(null,'','#route'),
        refresh:()=>{const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url='+destination+'?case=refresh';document.head.append(meta)}
      };
      for(const [id,fn] of Object.entries(run)){const button=document.createElement('button');button.id=id;button.textContent=id;button.onclick=event=>{window.attempts.push({id,trusted:event.isTrusted});window.playResult=video.play().then(()=>true);fn()};document.getElementById('buttons').append(button)}
      document.getElementById('hijackLink').onclick=event=>{event.preventDefault();location.href=destination+'?case=hijackLink'};
      document.getElementById('scriptLink').onclick=event=>{event.preventDefault();location.assign(event.currentTarget.href)};
      document.getElementById('mutatedLink').onclick=event=>{event.currentTarget.href=destination+'?case=mutatedLink'};
      document.getElementById('lateLink').onclick=event=>{event.preventDefault();const href=event.currentTarget.href;setTimeout(()=>location.assign(href),0)};
      window.ready=true;
      </script>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve)); port = fixture.address().port;
  let browser, page;
  const api = '(globalThis.browser||chrome)';
  const until = async (predicate, message) => {
    for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(50); }
    throw new Error('Timed out: ' + message);
  };
  const committed = expression => until(async () => {
    try { return await browser.evaluate('document.readyState==="complete" && (' + expression + ')', page); }
    catch (error) {
      if (/Execution context was destroyed|Cannot find context with specified id|Not attached to an active page/.test(error.message)) return false;
      throw error;
    }
  }, 'committed document: ' + expression);
  const send = async message => {
    const result = await browser.evaluate(api + '.runtime.sendMessage(' + JSON.stringify(message) + ')');
    assert.equal(result.ok, true, JSON.stringify(message)); return result;
  };
  const open = async name => {
    if (page) await browser.closePage(page);
    page = await browser.open('http://127.0.0.1:' + port + '/player?test=' + name);
    assert.equal(await browser.evaluate('window.ready', page), true);
  };
  const click = async id => {
    await browser.send('Target.activateTarget', { targetId: page.id });
    const point = await browser.evaluate(`(async()=>{const node=document.getElementById(${JSON.stringify(id)});node.scrollIntoView({block:'center',behavior:'instant'});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, page);
    await browser.clickAt(point.x, point.y, page);
  };
  const loaded = name => evidence.requests.some(request => request === '/destination?case=' + name);
  const allowed = async (name, id = name) => {
    await open(name); await click(id); await until(() => loaded(name), name + ' reaches the local destination');
    check(true, name + ': intentional navigation still loads');
  };
  const blocked = async name => {
    await open(name); await click(name);
    await until(() => loaded(name) || evidence.navigations.some(item => item.test === name && item.url.includes('/destination')), name + ' navigation attempt');
    check(!loaded(name) && evidence.navigations.some(item => item.test === name && item.prevented), name + ': redirect is cancelled before its destination is requested');
    check(await browser.evaluate('location.pathname==="/player" && window.attempts[0]?.trusted', page), name + ': native click leaves the player document intact');
    check(await browser.evaluate('window.playResult', page) && await browser.evaluate('!document.getElementById("video").paused', page), name + ': the generated video still plays');
  };
  try {
    browser = await chromium(extension, path.join(temp, 'profile'), proxy.address().port, { headless: browserName !== 'chrome' });
    evidence.version = browser.version;
    await send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: false, rulesets: { ads_ruleset: false, trackers_ruleset: false, threats_ruleset: false, community_ruleset: false } } });
    await open('guard-off'); await click('href'); await until(() => loaded('href'), 'guard-off redirect');
    check(true, 'control: without the per-site guard a play-button redirect reaches the unlisted local destination');
    evidence.requests.length = 0;
    await send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: true });
    for (const name of ['href', 'assign', 'replace', 'timer', 'navigation', 'scriptForm', 'refresh', 'sameScript']) await blocked(name);
    await open('synthetic'); await click('synthetic');
    check(await browser.evaluate('window.attempts[0]?.trusted && location.pathname==="/player"', page) && !loaded('synthetic'), 'synthetic same-tab anchor clicks remain blocked');
    for (const name of ['hijackLink', 'mutatedLink', 'lateLink']) {
      await open(name); await click(name);
      await until(() => evidence.navigations.some(item => item.test === name), name + ' navigation');
      check(!loaded(name) && evidence.navigations.some(item => item.test === name && item.prevented) &&
        await browser.evaluate('location.pathname==="/player"', page), name + ': a changed destination or stale click intent does not authorize a redirect');
    }
    for (const [name, id] of [['link', 'link'], ['scriptLink', 'scriptLink'], ['getForm', 'getSubmit'], ['postForm', 'postSubmit'], ['sameLink', 'sameLink']]) await allowed(name, id);
    await open('keyboard'); await browser.evaluate('document.getElementById("keyboard").focus()', page);
    await browser.send('Target.activateTarget', { targetId: page.id }); await browser.pressKey('Enter', page);
    await until(() => loaded('keyboard'), 'keyboard link'); check(true, 'keyboard activation of a normal external link remains usable');
    // Emulate the API shape before Chromium 135 without mocking navigation or
    // native input. This is compatibility coverage, not an old-browser run.
    for (const [name, id, target] of [['legacyGet', 'getSubmit', 'getForm'], ['legacyPost', 'postSubmit', 'postForm']]) {
      await open(name);
      check(await browser.evaluate('delete NavigateEvent.prototype.sourceElement && !("sourceElement" in NavigateEvent.prototype)', page), name + ': fixture omits the newer sourceElement property');
      const before = evidence.requests.filter(item => item === '/destination?case=' + target).length;
      await click(id);
      await until(() => evidence.requests.filter(item => item === '/destination?case=' + target).length > before, name + ' native form submission');
      check(true, name + ': native forms remain usable without sourceElement');
    }
    await open('legacyScript');
    await browser.evaluate('delete NavigateEvent.prototype.sourceElement', page); await click('assign');
    await until(() => evidence.navigations.some(item => item.test === 'legacyScript'), 'legacy script navigation');
    check(!loaded('assign') && evidence.navigations.some(item => item.test === 'legacyScript' && item.prevented), 'script-only redirects remain blocked without sourceElement');
    await open('hash'); await click('hashLink');
    check(await browser.evaluate('location.hash==="#chapter"', page), 'same-document hash navigation works');
    await click('history'); check(await browser.evaluate('location.hash==="#route"', page), 'same-document history routing works');
    await browser.send('Page.reload', {}, page);
    await until(() => browser.evaluate('window.ready===true && location.hash==="#route"', page), 'reload'); check(true, 'reload remains usable');
    await browser.navigate(page, 'http://localhost:' + port + '/destination?case=browser');
    await until(() => loaded('browser'), 'browser navigation');
    await committed('location.hostname==="localhost" && location.search==="?case=browser"');
    check(true, 'browser-initiated navigation can leave the protected page');
    const history = await browser.send('Page.getNavigationHistory', {}, page);
    await browser.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex - 1].id }, page);
    await committed('location.pathname==="/player"'); check(true, 'browser Back can return to the player');
    await browser.send('Page.navigateToHistoryEntry', { entryId: history.entries[history.currentIndex].id }, page);
    await committed('location.hostname==="localhost"'); check(true, 'browser Forward can leave the player');
    await open('frame');
    await browser.send('Target.activateTarget', { targetId: page.id });
    const frameBox = await browser.evaluate('(async()=>{const f=document.getElementById("frame");f.scrollIntoView({block:"center",behavior:"instant"});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=f.getBoundingClientRect();return {x:r.x+f.clientLeft,y:r.y+f.clientTop}})()', page);
    await browser.clickAt(frameBox.x + 90, frameBox.y + 22, page);
    await until(() => evidence.navigations.some(item => item.frameClick && item.trusted), 'native click delivered to the embedded frame');
    check(true, 'the frame-takeover probe received a real trusted click');
    await until(() => loaded('frame') || evidence.navigations.some(item => item.test === 'frame'), 'child-frame top navigation');
    check(!loaded('frame') && evidence.navigations.some(item => item.test === 'frame' && item.blocked), 'the browser sandbox denies a cross-origin frame takeover before any destination request');
    await open('httpRedirect');
    await browser.evaluate('(document.getElementById("video").play(),location.assign("/redirect"))', page);
    await until(() => evidence.navigations.some(item => item.test === 'httpRedirect'), 'local HTTP redirect first-hop probe');
    check(!evidence.requests.includes('/redirect') && !loaded('httpRedirect') && evidence.navigations.some(item => item.test === 'httpRedirect' && item.prevented), 'the server-redirect chain is stopped before its first request');
    check(await browser.evaluate('location.pathname==="/player" && !document.getElementById("video").paused', page), 'the server redirect leaves the video document playing');
    await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: true });
    await open('paused'); await click('assign'); await until(() => loaded('assign'), 'site pause'); check(true, 'site pause stops installing the redirect guard');
    await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: false });
    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
    await open('master-off'); await click('replace'); await until(() => loaded('replace'), 'master off'); check(true, 'master pause stops installing the redirect guard');
    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } });
    await send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: false });
    await open('disabled'); await click('timer'); await until(() => loaded('timer'), 'guard disabled'); check(true, 'turning off the per-site guard and loading a new page restores scripted navigation');
    await send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: true });
    await open('ui');
    await browser.send('Page.reload', {}, browser.popup);
    await until(() => browser.evaluate('document.getElementById("togglePopups")?.checked && !document.getElementById("togglePopups").disabled'), 'popup selected-site state');
    check(await browser.evaluate('document.getElementById("togglePopups").getAttribute("aria-label").includes("redirects")'), 'the existing per-site switch clearly includes redirect protection');
    await browser.screenshot(path.join(temp, 'popup.png'));
    const listPage = await browser.open('chrome-extension://' + browser.id + '/src/ui/lists/lists.html#listPopups');
    for (const width of [1100, 390]) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false }, listPage);
      await browser.evaluate('document.getElementById("listPopups").scrollIntoView()', listPage);
      const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, listPage);
      await fs.writeFile(path.join(temp, 'lists-' + width + '.png'), Buffer.from(shot.data, 'base64'));
      check(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth', listPage), 'the updated site list has no horizontal overflow at ' + width + 'px');
    }
    evidence.success = true;
  } catch (error) {
    evidence.success = false; evidence.error = error.stack; process.exitCode = 1;
    if (browser) {
      evidence.exceptions = browser.events.filter(event => event.method === 'Runtime.exceptionThrown');
      if (page) {
        const result = await Promise.allSettled([browser.evaluate('({url:location.href,ready:window.ready,attempts:window.attempts,navigations:window.navEvents})', page)]);
        evidence.failedPage = result[0];
        const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
        await fs.writeFile(path.join(temp, 'failure.png'), Buffer.from(shot.data, 'base64'));
      }
    }
  }
  finally {
    if (browser) { evidence.cleanup = await browser.close(); if (!evidence.cleanup.closed) { evidence.success = false; process.exitCode = 1; } }
    fixture.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => fixture.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, success: evidence.success, checks: evidence.checks.length, evidence: path.join(temp, 'evidence.json'), error: evidence.error }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
