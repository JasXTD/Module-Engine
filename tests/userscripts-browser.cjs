/* Offline manager and native userScripts checks; installed browsers, fresh profiles. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { chromium } = require('./browser-smoke.cjs');
const { runCompatibility, files, scriptSource } = require('./userscripts-compatibility.cjs');
const { fixtureHandler } = require('./userscripts-network-fixtures.cjs');
const { runAssetsAndNetwork } = require('./userscripts-assets-network.cjs');
const { executionFixture, runExecution } = require('./userscripts-execution-browser.cjs');
const { pageFixture, runPage } = require('./userscripts-page-browser.cjs');
const root = path.resolve(__dirname, '..'), browserName = process.argv[2] || 'chrome';
if (!['chrome', 'edge'].includes(browserName)) throw new Error('Choose chrome or edge; this harness tests the Chromium userscript permission UI.');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Bounded, offline-only pressure. The existing document intentionally keeps
// running until stopped, so shutdown is checked while requests are still sent.
function gmFloodFixture() {
  let pending = 0, attempted = 0, limited = 0, active = true;
  const deadline = Date.now() + 15000;
  const report = () => {
    document.body.dataset.gmFloodActive = String(active);
    document.body.dataset.gmFloodAttempted = String(attempted);
    document.body.dataset.gmFloodLimited = String(limited);
  };
  const stop = () => { active = false; clearInterval(timer); report(); };
  const wave = () => {
    if (Date.now() >= deadline) { stop(); return; }
    for (let i = 0; i < 128 && pending < 128; i++) {
      pending++; attempted++;
      Promise.resolve().then(() => GM.getValue('offline-pressure', null)).catch(error => {
        if (error.message.includes('pending GM storage')) limited++;
      }).finally(() => { pending--; });
    }
    report();
  };
  const timer = setInterval(wave, 50);
  document.addEventListener('stop-gm-flood', stop, { once: true });
  document.addEventListener('probe-revoked-gm', () => {
    Promise.resolve().then(() => GM.getValue('offline-probe')).then(
      () => { document.body.dataset.gmFloodProbe = 'accepted'; },
      () => { document.body.dataset.gmFloodProbe = 'rejected'; });
  }, { once: true });
  wave();
}
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'blockads-userscripts-' + browserName + '-')), extension = path.join(temp, 'extension');
  await fs.mkdir(extension);
  for (const file of files) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const evidence = { browser: browserName, temp, started: new Date().toISOString(), checks: [], hashes: {}, deniedRequests: 0, proxyErrors: [] };
  for (const file of files) evidence.hashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  if (!['--network-log-only', '--layout-only', '--editor-only', '--install-only', '--matching-only', '--execution-only', '--mcp-only', '--page-only'].some(flag => process.argv.includes(flag))) await require('./userscripts-desktop-browser.cjs').installClipboardSink(extension, evidence);
  const aliasState = {};
  const { forwardMatching, runMatching } = require('./userscripts-matching-browser.cjs');
  const proxy = http.createServer((request, response) => { if (forwardMatching(request, response, aliasState, evidence)) return; evidence.deniedRequests++; response.writeHead(403); response.end('Offline test'); });
  proxy.on('connect', (_request, socket) => {
    socket.on('error', error => { if (!['ECONNRESET', 'EPIPE'].includes(error.code)) evidence.proxyErrors.push(error.message); });
    evidence.deniedRequests++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  const fixtureState = { hits: [], aborted: 0 }, route = fixtureHandler(fixtureState);
  const secondOrigin = http.createServer((request, response) => { if (!route(request, response)) { response.writeHead(404); response.end(); } });
  await new Promise(resolve => secondOrigin.listen(0, '127.0.0.1', resolve));
  let port;
  const fixtures = http.createServer((request, response) => {
    if (require('./network-log-browser.cjs').networkLogFixture(request, response, fixtureState)) return;
    if (pageFixture(request, response)) return;
    if (executionFixture(request, response)) return;
    if (route(request, response)) return;
    if (request.url === '/ad.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end('window.fixtureAd=true;'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><script>window.startObserved=document.documentElement.dataset.startMarker;window.pageErrors=[];addEventListener("error",e=>pageErrors.push(String(e.message)));</script></head><body><h1>Owned offline fixture</h1>' +
      '<script src="http://localhost:' + port + '/ad.js"></script>' + (request.url === '/frames' ? '<iframe src="/child"></iframe>' : request.url === '/compat/frames' ? '<iframe src="/compat/child"></iframe>' : '') + '</body></html>');
  });
  await Promise.all([new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => fixtures.listen(0, '127.0.0.1', resolve))]);
  port = fixtures.address().port;
  let b, manager, details;
  const check = (name, result) => { assert.ok(result, name); evidence.checks.push(name); };
  const until = async (expression, target = manager) => {
    let value;
    for (let i = 0; i < 160; i++) { value = await b.evaluate(expression, target); if (value) return value; await pause(50); }
    throw new Error('Timed out: ' + expression + '\nManager: ' + await b.evaluate("document.querySelector('#status')?.textContent", manager));
  };
  const send = message => b.evaluate('(globalThis.browser || chrome).runtime.sendMessage(' + JSON.stringify(message) + ')', manager);
  // The manager disables its controls for a moment while it refreshes after a storage
  // change, and input landing in that moment is lost: a disabled button gets no click
  // event and a disabled editor takes no text. Confirm that the input arrived and try
  // again, as a person would. Retries are recorded so lost input stays visible.
  const click = async (id, target = manager) => {
    await b.front(target);
    const locator = 'document.getElementById(' + JSON.stringify(id) + ')';
    for (let attempt = 1; attempt <= 5; attempt++) {
      await until('(()=>{const e=' + locator + ';return e&&!e.disabled&&e.getClientRects().length>0;})()', target);
      await b.evaluate(locator + '.scrollIntoView({block:"center",behavior:"instant"})', target);
      await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', target);
      // Measure, and arm a probe in the same step, so no extra round trip delays the press.
      // One probe at a time: an earlier probe whose click never came is removed first.
      const point = await until('(()=>{const e=' + locator + ';if(!e||e.disabled)return null;const r=e.getBoundingClientRect();const p={x:r.x+r.width/2,y:r.y+r.height/2};' +
        'if(!(r.width&&r.height&&e.contains(document.elementFromPoint(p.x,p.y))))return null;' +
        'globalThis.__clickProbe?.abort();const probe=new AbortController();globalThis.__clickProbe=probe;globalThis.__clickArrived=false;globalThis.__clickPressedDisabled=null;' +
        'addEventListener("pointerdown",event=>{if(e.contains(event.target))globalThis.__clickPressedDisabled=e.disabled;},{capture:true,signal:probe.signal});' +
        'addEventListener("click",event=>{if(e.contains(event.target)){globalThis.__clickArrived=true;probe.abort();}},{capture:true,signal:probe.signal});return p;})()', target);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent',
        { type, x: point.x, y: point.y, buttons: type === 'mousePressed' ? 1 : 0, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: type === 'mouseMoved' ? 0 : 1 }, target);
      // The click event is dispatched with the release; allow one frame before calling it lost.
      const result = await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve({arrived:globalThis.__clickArrived,pressedDisabled:globalThis.__clickPressedDisabled})))', target);
      if (result.arrived) return;
      (evidence.lostClicks ||= []).push({ id, attempt, disabledWhenPressed: result.pressedDisabled });
    }
    throw new Error('Pointer clicks never reached #' + id + '\nManager: ' + await b.evaluate("document.querySelector('#status')?.textContent", manager));
  };
  const ready = () => until("!document.getElementById('newScript').disabled");
  const setText = async text => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      await until("!document.getElementById('scriptSource').disabled");
      await b.evaluate("document.getElementById('scriptSource').focus();document.getElementById('scriptSource').select()", manager);
      await b.typeText(text, manager);
      if (await b.evaluate('document.getElementById("scriptSource").value === ' + JSON.stringify(text), manager)) return;
      (evidence.lostInput ||= []).push({ attempt });
    }
    throw new Error('Typing never reached the script editor\nManager: ' + await b.evaluate("document.querySelector('#status')?.textContent", manager));
  };
  const install = async source => {
    await ready(); await click('newScript'); await setText(source); await click('saveScript'); await ready();
    const library = await send({ type: 'US_LIST' });
    const name = /\/\/ @name (.*)/.exec(source)[1], script = library.scripts.find(item => item.metadata.name === name);
    check('Saved disabled: ' + name, script && !script.enabled && script.source === source);
    await click('scriptEnabled'); await ready();
    return script.id;
  };
  const browse = async pathname => b.open('http://127.0.0.1:' + port + pathname);
  try {
    await fs.mkdir(path.join(temp, 'exports'));
    b = await chromium(extension, path.join(temp, 'profile'), proxy.address().port, { headless: !process.argv.includes('--native-helper-prompt'), downloadDirectory: path.join(temp, 'exports') });
    evidence.version = b.version;
    manager = await b.open('chrome-extension://' + b.id + '/src/ui/manager/manager.html');
    await b.evaluate("globalThis.__moduleTestClicks=[];for(const type of ['pointerdown','pointerup','click'])document.addEventListener(type,event=>{globalThis.__moduleTestClicks.push({type,id:event.target.closest('button,input,a')?.id,trusted:event.isTrusted,discardDisabled:document.getElementById('discardDraft').disabled,dialog:document.getElementById('confirmDialog').open,scroll:scrollY});},true)", manager);
    await ready();
    check('Fresh manager keeps blocking on and userscripts off', await b.evaluate("document.getElementById('blockingEnabled').checked&&!document.getElementById('userscriptsEnabled').checked", manager));
    check('New permission has not been granted automatically', !(await b.evaluate("(globalThis.browser || chrome).permissions.contains({permissions:['userScripts']})", manager)));
    check('Optional permission UI is visible', await b.evaluate("!document.getElementById('grantAccess').hidden", manager));
    await click('grantAccess'); await ready();
    check('Native permission granted by manager button', await b.evaluate("(globalThis.browser || chrome).permissions.contains({permissions:['userScripts']})", manager));
    details = await b.open((browserName === 'edge' ? 'edge' : 'chrome') + '://extensions/?id=' + b.id);
    const toggleAccess = async () => {
      const accessExpression = "(async()=>{try{await (globalThis.browser||chrome).userScripts.getScripts();return true;}catch{return false;}})()";
      const wasAvailable = await b.evaluate(accessExpression, manager);
      if (browserName === 'edge' && evidence.permissionToggles?.length) {
        // Reopen the browser UI as the manager's details button does. Reusing
        // Edge's old details tab can show a changed switch without applying it.
        const previous = details;
        details = await b.open('edge://extensions/?id=' + b.id);
        await b.send('Target.closeTarget', { targetId: previous.id });
      }
      await b.send('Target.activateTarget', { targetId: details.id });
      await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', details);
      const expression = browserName === 'edge'
        ? "(()=>{function find(root,selector){const found=root.querySelector(selector);if(found)return found;for(const e of root.querySelectorAll('*')){if(e.shadowRoot){const result=find(e.shadowRoot,selector);if(result)return result;}}return null;}const section=find(document,'access-section');if(!section?.shadowRoot)return null;const row=[...section.shadowRoot.querySelectorAll('standard-row')].find(row=>row.querySelector('[slot=\"title\"]')?.textContent.trim()==='Allow User Scripts');const t=row?.querySelector('fluent-switch');if(!t)return null;t.scrollIntoView({block:'center',behavior:'instant'});const r=t.getBoundingClientRect();return r.width?{x:r.x+r.width/2,y:r.y+r.height/2,checked:t.checked}:null;})()"
        : "(()=>{const d=document.querySelector('extensions-manager')?.shadowRoot.querySelector('extensions-detail-view');const t=d?.shadowRoot.querySelector('#allow-user-scripts');if(!t)return null;t.scrollIntoView({block:'center',behavior:'instant'});const r=t.getBoundingClientRect();return {x:r.right-24,y:r.y+r.height/2};})()";
      const point = await until(expression, details);
      await b.clickAt(point.x, point.y, details);
      const toggle = { before: point, after: await b.evaluate(expression, details) };
      (evidence.permissionToggles ||= []).push(toggle);
      if (browserName === 'edge') await until('(point=>point&&point.checked!==' + JSON.stringify(point.checked) + ')(' + expression + ')', details);
      // Return to the extension as a user would. Edge can defer binding updates
      // while its extension renderer remains in a background tab.
      await b.send('Target.activateTarget', { targetId: manager.id });
      await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', manager);
      toggle.backgroundBeforeWait = await send({ type: 'US_LIST' });
      try { await until("(" + accessExpression + ").then(value=>value!==" + JSON.stringify(wasAvailable) + ")", manager); }
      catch (error) {
        await b.send('Target.activateTarget', { targetId: details.id });
        const shot = await b.send('Page.captureScreenshot', { format: 'png' }, details);
        await fs.writeFile(path.join(temp, 'native-permission.png'), Buffer.from(shot.data, 'base64'));
        toggle.nativeText = await b.evaluate("(()=>{function text(r){return r.textContent+[...r.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>text(e.shadowRoot)).join('\\n');}return text(document.body).slice(-14000);})()", details);
        toggle.backgroundAfterWait = await send({ type: 'US_LIST' });
        const probePage = await browse('/permission-probe');
        toggle.executedAfterToggle = await b.evaluate('({visits:document.body.dataset.visits,page:window.pageWorldRan,start:window.startObserved})', probePage);
        const fresh = await b.open('chrome-extension://' + b.id + '/src/ui/manager/manager.html');
        toggle.freshContextAccess = await b.evaluate(accessExpression, fresh);
        toggle.oldContextAfterFresh = await b.evaluate(accessExpression, manager);
        throw error;
      }
    };
    await toggleAccess(); await click('refresh'); await ready();
    check('Browser access recognized', (await send({ type: 'US_LIST' })).available);
    await click('userscriptsEnabled'); await ready();
    check('Userscript module is independently enabled', (await send({ type: 'US_LIST' })).enabled);
    check('Local ad canary saved to blocker', (await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'localhost' })).ok);
    if (process.argv.includes('--network-log-only')) {
      await require('./network-log-browser.cjs').runNetworkLog({ b, manager, send, check, until, browse, scriptSource, evidence, temp, port, fixtureState });
      evidence.success=true; evidence.focus='network-log-only'; return;
    }
    if (process.argv.includes('--layout-only')) {
      await require('./userscripts-layout-browser.cjs').runLayout({ b, manager, send, check, until, browse, scriptSource, evidence, temp, click, port, aliasState, fixtureState,
        base:'http://127.0.0.1:'+port, other:'http://127.0.0.1:'+secondOrigin.address().port });
      evidence.success=true; evidence.focus='layout-only'; return;
    }
    if (process.argv.includes('--page-only')) {
      await runPage({ b, manager, send, check, until, browse, scriptSource, evidence, temp, click });
      evidence.success = true; evidence.focus = 'page-only'; return;
    }
    if (process.argv.includes('--mcp-only')) {
      await require('./mcp-browser.cjs').runMCPTransports({ b, manager, send, check, until, browse, scriptSource, evidence, temp, fixtureState });
      check('Deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0);
      evidence.success = true; evidence.focus = 'mcp-only'; return;
    }
    if (!['--editor-only', '--install-only', '--desktop-only', '--matching-only'].some(flag => process.argv.includes(flag))) {
      await runExecution({ b, manager, send, check, until, browse, scriptSource, evidence, click, temp });
      check('Deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0);
      if (process.argv.includes('--execution-only')) { evidence.success = true; evidence.focus = 'execution-only'; return; }
    }
    if (!['--editor-only', '--install-only', '--desktop-only'].some(flag => process.argv.includes(flag))) {
      await runMatching({ b, manager, send, check, until, port, aliasState, evidence });
      check('Deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0);
      if (process.argv.includes('--matching-only')) { evidence.success = true; evidence.focus = 'matching-only'; return; }
    }
    if(!process.argv.includes('--desktop-only')&&!process.argv.includes('--install-only')) await require('./userscripts-editor-browser.cjs').runEditor({b,manager,send,check,until,browse,scriptSource,click,temp,evidence});
    if(process.argv.includes('--editor-only')) {
      evidence.extensionErrors=b.events.filter(event=>event.method==='Runtime.exceptionThrown');
      check('No uncaught editor errors',evidence.extensionErrors.length===0);
      check('Deny proxy has no unexpected socket errors',evidence.proxyErrors.length===0);
      evidence.success=true;evidence.focus='editor-only';return;
    }
    if (!process.argv.includes('--desktop-only')) await require('./userscripts-install-browser.cjs').runInstallation({ b, manager, send, check, until, browse, temp, evidence, fixtureState, base: 'http://127.0.0.1:' + port });
    if (process.argv.includes('--install-only')) { check('Deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0); evidence.success = true; evidence.focus = 'install-only'; return; }
    if(!process.argv.includes('--desktop-only')) {
      await runCompatibility({ b, manager, send, check, until, browse, scriptSource, temp, evidence });
      await require('./userscripts-helpers-browser.cjs').runHelpers({ b, manager, send, check, until, browse, scriptSource, evidence });
    }
    if (!process.argv.includes('--skip-desktop')) await require('./userscripts-desktop-browser.cjs').runDesktop({ b, manager, send, check, until, browse, scriptSource, evidence, temp, fixtureState, click, base: 'http://127.0.0.1:' + port });
    if(process.argv.includes('--desktop-only')) { evidence.success=true; evidence.focus='desktop-only'; return; }
    // Restore the older editor-export fixture's CDP output routing only after
    // native GM download naming/collision checks have completed with normal prefs.
    await b.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: path.join(temp, 'exports'), eventsEnabled: true });
    await runAssetsAndNetwork({ b, manager, send, check, until, browse, scriptSource, temp, evidence, fixtureState,
      base: 'http://127.0.0.1:' + port, other: 'http://127.0.0.1:' + secondOrigin.address().port });
    for (const action of ['module', 'script', 'delete']) {
      const pathname = '/gm-flood-' + action;
      const floodSource = scriptSource('Offline GM flood: ' + action, '// @grant GM.getValue\n',
        '(' + gmFloodFixture.toString() + ')();', '// @noframes\n')
        .replace('// @match http://127.0.0.1/*', '// @match http://127.0.0.1' + pathname);
      const id = await install(floodSource), page = await browse(pathname);
      await until("Number(document.body.dataset.gmFloodAttempted)>=128&&Number(document.body.dataset.gmFloodLimited)>0", page);
      check('GM backpressure is active during ' + action + ' flood', await b.evaluate("document.body.dataset.gmFloodActive==='true'", page));
      const status = await send({ type: 'US_LIST' });
      check('Status remains available during ' + action + ' flood', status.ok && status.active && status.scripts.some(script => script.id === id));
      const started = Date.now();
      if (action === 'module') await click('userscriptsEnabled');
      else if (action === 'script') await click('scriptEnabled');
      else { await click('deleteScript'); await click('confirmAccept'); }
      await ready();
      const result = await send({ type: 'US_LIST' }), saved = result.scripts.find(script => script.id === id);
      const traffic = await b.evaluate('({active:document.body.dataset.gmFloodActive,attempted:Number(document.body.dataset.gmFloodAttempted),limited:Number(document.body.dataset.gmFloodLimited)})', page);
      (evidence.floodControls ||= []).push({ action, durationMs: Date.now() - started, ...traffic });
      check('Manager completes ' + action + ' shutdown during ongoing GM traffic',
        traffic.active === 'true' && (action === 'module' ? !result.enabled : action === 'script' ? saved?.enabled === false : !saved));
      await b.evaluate("document.dispatchEvent(new Event('stop-gm-flood'));document.dispatchEvent(new Event('probe-revoked-gm'))", page);
      await until('document.body.dataset.gmFloodProbe', page);
      check('Old GM capability is rejected after ' + action + ' shutdown', await b.evaluate("document.body.dataset.gmFloodProbe==='rejected'", page));
      check('Ad blocking survives ' + action + ' flood shutdown', (await send({ type: 'GET_STATE' })).settings.enabled &&
        await b.evaluate('window.fixtureAd===undefined', page));
      await b.closePage(page);
      if (saved) assert.ok((await send({ type: 'US_DELETE', id, revision: saved.revision })).ok);
      await click('refresh'); await ready();
      if (action === 'module') { await click('userscriptsEnabled'); await ready(); }
    }
    const firstSource = scriptSource('Storage and styles',
      '// @grant GM.getValue\n// @grant GM.setValue\n// @grant GM.addStyle\n',
      "(async()=>{const count=await GM.getValue('visits',0);await GM.setValue('visits',count+1);document.body.dataset.visits=String(count+1);GM.addStyle('body{--userscript-style:yes}');window.privateMarker='secret';document.body.dataset.extensionStorage=typeof (globalThis.browser||chrome).storage;const attack=await (globalThis.browser||chrome).runtime.sendMessage({type:'MODULE_SET',id:'blocking',enabled:false});document.body.dataset.attackRejected=String(attack.ok===false);try{await GM.setValue('invalid',NaN);}catch{document.body.dataset.invalidRejected='yes';}document.addEventListener('test-old-capability',()=>GM.setValue('old',true).then(()=>{document.body.dataset.oldCapability='accepted'},()=>{document.body.dataset.oldCapability='denied'}));})().catch(error=>{document.body.dataset.scriptError=error.message;});",
      '// @exclude-match http://127.0.0.1/excluded*\n// @noframes\n');
    const firstId = await install(firstSource);
    let fixture = await browse('/first');
    await until("document.body.dataset.visits || document.body.dataset.scriptError", fixture);
    check('Native userscript executes with persistent GM values', await b.evaluate("document.body.dataset.visits==='1'&&!document.body.dataset.scriptError", fixture));
    await until("document.body.dataset.invalidRejected", fixture);
    check('Style API runs in an isolated script world', await b.evaluate("getComputedStyle(document.body).getPropertyValue('--userscript-style').trim()==='yes'&&window.privateMarker===undefined", fixture));
    check('Script has no extension storage API', await b.evaluate("document.body.dataset.extensionStorage==='undefined'", fixture));
    check('Userscript messages cannot change modules', await b.evaluate("document.body.dataset.attackRejected==='true'", fixture));
    check('Invalid values are rejected before JSON transport coercion', await b.evaluate("document.body.dataset.invalidRejected==='yes'", fixture));
    check('Real loopback ad remains blocked while userscripts run', await b.evaluate("window.fixtureAd===undefined", fixture));
    const downloadEventsStart = b.events.length, exportName = 'Storage-and-styles.user.js';
    await click('exportScript');
    // An unrelated file or a .crdownload is not a completed export. Match its
    // native download ID, then verify the exact saved bytes below.
    for (let i = 0; i < 200; i++) {
      const events = b.events.slice(downloadEventsStart);
      const download = events.find(event => event.method === 'Browser.downloadWillBegin' && event.params.suggestedFilename === exportName)?.params;
      const progress = download && events.findLast(event => event.method === 'Browser.downloadProgress' && event.params.guid === download.guid)?.params;
      evidence.exportDownload = { filename: exportName, guid: download?.guid, state: progress?.state, receivedBytes: progress?.receivedBytes };
      if (progress?.state === 'completed' || progress?.state === 'canceled') break;
      await pause(50);
    }
    assert.equal(evidence.exportDownload.state, 'completed', 'Native export did not complete: ' + JSON.stringify(evidence.exportDownload));
    check('Export preserves the exact source', await fs.readFile(path.join(temp, 'exports', exportName), 'utf8') === firstSource);
    const secondSource = scriptSource('Separate storage', '// @grant GM.getValue\n',
      "GM.getValue('visits','private').then(value=>document.body.dataset.secondValue=String(value));", '// @noframes\n');
    const importPath = path.join(temp, 'import.user.js'); await fs.writeFile(importPath, secondSource);
    const { root: documentNode } = await b.send('DOM.getDocument', {}, manager);
    const { nodeId } = await b.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#scriptFile' }, manager);
    await b.send('DOM.setFileInputFiles', { nodeId, files: [importPath] }, manager);
    await until("document.getElementById('scriptSource').value.includes('@name Separate storage')");
    check('File import remains a reviewable unsaved draft', (await send({ type: 'US_LIST' })).scripts.length === 1);
    await click('saveScript'); await ready(); await click('scriptEnabled'); await ready();
    fixture = await browse('/two');
    await until("document.body.dataset.secondValue", fixture);
    check('Another script cannot read the first script’s values', await b.evaluate("document.body.dataset.secondValue==='private'", fixture));
    await until("document.body.dataset.visits", fixture);
    check('Values survive page navigation', Number(await b.evaluate('document.body.dataset.visits', fixture)) >= 2);
    const excluded = await browse('/excluded');
    check('Excluded URL never receives the first script', await b.evaluate("!document.body.dataset.visits", excluded));
    const frames = await browse('/frames');
    await until("document.body.dataset.visits", frames);
    check('@noframes prevents execution in matching child frames', await b.evaluate("!document.querySelector('iframe').contentDocument.body.dataset.visits", frames));
    await install(scriptSource('Page script', '// @grant none\n', "window.pageWorldRan=true;", '// @inject-into page\n'));
    const pageWorld = await browse('/page-world'); check('Explicit page-world mode works without privileged helpers', await b.evaluate("window.pageWorldRan===true", pageWorld));
    await install(scriptSource('Early script', '// @grant none\n', "document.documentElement.dataset.startMarker='early';", '// @run-at document-start\n// @noframes\n'));
    const early = await browse('/early'); check('document-start runs before fixture page JavaScript', await b.evaluate("window.startObserved==='early'", early));
    await click('blockingEnabled'); await ready();
    const unblocked = await browse('/blocking-off'); await until("document.body.dataset.visits", unblocked);
    check('Pausing ad blocking keeps userscripts active', await b.evaluate("window.fixtureAd===true&&Number(document.body.dataset.visits)>0", unblocked));
    await click('blockingEnabled'); await ready();
    await click('userscriptsEnabled'); await ready();
    const paused = await browse('/scripts-off');
    check('Pausing userscripts retains actual network blocking', await b.evaluate("!document.body.dataset.visits&&window.fixtureAd===undefined&&!window.pageWorldRan", paused));
    await b.evaluate("document.dispatchEvent(new Event('test-old-capability'))", fixture);
    await until("document.body.dataset.oldCapability", fixture);
    check('Previously running scripts lose storage authority when disabled', await b.evaluate("document.body.dataset.oldCapability==='denied'", fixture));
    await click('userscriptsEnabled'); await ready();
    await b.evaluate("delete document.body.dataset.oldCapability;document.dispatchEvent(new Event('test-old-capability'))", fixture);
    await until("document.body.dataset.oldCapability", fixture);
    check('Re-enabling does not revive old document capabilities', await b.evaluate("document.body.dataset.oldCapability==='denied'", fixture));
    await toggleAccess(); await click('refresh'); await ready();
    const unavailable = await send({ type: 'US_LIST' });
    check('Native browser revocation is reported honestly', !unavailable.available && !unavailable.active);
    check('Native browser revocation leaves blocker functioning', (await send({ type: 'GET_STATE' })).settings.enabled);
    await click('userscriptsEnabled'); await ready();
    check('Module can be paused after native access is revoked', !(await send({ type: 'US_LIST' })).enabled);
    await toggleAccess(); await click('refresh'); await ready();
    check('Native access can recover without losing library', (await send({ type: 'US_LIST' })).scripts.length === 4);
    await click('userscriptsEnabled'); await ready();
    // Restart this extension's worker without reloading the temporary installation.
    // Chrome's OFFSTORE guard can disable CDP-loaded unpacked extensions on reload.
    await b.send('ServiceWorker.enable', {}, manager);
    let version;
    for (let i = 0; i < 100 && !version; i++) {
      version = b.events.filter(event => event.method === 'ServiceWorker.workerVersionUpdated')
        .flatMap(event => event.params.versions).find(item => item.scriptURL === 'chrome-extension://' + b.id + '/src/background/background.js' && item.runningStatus === 'running');
      if (!version) await pause(50);
    }
    assert.ok(version, 'Identify the owned extension worker');
    const eventOffset = b.events.length;
    await b.send('ServiceWorker.stopWorker', { versionId: version.versionId }, manager);
    let stopped;
    for (let i = 0; i < 200 && !stopped; i++) {
      stopped = b.events.slice(eventOffset).some(event => event.method === 'ServiceWorker.workerVersionUpdated' &&
        event.params.versions.some(item => item.versionId === version.versionId && item.runningStatus === 'stopped'));
      if (!stopped) await pause(50);
    }
    evidence.workerLifecycle = b.events.slice(eventOffset).filter(event => event.method === 'ServiceWorker.workerVersionUpdated')
      .flatMap(event => event.params.versions.map(item => ({versionId:item.versionId,runningStatus:item.runningStatus})));
    assert.ok(stopped, 'Native service worker reports stopped before restart');
    const restored = await send({ type: 'US_LIST' });
    check('A restarted service worker restores enabled scripts and module intent', restored.active && restored.scripts.length === 4 && restored.scripts.every(script => script.enabled));
    const restarted = await browse('/restarted'); await until("document.body.dataset.visits", restarted);
    check('Storage and execution survive worker restart', Number(await b.evaluate('document.body.dataset.visits', restarted)) > 2);
    // Open a saved record using native input, then keep a draft while another editor saves.
    await b.evaluate('document.querySelector(' + JSON.stringify('button[data-id="' + firstId + '"]') + ').id="selectFirst"', manager);
    await click('selectFirst'); await setText(firstSource + '\n// local draft');
    const current = (await send({ type: 'US_LIST' })).scripts.find(script => script.id === firstId);
    check('Another editor can save while this draft stays open', (await send({ type: 'US_SAVE', id: firstId, revision: current.revision, source: firstSource + '\n// newer saved source' })).ok);
    await ready(); await click('saveScript'); await ready();
    check('A stale draft gets a visible conflict, with its text preserved', await b.evaluate("document.getElementById('status').textContent.includes('another window')&&document.getElementById('scriptSource').value.endsWith('// local draft')", manager));
    await click('discardDraft'); await click('confirmAccept'); await ready();
    await until("document.getElementById('scriptSource').value.endsWith('// newer saved source')");
    check('Explicit discard loads the latest saved source', await b.evaluate("document.getElementById('scriptSource').value.endsWith('// newer saved source')", manager));
    check('Editing an active script pauses it for review', !(await send({ type: 'US_LIST' })).scripts.find(script => script.id === firstId).enabled);
    const unsupported = firstSource.replace('// ==/UserScript==', '// @require http://unused.invalid/code.js\n// ==/UserScript==');
    await setText(unsupported); await click('saveScript'); await ready();
    check('Insecure dependency is rejected visibly and leaves saved source untouched', await b.evaluate("document.getElementById('status').textContent.includes('Assets require HTTPS')", manager) &&
      (await send({ type: 'US_LIST' })).scripts.find(script => script.id === firstId).source.endsWith('// newer saved source'));
    await click('discardDraft'); await click('confirmAccept'); await ready();
    await click('deleteScript'); await click('confirmAccept'); await ready();
    await until("document.getElementById('status').textContent.includes('Script and its local values deleted')");
    check('Deletion removes source and its GM value namespace', !(await b.evaluate("(globalThis.browser || chrome).storage.local.get('userscriptManager')", manager)).userscriptManager.scripts.some(script => script.id === firstId));
    const longName = 'Local ' + 'z'.repeat(135) + ' <img>';
    await click('newScript'); await setText(scriptSource(longName)); await click('saveScript'); await ready();
    check('Metadata is displayed as literal text', await b.evaluate('document.getElementById("editorHeading").textContent===' + JSON.stringify(longName) + '&&!document.querySelector("#editorHeading img,.script-item img")', manager));
    await b.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
    check('Long script names fit the narrow layout', await b.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth&&document.getElementById("editorHeading").getBoundingClientRect().right<=document.documentElement.clientWidth', manager));
    await click('deleteScript');
    await until('document.getElementById("confirmDialog").open');
    for (const type of ['keyDown', 'keyUp']) await b.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }, manager);
    await until('!document.getElementById("confirmDialog").open'); await ready();
    check('Escape cancels deletion and preserves the script', (await send({ type: 'US_LIST' })).scripts.some(script => script.metadata.name === longName));
    await click('deleteScript'); await click('confirmAccept'); await ready();
    await until("document.getElementById('status').textContent.includes('Script and its local values deleted')");
    await b.evaluate("document.querySelector('.script-item').id='openRemaining'", manager);
    await click('openRemaining');
    for (const width of [1280, 390]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
      const metrics = await b.evaluate('({width:innerWidth,client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight})', manager);
      (evidence.layouts ||= []).push(metrics);
      check('Manager has no page overflow at width ' + width, metrics.scroll <= metrics.client);
      // Expand the capture viewport to its content height, avoiding Chromium's
      // full-page capture scrollbar reflow that can crop the right-hand margin.
      await b.send('Emulation.setDeviceMetricsOverride', { width, height: metrics.height + 1, deviceScaleFactor: 1, mobile: false }, manager);
      const shot = await b.send('Page.captureScreenshot', { format: 'png' }, manager);
      await fs.writeFile(path.join(temp, 'manager-' + width + '.png'), Buffer.from(shot.data, 'base64'));
    }
    check('The deny proxy encountered no unexpected socket errors', evidence.proxyErrors.length === 0);
    evidence.success = true;
  } catch (error) {
    evidence.success = false; evidence.error = error.stack;
    if (b && manager) {
      evidence.ui = await b.evaluate("({text:document.body.innerText,source:document.getElementById('scriptSource')?.value})", manager).catch(() => null);
      evidence.inputEvents = await b.evaluate('globalThis.__moduleTestClicks?.slice(-12)', manager).catch(() => null);
      evidence.events = b.events.filter(event => ['Runtime.exceptionThrown', 'Log.entryAdded'].includes(event.method));
      if (details) evidence.browserDetails = await b.evaluate("(()=>{const d=document.querySelector('extensions-manager')?.shadowRoot.querySelector('extensions-detail-view');return d?{state:d.data?.state,disableReasons:d.data?.disableReasons,manifestErrors:d.data?.manifestErrors,runtimeErrors:d.data?.runtimeErrors}:null;})()", details).catch(() => null);
    }
    process.exitCode = 1;
  } finally {
    if (b) evidence.cleanup = await b.close();
    fixtures.closeAllConnections(); proxy.closeAllConnections(); secondOrigin.closeAllConnections();
    await new Promise(resolve => secondOrigin.close(resolve));
    await Promise.all([new Promise(resolve => fixtures.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    evidence.finished = new Date().toISOString();
    await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, success: evidence.success, checks: evidence.checks.length, error: evidence.error, evidence: path.join(temp, 'evidence.json') }, null, 2));
  }
})();
