/* Firefox native userscript permission and compatibility, safely offline. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { firefox } = require('./browser-smoke.cjs');
const { runCompatibility, files, scriptSource } = require('./userscripts-compatibility.cjs');
const { fixtureHandler } = require('./userscripts-network-fixtures.cjs');
const { runAssetsAndNetwork } = require('./userscripts-assets-network.cjs');
const root = path.resolve(__dirname, '..');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'module-engine-userscripts-firefox-')), extension = path.join(temp, 'extension');
  await fs.mkdir(extension);
  for (const file of files) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const evidence = { browser: 'firefox', temp, started: new Date().toISOString(), checks: [], hashes: {}, deniedRequests: 0, proxyErrors: [] };
  for (const file of files.filter(file => !['rules', 'icons'].includes(file))) evidence.hashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  if (!process.argv.includes('--install-only')) await require('./userscripts-desktop-browser.cjs').installClipboardSink(extension, evidence);
  await fs.mkdir(path.join(temp, 'exports'));
  const proxy = http.createServer((_request, response) => { evidence.deniedRequests++; response.writeHead(403); response.end('Offline test'); });
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
    if (route(request, response)) return;
    if (request.url === '/ad.js') { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end('window.fixtureAd=true;'); return; }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><script>window.startObserved=document.documentElement.dataset.startMarker;</script></head><body><h1>Owned offline fixture</h1>' +
      '<script src="http://localhost:' + port + '/ad.js"></script>' + (request.url === '/compat/frames' ? '<iframe src="/compat/child"></iframe>' : '') + '</body></html>');
  });
  await Promise.all([new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)), new Promise(resolve => fixtures.listen(0, '127.0.0.1', resolve))]);
  port = fixtures.address().port;
  let b, manager;
  const check = (name, result) => { assert.ok(result, name); evidence.checks.push(name); };
  const until = async (expression, target = manager) => {
    for (let i = 0; i < 160; i++) { const value = await b.evaluate(expression, target); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Timed out: ' + expression);
  };
  const send = message => b.evaluate('browser.runtime.sendMessage(' + JSON.stringify(message) + ')', manager);
  const click = async id => {
    const point = await until('(()=>{const e=document.getElementById(' + JSON.stringify(id) + ');if(!e||e.disabled||!e.getClientRects().length)return null;e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()');
    await b.clickAt(point.x, point.y, manager);
  };
  try {
    b = await firefox(extension, path.join(temp, 'profile'), proxy.address().port, { ruleFeedback: false, downloadDirectory: path.join(temp, 'exports') });
    evidence.version = b.version;
    manager = await b.open('moz-extension://' + b.id + '/manager.html');
    await until('!document.getElementById("refresh").disabled');
    check('Firefox keeps userscripts optional and initially off', !(await send({ type: 'US_LIST' })).enabled);
    check('Firefox has no automatic userscript permission grant', !(await b.evaluate("browser.permissions.contains({permissions:['userScripts']})", manager)));
    await click('grantAccess');
    for (let i = 0; i < 100; i++) {
      if (await b.evaluate("browser.permissions.contains({permissions:['userScripts']})", manager)) break;
      const prompt = await b.userscriptPermissionPrompt(true);
      evidence.permissionPrompt = prompt;
      if (prompt.accepted) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await until("browser.permissions.contains({permissions:['userScripts']})");
    check('Firefox manager button grants native userscript access', (await send({ type: 'US_LIST' })).available);
    await click('userscriptsEnabled');
    await until("browser.runtime.sendMessage({type:'US_LIST'}).then(r=>r.active)");
    check('Firefox native userScripts module is active', (await send({ type: 'US_LIST' })).active);
    check('Offline ad canary configured', (await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'localhost' })).ok);
    const browse = pathname => b.open('http://127.0.0.1:' + port + pathname);
    const recordConsole = async stage => { (evidence.consoleStages ||= []).push({stage, errors: await b.consoleErrors()}); };
    if(!process.argv.includes('--desktop-only')&&!process.argv.includes('--install-only')) await require('./userscripts-editor-browser.cjs').runEditor({b,manager,send,check,until,browse,scriptSource,click,temp,evidence});
    await recordConsole('editor');
    if(process.argv.includes('--editor-only')) { evidence.success=true;evidence.focus='editor-only';return; }
    if (!process.argv.includes('--desktop-only')) await require('./userscripts-install-browser.cjs').runInstallation({ b, manager, send, check, until, browse, temp, evidence, fixtureState, base: 'http://127.0.0.1:' + port });
    await recordConsole('installation');
    if (process.argv.includes('--install-only')) {
      evidence.extensionErrors = await b.consoleErrors(); check('No uncaught Firefox installation errors', evidence.extensionErrors.length === 0);
      check('Deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0); evidence.success = true; evidence.focus = 'install-only'; return;
    }
    if(!process.argv.includes('--desktop-only')) {
      await runCompatibility({ b, manager, send, check, until, browse, scriptSource, temp, evidence });
      await recordConsole('compatibility');
      await require('./userscripts-helpers-browser.cjs').runHelpers({ b, manager, send, check, until, browse, scriptSource, evidence });
      await recordConsole('tab helpers');
    }
    await require('./userscripts-desktop-browser.cjs').runDesktop({ b, manager, send, check, until, browse, scriptSource, evidence, temp, fixtureState, click, base: 'http://127.0.0.1:' + port });
    await recordConsole('desktop and transfers');
    if(process.argv.includes('--desktop-only')) { evidence.success=true; evidence.focus='desktop-only'; return; }
    await runAssetsAndNetwork({ b, manager, send, check, until, browse, scriptSource, temp, evidence, fixtureState,
      base: 'http://127.0.0.1:' + port, other: 'http://127.0.0.1:' + secondOrigin.address().port });
    evidence.extensionErrors = await b.consoleErrors();
    check('No uncaught extension errors during Firefox compatibility checks', evidence.extensionErrors.length === 0);
    check('Deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0);
    evidence.success = true;
  } catch (error) {
    evidence.success = false; evidence.error = error.stack; process.exitCode = 1;
    if (b) {
      evidence.events = b.events; evidence.extensionErrors = await b.consoleErrors().catch(() => []);
      evidence.permissionPrompt = await b.userscriptPermissionPrompt().catch(error => ({ error: error.message }));
      if (manager) evidence.ui = await b.evaluate('document.body.innerText', manager).catch(() => null);
    }
  } finally {
    if (b) { try { await b.close(); evidence.cleanup = { browserClosed: true }; } catch (error) { evidence.success = false; evidence.cleanup = { error: error.message }; process.exitCode = 1; } }
    fixtures.closeAllConnections(); proxy.closeAllConnections(); secondOrigin.closeAllConnections();
    await new Promise(resolve => secondOrigin.close(resolve));
    await Promise.all([new Promise(resolve => fixtures.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    evidence.finished = new Date().toISOString();
    await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: 'firefox', success: evidence.success, checks: evidence.checks.length, error: evidence.error, evidence: path.join(temp, 'evidence.json') }, null, 2));
  }
})();
