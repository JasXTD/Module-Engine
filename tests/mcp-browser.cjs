/* Owned loopback fixture plus a real MCP process and native extension port. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { processClient } = require('./mcp-client.cjs');
async function runMCP({ b, manager, send, check, until, browse, scriptSource, evidence, temp, fixtureState,
  transport = process.argv.includes('--mcp-http') ? 'http' : 'stdio' }) {
  const serverHashes = {};
  for (const file of ['mcp/server.cjs', 'mcp/rpc.cjs', 'mcp/http.cjs', 'src/shared/debug-protocol.js'])
    serverHashes[file] = createHash('sha256').update(await fs.readFile(path.join(__dirname, '..', file))).digest('hex');
  evidence.hashes['rules/ads.json'] = createHash('sha256').update(await fs.readFile(path.join(temp, 'extension/rules/ads.json'))).digest('hex');
  const client = await processClient({ transport }), pages = []; let scriptId;
  const click = async (id, target) => {
    await b.front(target);
    const point = await until('(()=>{const e=document.getElementById(' + JSON.stringify(id) + ');if(!e||e.disabled)return null;e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()', target);
    await b.clickAt(point.x, point.y, target);
  };
  const openDebug = async () => { const target = await b.open(await b.evaluate('(globalThis.browser||chrome).runtime.getURL("src/ui/mcp/debug.html")', manager)); pages.push(target); return target; };
  const pair = async (page, scopes = ['status', 'scripts', 'logs']) => {
    // The UI revokes locally before its asynchronous /disconnect reaches the
    // helper. Wait for that observed state, not merely the button click, before
    // requesting a replacement code. Never submit an undefined pairing code.
    let connection, waits = 0; const deadline = Date.now() + 10000;
    do {
      connection = await client.tool('connection');
      if (typeof connection.pairingCode === 'string') break;
      if (!connection.connected || Date.now() >= deadline) throw new Error('Owned MCP helper did not finish disconnecting before re-pairing.');
      waits++; await new Promise(resolve => setTimeout(resolve, 50));
    } while (true);
    (evidence.mcpPairingWaits ||= []).push({ transport, waits });
    await b.evaluate('(()=>{document.getElementById("pairingCode").value=' + JSON.stringify(connection.pairingCode) + ';document.getElementById("shareScripts").checked=' + scopes.includes('scripts') + ';document.getElementById("shareLogs").checked=' + scopes.includes('logs') + ';document.getElementById("shareNetwork").checked=' + scopes.includes('network') + ';document.getElementById("shareChanges").checked=' + scopes.includes('changes') + ';})()', page);
    await click('connect', page);
    await until('document.getElementById("connectionBadge").textContent.includes("Connected")', page);
    check('MCP pairing clears its secret from the field', await b.evaluate('document.getElementById("pairingCode").value===""', page));
  };
  try {
    const init = await client.initialize(); check('Real ' + transport + ' MCP initializes', init.result.serverInfo.name === 'module-engine');
    const list = await client.request('tools/list'); check('Only seven read-only tools are advertised', list.result.tools.length === 7 && list.result.tools.every(tool => tool.annotations.readOnlyHint));
    check('MCP cannot inspect an unpaired browser', (await client.tool('status')).ok === false);
    const source = scriptSource('MCP owned error', '// @inject-into page\n// @grant GM.getValue\n', 'window.ownedMCPPage=true;document.body.dataset.mcpRan="yes";throw new Error("Owned offline debug error");').replace('http://127.0.0.1/*', 'http://127.0.0.1/mcp/*');
    const saved = await send({ type: 'US_SAVE', source }); scriptId = saved.selectedId;
    const record = saved.scripts.find(s => s.id === scriptId); check('Owned diagnostic script saved', saved.ok && record);
    check('Owned diagnostic script enabled', (await send({ type: 'US_ENABLE', id: scriptId, revision: record.revision, enabled: true })).ok);
    const page = await openDebug();
    check('Network metadata sharing is unchecked by default',await b.evaluate("!document.getElementById('shareNetwork').checked",page));
    check('MCP has a persistent manager sidebar entry',await b.evaluate("Boolean(document.querySelector('.rail-pages a[href=\"../mcp/debug.html\"]'))",manager));
    // A DOM-dispatched submit cannot grant approval.
    await b.evaluate('document.getElementById("connectForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}))', page);
    check('Synthetic page submit does not connect', (await client.tool('connection')).connected === false);
    await pair(page);
    const before = await b.evaluate('(globalThis.browser||chrome).storage.local.get(null)', manager);
    const status = await client.tool('status'); check('MCP sees active blocker and userscripts', status.ok && status.blocking.enabled && status.blocking.nativeEnabledRulesets.length > 0 && status.userscripts.active);
    const scripts = await client.tool('list_scripts'); check('MCP script list has metadata without source bodies', scripts.scripts.some(s => s.id === scriptId) && scripts.scripts.every(s => !('source' in s)));
    const read = await client.tool('get_script', { id: scriptId }); check('MCP retrieves the exact installed source', read.script.source === source);
    const matching = await client.tool('check_url', { url: 'http://127.0.0.1:1234/mcp/test' }); check('MCP checks matching without visiting URL', matching.scripts.find(s => s.id === scriptId).matches);
    const blocked = await client.tool('status', { action: 'disable' }); check('Unexpected write-like arguments are rejected', blocked.error?.code === -32602);
    const recordAfter = await b.evaluate('(globalThis.browser||chrome).storage.local.get(null)', manager);
    check('MCP inspection leaves persisted configuration identical', JSON.stringify(before) === JSON.stringify(recordAfter));
    const rawLibrary = before.userscriptManager;
    check('MCP results never expose stored capability tokens or values', !JSON.stringify({ scripts, read, status }).includes(rawLibrary.scripts.find(s => s.id === scriptId).token) && !('values' in read.script));
    const fixture = await browse('/mcp/error?q=private#fragment'); pages.push(fixture);
    await until('document.body.dataset.mcpRan==="yes"', fixture);
    let logs;
    for (let i = 0; i < 5; i++) { logs = await client.tool('get_logs', { kind: 'userscript', scriptId }); if (logs.entries?.length) break; await new Promise(r => setTimeout(r, 100)); }
    check('MCP captures a page-bridge userscript exception', logs.entries?.some(e => e.message === 'Owned offline debug error' && e.scriptId === scriptId));
    check('The captured script actually ran in the page world', await b.evaluate('window.ownedMCPPage===true', fixture));
    check('Diagnostic URL omits query and fragment', logs.entries.every(e => !e.url.includes('?') && !e.url.includes('#')));
    check('Ad canary remains blocked during MCP connection', await b.evaluate('window.fixtureAd===undefined', fixture));
    const activity = await client.tool('get_logs', { kind: 'activity', limit: 10 }); check('Activity reads are bounded', activity.ok && activity.entries.length <= 10);
    check('Debug UI records agent read names', await b.evaluate('document.getElementById("reads").textContent.includes("module_engine_get_script")', page));
    await require('./mcp-network-browser.cjs').runNetworkReads({b,manager,page,client,pair,click,check,until,browse,pages,evidence,transport,fixtureState});
    const widths = evidence.browser === 'firefox' ? [await b.evaluate('innerWidth', page)] : [1280, 390];
    for (const width of widths) {
      if (evidence.browser !== 'firefox') await b.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }, page);
      await b.front(page); await b.evaluate('scrollTo(0,0)', page);
      check('Debug page has no horizontal overflow at ' + width, await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1', page));
      const output = path.join(temp, 'debug-' + transport + '-' + width + '.png');
      if (evidence.browser === 'firefox') await b.screenshot(output, page);
      else { const shot = await b.send('Page.captureScreenshot', { format: 'png' }, page); await fs.writeFile(output, Buffer.from(shot.data, 'base64')); }
    }
    await click('disconnect', page); check('Disconnect immediately revokes subsequent reads', (await client.tool('status')).ok === false);
    // This server was started without --allow-changes, so it drops the change request.
    await pair(page, ['status', 'changes']);
    check('A read-only server connects read-only and says why', await b.evaluate('document.getElementById("status").textContent.includes("without --allow-changes")&&document.getElementById("connectionBadge").textContent==="Connected · read-only"&&document.getElementById("proposalsCard").hidden', page));
    check('Status-only approval refuses script source', (await client.tool('get_script', { id: scriptId })).ok === false);
    check('Status-only approval refuses logs', (await client.tool('get_logs')).ok === false);
    check('Status-only approval refuses network metadata', (await client.tool('get_network_log')).ok === false);
    await click('disconnect', page); await pair(page);
    check('New debug session starts with empty captured errors', (await client.tool('get_logs', { kind: 'userscript' })).entries.length === 0);
    if (transport === 'http') {
      await client.disconnect();
      await until('document.getElementById("connectionBadge").textContent==="Disconnected"', page);
      check('HTTP DELETE revokes the native browser connection', await b.evaluate('document.getElementById("disconnect").disabled', page));
      await client.initialize();
      check('Reinitialized HTTP client cannot inherit browser approval', (await client.tool('status')).ok === false);
      await pair(page);
      check('Explicit browser reapproval restores HTTP status reads', (await client.tool('status')).ok);
    }
    await b.closePage(page); pages.splice(pages.indexOf(page), 1);
    // The port revokes immediately even if the best-effort local disconnect is lost.
    check('Closing Debug page prevents browser data delivery', (await client.tool('status')).ok === false);
    const after = await browse('/mcp/after'); pages.push(after); await until('document.body.dataset.mcpRan==="yes"', after);
    check('Ad blocker remains active after MCP shutdown', await b.evaluate('window.fixtureAd===undefined', after));
    evidence.mcp = { protocol: init.result.protocolVersion, readOnly: true, process: transport, serverHashes, screenshots: widths.map(width => 'debug-' + transport + '-' + width + '.png') };
  } finally {
    for (const page of pages) await b.closePage(page).catch(() => {});
    if (scriptId) { const library = await send({ type: 'US_LIST' }); const script = library.scripts?.find(s => s.id === scriptId); if (script) check('Owned MCP script removed', (await send({ type: 'US_DELETE', id: scriptId, revision: script.revision })).ok); }
    evidence.mcpProcessExit = await client.close();
    check('Owned MCP process stops without unexpected output', !evidence.mcpProcessExit.stderr && !evidence.mcpProcessExit.stdout &&
      (evidence.mcpProcessExit.code === 0 || transport === 'http' && evidence.mcpProcessExit.signal === 'SIGTERM'));
  }
}
async function runMCPTransports(context) {
  const { b, evidence, check }=context; evidence.mcpRuns=[];
  const transports=process.argv.includes('--mcp-both')?['stdio','http']:[process.argv.includes('--mcp-http')?'http':'stdio'];
  for(const transport of transports) {
    const before=evidence.checks.length;await runMCP({...context,transport});
    evidence.mcpRuns.push({...evidence.mcp,checks:evidence.checks.length-before,exit:evidence.mcpProcessExit});
  }
  const before=evidence.checks.length;await require('./mcp-changes-browser.cjs').runChanges({...context,transport:transports[0]});
  evidence.mcpRuns.push({...evidence.mcpChanges,checks:evidence.checks.length-before,exit:evidence.mcpChangesExit});
  const errors=b.consoleErrors?await b.consoleErrors():b.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails);
  const expected=e=>JSON.stringify(e).includes('Owned offline debug error');
  const unloaded=e=>['/src/blocking/content.js','/src/appearance/website-theme.js'].some(file=>e.source==='moz-extension://'+b.id+file) && /^(?:Promise resolved after context unloaded|Promise rejected after context unloaded: Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved)\s*$/.test(e.text);
  evidence.mcpExpectedErrors=errors.filter(expected);evidence.mcpClosedPageErrors=errors.filter(unloaded);
  evidence.mcpUnexpectedErrors=errors.filter(e=>!expected(e)&&!unloaded(e));
  check('MCP transports and network reads have no unexpected uncaught runtime errors',evidence.mcpUnexpectedErrors.length===0);
}
module.exports = { runMCP, runMCPTransports };
