/* Native blocked-tab cleanup: installed browsers, disposable profiles, loopback only. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium, firefox } = require('./browser-smoke.cjs');
const root = path.resolve(__dirname, '..'), browserName = process.argv[2] || 'chrome';
if (!['chrome', 'edge', 'firefox'].includes(browserName)) throw new Error('Choose chrome, edge or firefox.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const files = ['manifest.json','shared.js','flags.js','cosmetic.js','network.js','evidence.js','procedural.js', 'reddit.js','picker-core.js','picker.js',
  'background.js','content.js','youtube.js','popups.js','popup.js','popup.html','popup.css','ui.css','log.html','log.js','log.css',
  'lists.html','lists.js','modules.js','userscripts-core.js', 'userscripts-network.js', 'userscripts-offscreen.js', 'userscripts-xhr.js','clipboard.html', 'clipboard.js', 'userscripts-actions.js', 'userscripts-runtime.js','manager.html','manager.js', 'userscripts-editor.js', 'userscripts-editor-worker.js', 'userscripts-lint.js', 'vendor/acorn/acorn.js', 'vendor/acorn/LICENSE','manager.css','rules','icons'];
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'blockads-tabs-' + browserName + '-'));
  const extension = path.join(temp, 'extension'); await fs.mkdir(extension);
  for (const file of files) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const evidence = { browser: browserName, temp, started: new Date().toISOString(), checks: [], requests: [], deniedRequests: 0, proxyErrors: [], hashes: {} };
  for (const file of files.filter(file => !['rules', 'icons'].includes(file))) evidence.hashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  const proxy = http.createServer((_request, response) => { evidence.deniedRequests++; response.writeHead(403); response.end('Offline test'); });
  proxy.on('connect', (_request, socket) => {
    socket.on('error', error => { if (!['ECONNRESET','EPIPE'].includes(error.code)) evidence.proxyErrors.push(error.message); });
    evidence.deniedRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  let port;
  const fixture = http.createServer((request, response) => {
    evidence.requests.push(request.url);
    if (request.url === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (request.url === '/network-error') { request.socket.destroy(); return; }
    if (request.url.startsWith('/cancel-') || request.url === '/blocked-static-allow') return; // Owned stalled navigation, cancelled by the test.
    if (request.url === '/redirect') { response.writeHead(302, { Location: 'http://localhost:' + port + '/blocked-redirect' }); response.end(); return; }
    if (request.url === '/redirect-exempt') { response.writeHead(302, { Location: 'http://localhost:' + port + '/cancel-after-allowed-redirect' }); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><title>Owned blocked-tab fixture</title><body><p>Owned offline page</p><button id="launch">Open owned popup</button><input id="kept" value="keep this work">' +
      (request.url === '/subresource' ? '<img src="http://localhost:' + port + '/blocked-image">' : '') + '</body>');
  });
  await Promise.all([new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))]);
  port = fixture.address().port;
  // This single canary is added ONLY to the disposable package. It exercises a
  // real static block event without navigating to any domain in the real lists.
  const communityFile = path.join(extension, 'rules/community.json');
  const community = JSON.parse(await fs.readFile(communityFile, 'utf8'));
  evidence.fixtureRule = { id: Math.max(...community.map(rule => rule.id)) + 1, priority: 1, action: { type: 'block' },
    condition: { urlFilter: '|http://127.0.0.1:' + port + '/blocked-static', resourceTypes: ['main_frame'] } };
  evidence.fixtureAllow = { id: evidence.fixtureRule.id + 1, priority: 2, action: { type: 'allow' },
    condition: { urlFilter: '|http://127.0.0.1:' + port + '/blocked-static-allow|', resourceTypes: ['main_frame'] } };
  community.push(evidence.fixtureRule, evidence.fixtureAllow); await fs.writeFile(communityFile, JSON.stringify(community));
  evidence.fixtureRulesHash = createHash('sha256').update(await fs.readFile(communityFile)).digest('hex');
  let browser, source;
  const check = (condition, description) => { assert.ok(condition, description); evidence.checks.push(description); };
  const evaluate = expression => browser.evaluate(expression);
  const api = '(globalThis.browser||chrome)';
  const send = message => evaluate(api + '.runtime.sendMessage(' + JSON.stringify(message) + ')');
  const until = async (expression, description) => {
    for (let i = 0; i < 120; i++) { const result = await evaluate(expression); if (result) return result; await pause(50); }
    throw new Error('Timed out: ' + description);
  };
  const exists = id => evaluate(api + '.tabs.get(' + id + ').then(()=>true,()=>false)');
  const failed = id => until('cleanupEvents.some(e=>e.kind==="error"&&e.data.tabId===' + id + ')', 'native navigation failure for tab ' + id);
  const spawn = async url => {
    const offset = await evaluate('cleanupEvents.length');
    if (browserName === 'firefox') {
      await browser.evaluate('(document.getElementById("launch").onclick=()=>{globalThis.lastTestPopup=window.open(' + JSON.stringify(url) + ',"_blank");},true)', source);
      const point = await browser.evaluate('(r=>({x:r.x+r.width/2,y:r.y+r.height/2}))(document.getElementById("launch").getBoundingClientRect())', source);
      await browser.clickAt(point.x, point.y, source);
    } else await browser.send('Runtime.evaluate', { expression: 'globalThis.lastTestPopup=window.open(' + JSON.stringify(url) + ',"_blank");true', userGesture: true, returnByValue: true }, source);
    return until('cleanupEvents.slice(' + offset + ').find(e=>e.kind==="created")?.data.id', 'new popup tab');
  };
  const navigatePopup = url => browser.evaluate('lastTestPopup.location=' + JSON.stringify(url), source);
  try {
    browser = browserName === 'firefox'
      ? await firefox(extension, path.join(temp, 'profile'), proxy.address().port, { ruleFeedback: false })
      : await chromium(extension, path.join(temp, 'profile'), proxy.address().port);
    evidence.version = browser.version;
    if (browserName === 'firefox') {
      evidence.feedback = await evaluate(`(async()=>{const dnr=${api}.declarativeNetRequest;
        try { await dnr.testMatchOutcome({url:'http://localhost:${port}/unused',type:'main_frame'}); return {enabled:true}; }
        catch(error) { return {enabled:false,error:error.message,debugEvent:typeof dnr.onRuleMatchedDebug}; }
      })()`);
      check(evidence.feedback.enabled === false && evidence.feedback.debugEvent === 'undefined' && /extensions.dnr.feedback/.test(evidence.feedback.error),
        'Firefox cleanup runs with rule-feedback debugging disabled and no match event');
    }
    check((await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'localhost' })).ok, 'owned localhost destination is blocked');
    await evaluate(`(()=>{const api=${api};globalThis.cleanupEvents=[];const record=(kind,data)=>cleanupEvents.push({kind,data});
      api.tabs.onCreated.addListener(tab=>record('created',{id:tab.id,opener:tab.openerTabId,url:tab.url}));
      api.tabs.onRemoved.addListener(id=>record('removed',id));
      api.webRequest.onErrorOccurred.addListener(details=>record('error',details),{urls:['<all_urls>'],types:['main_frame']});
      api.declarativeNetRequest.onRuleMatchedDebug?.addListener(details=>record('match',details));
    })()`);
    source = await browser.open('http://127.0.0.1:' + port + '/source');
    const sourceTab = await until(api + '.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===' + JSON.stringify('http://127.0.0.1:' + port + '/source') + ')?.id)', 'source tab has loaded');
    const blank = await evaluate(api + '.tabs.create({url:"about:blank",active:false}).then(tab=>tab.id)');
    for (const [name, url] of [
      ['dynamic', 'http://localhost:' + port + '/blocked-dynamic'],
      ['static', 'http://127.0.0.1:' + port + '/blocked-static'],
      ['redirect', 'http://127.0.0.1:' + port + '/redirect']
    ]) {
      const id = await spawn(url);
      await until('cleanupEvents.some(e=>e.kind==="removed"&&e.data===' + id + ')', name + ' blocked popup removed');
      check(!(await exists(id)), name + ' blocked popup is automatically closed');
      check(await exists(sourceTab) && await exists(blank), name + ' cleanup preserves the opener and unrelated blank tab');
    }
    const blankFirst = await spawn('about:blank');
    await navigatePopup('http://localhost:' + port + '/blocked-after-blank');
    await until('cleanupEvents.some(e=>e.kind==="removed"&&e.data===' + blankFirst + ')', 'blank-first popup removed');
    check(!(await exists(blankFirst)), 'initial about:blank popup closes after its first blocked navigation');

    const pinned = await spawn('about:blank');
    await evaluate(api + '.tabs.update(' + pinned + ',{pinned:true})');
    await navigatePopup('http://localhost:' + port + '/blocked-pinned'); await failed(pinned);
    check(await exists(pinned), 'a pinned popup tab is preserved');

    const loaded = await spawn('http://127.0.0.1:' + port + '/loaded');
    await until(api + '.tabs.get(' + loaded + ').then(tab=>tab.status==="complete"&&tab.url?.endsWith("/loaded"))', 'loaded popup page');
    await navigatePopup('http://localhost:' + port + '/blocked-later'); await failed(loaded);
    check(await exists(loaded), 'a tab with a previously loaded page is preserved after a later block');

    await evaluate(api + '.tabs.update(' + blank + ',{url:' + JSON.stringify('http://localhost:' + port + '/blocked-manual') + '})'); await failed(blank);
    check(await exists(blank), 'a manually created tab without an opener is preserved');

    const error = await spawn('http://127.0.0.1:' + port + '/network-error'); await failed(error);
    check(await exists(error), 'ordinary network errors never authorize closing a tab');

    const image = await spawn('http://127.0.0.1:' + port + '/subresource');
    await until(api + '.tabs.get(' + image + ').then(tab=>tab.status==="complete")', 'subresource fixture load');
    check(await exists(image), 'a blocked image does not close its containing page');

    const preserved = [pinned, loaded, blank, error, image];
    const cancelPopup = async (host, route, description) => {
      const id = await spawn('http://' + host + ':' + port + route);
      for (let i = 0; !evidence.requests.includes(route) && i < 120; i++) await pause(50);
      check(evidence.requests.includes(route), description + ' reaches only the owned fixture');
      await browser.evaluate('(lastTestPopup.stop(),true)', source); await failed(id);
      preserved.push(id);
    };
    await cancelPopup('127.0.0.1', '/blocked-static-allow', 'higher-priority static exception');
    await cancelPopup('127.0.0.1', '/cancel-unblocked', 'unblocked navigation');
    if (browserName === 'firefox') {
      check((await send({ type: 'UPDATE_SETTINGS', patch: { whitelistedDomains: ['127.0.0.1'] } })).ok, 'an exception on the first redirect hop is applied');
      const redirected = await spawn('http://127.0.0.1:' + port + '/redirect-exempt');
      for (let i = 0; i < 120; i++) {
        if (evidence.requests.includes('/cancel-after-allowed-redirect') || await evaluate('cleanupEvents.some(e=>e.kind==="error"&&e.data.tabId===' + redirected + ')')) break;
        await pause(50);
      }
      if (evidence.requests.includes('/cancel-after-allowed-redirect')) await browser.evaluate('(lastTestPopup.stop(),true)', source);
      await failed(redirected); await pause(500);
      check(await exists(redirected), 'Firefox preserves a redirect with a possible inherited exception');
      preserved.push(redirected);
    }
    check((await send({ type: 'UPDATE_SETTINGS', patch: { whitelistedDomains: ['localhost'] } })).ok, 'site exception is applied');
    await cancelPopup('localhost', '/cancel-site-exception', 'site exception overriding a custom block');
    check((await send({ type: 'UPDATE_SETTINGS', patch: { whitelistedDomains: [], enabled: false } })).ok, 'global pause is applied');
    await cancelPopup('localhost', '/cancel-paused', 'globally paused protection');
    // Let the final asynchronous policy reads finish before checking preservation;
    // the deterministic unit suite separately holds and releases these reads.
    await pause(500);
    check((await Promise.all(preserved.map(exists))).every(Boolean), 'all loaded, pinned, manual, error, allowed and cancelled tabs remain open');
    check((await send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } })).ok, 'protection is restored after pause');

    const log = await send({ type: 'GET_LOG' });
    const closures = log.entries.filter(entry => entry.message === 'Closed a new pop-up tab after blocking its destination');
    check(closures.length === 4, 'only the four confirmed initial blocked popups produce cleanup log entries');
    check(!evidence.requests.some(url => url.startsWith('/blocked-') && url !== '/blocked-static-allow'), 'no blocked fixture destination reached the local server');
    check((await send({ type: 'GET_STATE' })).ok, 'ad protection remains verified after cleanup');
    check(evidence.proxyErrors.length === 0, 'deny proxy reports no unexpected errors');
    evidence.events = await evaluate('cleanupEvents');
    evidence.success = true;
  } catch (error) {
    evidence.success = false; evidence.error = error.stack; process.exitCode = 1;
    if (browser) {
      evidence.events = await evaluate('globalThis.cleanupEvents').catch(() => null);
      evidence.tabs = await evaluate(api + '.tabs.query({})').catch(() => null);
      evidence.log = await send({ type: 'GET_LOG' }).catch(() => null);
    }
  } finally {
    if (browser) {
      try {
        evidence.cleanup = await browser.close();
        if (evidence.cleanup?.closed === false) throw new Error('Disposable browser did not close.');
      } catch (error) {
        evidence.success = false; evidence.cleanupError = error.stack; process.exitCode = 1;
      }
    }
    fixture.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolve => fixture.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    evidence.finished = new Date().toISOString();
    await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, success: evidence.success, checks: evidence.checks.length, error: evidence.error, evidence: path.join(temp, 'evidence.json') }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
