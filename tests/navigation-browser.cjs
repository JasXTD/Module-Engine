/* Native section navigation, real MCP approvals and owned loopback traffic.
   No simulated ports: iframe sender authorization and unload cleanup are tested
   in each installed browser using its existing disposable-profile harness. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { processClient } = require('./mcp-client.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runNavigation({ b, manager, send, check, until, browse, scriptSource, evidence, temp }) {
  const transport = process.argv.includes('--mcp-http') ? 'http' : 'stdio';
  const client = await processClient({ transport, allowChanges: true }), pages = [], owned = new Set();
  evidence.navigationHarnessHash = createHash('sha256').update(await fs.readFile(__filename)).digest('hex');
  const paths = { manager: 'manager/manager.html', lists: 'lists/lists.html', log: 'log/log.html', network: 'network/network.html', mcp: 'mcp/debug.html', backup: 'backup/backup.html' };
  const getURL = key => b.evaluate('(globalThis.browser||chrome).runtime.getURL(' + JSON.stringify('src/ui/' + paths[key]) + ')', manager);
  let owner;
  const active = "(document.querySelector('.me-section-frame:not([hidden])')?.contentDocument||document)";
  const code = body => '(()=>{const d=' + active + ';' + body + '})()';
  const get = body => b.evaluate(code(body), owner);
  const wait = body => until(code('return ' + body), owner);
  const open = async key => { owner = await b.open(await getURL(key)); pages.push(owner); await wait('d.readyState==="complete"'); };
  const click = async selector => {
    await b.front(owner);
    const point = await wait('(()=>{const e=d.querySelector(' + JSON.stringify(selector) + ');if(!e||e.disabled)return null;' +
      'e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect(),f=d.defaultView.frameElement?.getBoundingClientRect();' +
      'const x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(d.elementFromPoint(x,y)))return null;return {x:x+(f?.x||0),y:y+(f?.y||0)};})()');
    await b.clickAt(point.x, point.y, owner);
  };
  const section = async key => {
    await click('.rail-pages a[href$="' + paths[key].split('/').at(-1) + '"]');
    await wait('d.location.pathname===' + JSON.stringify('/src/ui/' + paths[key]));
  };
  const pair = async (scopes = ['scripts', 'logs', 'network', 'changes']) => {
    let connection;
    for (let i = 0; i < 200; i++) { connection = await client.tool('connection'); if (connection.pairingCode) break; await pause(50); }
    check('Fresh MCP pairing requires a new code', typeof connection.pairingCode === 'string');
    await get('d.getElementById("pairingCode").value=' + JSON.stringify(connection.pairingCode) + ';' +
      ['Scripts', 'Logs', 'Network', 'Changes'].map(name => 'd.getElementById("share' + name + '").checked=' + scopes.includes(name.toLowerCase()) + ';').join(''));
    await click('#connect');
    await require('./mcp-browser.cjs').approveMCPData(b, owner, evidence);
    await wait('d.getElementById("connectionBadge").classList.contains("active")');
    check('Pairing works through the native packaged-page sender check', (await client.tool('status')).ok);
    check('The pairing secret is cleared from the UI', await get('return d.getElementById("pairingCode").value===""'));
  };
  const snapshot = async name => {
    await b.front(owner);
    const output = path.join(temp, name + '.png');
    if (evidence.browser === 'firefox') await b.screenshot(output, owner);
    else { const result = await b.send('Page.captureScreenshot', { format: 'png' }, owner); await fs.writeFile(output, Buffer.from(result.data, 'base64')); }
    (evidence.navigationScreenshots ||= []).push(name + '.png');
  };
  const closeOwner = async () => { await b.closePage(owner); pages.splice(pages.indexOf(owner), 1); };
  const tabIds = () => b.evaluate('(globalThis.browser||chrome).tabs.query({}).then(t=>t.map(t=>t.id).sort((a,b)=>a-b))', manager);
  try {
    await client.initialize();
    check('Unpaired navigation cannot give MCP access', (await client.tool('status')).ok === false);
    await open('manager');
    const ownerURL = await getURL('manager'), initialTabs = JSON.stringify(await tabIds());
    check('Modules & scripts links MCP only from its side menu', await get('const links=[...d.links].filter(a=>a.pathname.endsWith("/mcp/debug.html"));return links.length===1&&links[0].closest(".rail-pages")!==null'));
    const draft = scriptSource('Navigation retained draft', '// @grant none\n', 'document.body.dataset.navigationDraft="ran";');
    await click('#newScript');
    await get('const e=d.getElementById("scriptSource");e.value=' + JSON.stringify(draft) + ';e.dispatchEvent(new Event("input",{bubbles:true}));window.navigationRoot=d;window.navigationHides=0;addEventListener("pagehide",()=>navigationHides++);');
    await section('mcp');
    // A first visit is where Chromium rings a script-focused heading after a click.
    check('A clicked first visit focuses the section heading without a focus ring', await get('const h=d.querySelector("h1");return d.activeElement===h&&getComputedStyle(h).outlineStyle==="none"'));
    check('Clicking MCP creates no browser tab', JSON.stringify(await tabIds()) === initialTabs);
    check('Section navigation keeps the host URL and document', await get('return location.href===' + JSON.stringify(ownerURL) + '&&navigationRoot===document&&navigationHides===0'));
    await pair();
    await get('window.navigationMCP=d;window.navigationDetail=d.getElementById("sessionDetail").textContent;');
    const running = await client.tool('status');
    check('Ad blocker and userscripts stay active while paired', running.blocking.enabled && running.blocking.nativeEnabledRulesets.length > 0 && running.userscripts.active);
    await get('for(const name of ["lists/lists.html","log/log.html","network/network.html"])[...d.links].find(a=>a.pathname.endsWith("/"+name)).click();');
    await wait('d.location.pathname.endsWith("/network/network.html")');
    check('Rapid section choices activate the latest view and retain approval', (await client.tool('status')).ok);
    await get('[...d.links].find(a=>a.pathname.endsWith("/manager.html")).focus();');
    await b.front(owner); await b.pressKey('Enter', owner);
    await wait('d.location.pathname.endsWith("/manager/manager.html")');
    check('Keyboard navigation focuses the new section heading', await get('return d.activeElement===d.querySelector("h1")'));
    for (const key of ['manager', 'lists', 'log', 'network', 'mcp', 'backup', 'lists', 'manager']) {
      await section(key);
      check('MCP stays readable in ' + key, (await client.tool('status')).ok);
      check('Connected indicator appears in ' + key, await get('return !d.querySelector(".me-nav-status").hidden&&d.querySelector(".me-nav-status").textContent==="Connected"'));
      if (key === 'backup') {
        check('Backup messages work from the retained section frame', (await get('return (d.defaultView.browser||d.defaultView.chrome).runtime.sendMessage({type:"BACKUP_EXPORT"})')).ok);
      }
    }
    check('The unsaved editor draft survives all section switches', await get('return d.getElementById("scriptSource").value===' + JSON.stringify(draft)));
    await click('#discardDraft'); await wait('d.getElementById("confirmDialog").open');
    const reviewPosition = await b.evaluate('history.state.position', owner);
    await b.evaluate('history.back()', owner);
    await until('history.state.position===' + reviewPosition, owner);
    check('Back cannot abandon an open modal review', await get('return d===document&&d.getElementById("confirmDialog").open'));
    await click('#confirmDialog button[value="cancel"]'); await wait('!d.getElementById("confirmDialog").open');
    check('Cancelling the review preserves the draft and MCP approval', (await client.tool('status')).ok && await get('return d.getElementById("scriptSource").value===' + JSON.stringify(draft)));
    await click('#saveScript');
    await wait('d.getElementById("status").textContent.startsWith("Script saved and turned off")');
    const saved = (await send({ type: 'US_LIST' })).scripts.find(s => s.metadata.name === 'Navigation retained draft');
    check('Retained draft saves through the normal manager', saved?.source === draft && !saved.enabled); owned.add(saved.id);
    await section('network'); await click('#startCapture');
    await wait('d.getElementById("captureBadge").textContent==="Recording"');
    await section('manager');
    const fixture = await browse('/navigation/traffic'); pages.push(fixture);
    await until('document.readyState==="complete"', fixture);
    await b.evaluate("fetch('/net/post?private-navigation=1',{method:'POST',body:'private-navigation-body'}).then(r=>r.text())", fixture);
    let network;
    for (let i = 0; i < 80; i++) { network = await client.tool('get_network_log', { url: '/net/post' }); if (network.entries?.some(r => r.state === 'complete')) break; await pause(50); }
    check('Hidden Network capture remains active and readable via MCP', network.ok && network.capture.active && network.entries.some(r => r.method === 'POST' && r.statusCode === 201));
    check('Metadata still excludes request content and URL queries', !JSON.stringify(network.entries).includes('private-navigation'));
    check('Local ad canary remains blocked during retained capture', await b.evaluate('window.fixtureAd===undefined', fixture));
    const proposalSource = scriptSource('Navigation reviewed script', '// @grant none\n', 'document.body.dataset.navigationProposal="ran";');
    const proposed = await client.tool('propose_script', { source: proposalSource });
    check('A hidden MCP section receives a pending proposal', proposed.ok && proposed.proposal.status === 'pending');
    const proposalId = proposed.proposal.id;
    await wait('d.querySelector(".me-nav-status").textContent==="Connected · 1"');
    await get('navigationMCP.getElementById(' + JSON.stringify('applyEnable-' + proposalId) + ').click();');
    check('A synthetic click in the hidden section cannot apply a proposal', (await client.tool('get_proposal', { proposalId })).proposal.status === 'pending');
    await section('mcp');
    check('MCP document, session detail and review survive navigation', await get('return d===navigationMCP&&d.getElementById("sessionDetail").textContent===navigationDetail&&Boolean(d.getElementById(' + JSON.stringify('apply-' + proposalId) + '))'));
    await click('#applyEnable-' + proposalId);
    await wait('!d.getElementById(' + JSON.stringify('applyEnable-' + proposalId) + ')');
    const applied = (await client.tool('get_proposal', { proposalId })).proposal; owned.add(applied.scriptId);
    check('Trusted review still applies and enables exactly the proposed source', applied.status === 'applied' && (await send({ type: 'US_LIST' })).scripts.some(s => s.id === applied.scriptId && s.enabled && s.source === proposalSource));
    const executed = await browse('/navigation/executed'); pages.push(executed);
    await until('document.body.dataset.navigationProposal==="ran"', executed);
    check('Reviewed userscript executes while its ad canary stays blocked', await b.evaluate('window.fixtureAd===undefined', executed));
    await section('network');
    check('Returning to Network retains capture ownership', await get('return d.getElementById("captureBadge").textContent==="Recording"&&d.getElementById("captureHint").textContent.includes("This page owns")'));
    await section('lists'); await section('log');
    await b.evaluate('history.back()', owner); await wait('d.location.pathname.endsWith("/lists/lists.html")');
    await b.evaluate('history.forward()', owner); await wait('d.location.pathname.endsWith("/log/log.html")');
    check('Back and Forward preserve native MCP approval', (await client.tool('status')).ok);
    check('Visited sections reuse one child document each, with only one visible', await get('const frames=[...document.querySelectorAll("iframe.me-section-frame")];return frames.length===' +
      (Object.keys(paths).length - 1) + '&&new Set(frames.map(frame=>frame.dataset.meSection)).size===frames.length&&frames.filter(frame=>!frame.hidden).length===1'));
    await section('mcp');
    const widths = evidence.browser === 'firefox' ? [await b.evaluate('innerWidth', owner)] : [1280, 390];
    for (const width of widths) {
      if (evidence.browser !== 'firefox') await b.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }, owner);
      await get('d.defaultView.scrollTo(0,0)');
      check('MCP retained layout fits width ' + width, await get('return d.documentElement.scrollWidth<=d.defaultView.innerWidth+1&&document.documentElement.scrollWidth<=innerWidth+1'));
      await snapshot('navigation-mcp-' + width);
      await section('manager');
      check('Manager layout fits with MCP indicator at ' + width, await get('return d.documentElement.scrollWidth<=d.defaultView.innerWidth+1'));
      await snapshot('navigation-manager-' + width); await section('mcp');
    }
    if (evidence.browser !== 'firefox') await b.send('Emulation.clearDeviceMetricsOverride', {}, owner);
    await click('#disconnect');
    check('Explicit Disconnect revokes hidden Network reads too', (await client.tool('get_network_log')).ok === false);
    await section('manager'); check('Sidebar clears the disconnected indicator', await get('return d.querySelector(".me-nav-status").hidden'));
    await section('mcp'); await pair([]);
    check('A new approval cannot inherit network or script scopes', (await client.tool('get_network_log')).ok === false && (await client.tool('list_scripts')).ok === false);
    await section('network');
    await b.reload(owner);
    await until('typeof navigationRoot==="undefined"&&document.readyState==="complete"&&Boolean(document.querySelector(".rail-pages"))', owner);
    await wait('d.location.pathname.endsWith("/network/network.html")');
    check('Reloading the tab revokes the old native MCP connection', (await client.tool('status')).ok === false);
    await section('network');
    await wait('d.getElementById("captureBadge").textContent==="Not recording"');
    check('Reload stops the tab-owned capture', !(await get('return d.getElementById("startCapture").disabled')));
    await section('mcp'); await pair(); await section('manager'); await closeOwner();
    check('Closing a tab revokes MCP even when its section is hidden', (await client.tool('status')).ok === false);
    // Also exercise the legacy direct MCP URL as the host, with manager inside it.
    await open('mcp'); await pair(); await section('manager');
    await wait('!d.getElementById("newScript").disabled');
    check('A directly opened MCP page retains its connection in other sections', (await client.tool('status')).ok);
    await section('mcp'); check('Returning to the direct MCP host reuses its document', await get('return d===document&&d.getElementById("connectionBadge").classList.contains("active")'));
    await closeOwner();
    check('Closing the direct MCP host also revokes approval', (await client.tool('status')).ok === false);
    await open('mcp'); await pair([]); await section('manager');
    const outside = await b.evaluate('location.origin+"/navigation/leave"', fixture);
    await get('const a=d.createElement("a");a.id="ownedExit";a.textContent="Owned offline navigation";a.href=' + JSON.stringify(outside) + ';d.querySelector("main").prepend(a);');
    await click('#ownedExit');
    await until('location.href===' + JSON.stringify(outside) + '&&document.readyState==="complete"', owner);
    check('Leaving a child section navigates the whole tab and revokes MCP', (await client.tool('status')).ok === false && await b.evaluate('top===window&&!document.querySelector(".me-section-frame")&&window.fixtureAd===undefined', owner));
    await closeOwner();
    check('Deny proxy reports no unexpected errors', evidence.proxyErrors.length === 0);
    evidence.navigation = { transport, retainedSections: 5, draftSaved: true, pendingReview: true, capturePreserved: true, reloadAndCloseRevoke: true };
    const errors = evidence.browser === 'firefox' ? await b.consoleErrors() : b.events.filter(event => event.method === 'Runtime.exceptionThrown');
    // Firefox itself reports a pending content-script reply dropped by closing
    // a page. Match only this known lifecycle diagnostic, as the blocker and
    // install suites do, and retain it separately from extension/UI failures.
    evidence.navigationClosedPageErrors = evidence.browser === 'firefox' ? errors.filter(error =>
      ['/src/blocking/content.js', '/src/blocking/generic-static.js', '/src/appearance/website-theme.js'].some(file => error.source === 'moz-extension://' + b.id + file) &&
      /^Promise (?:rejected|resolved) (?:after context unloaded|while context is inactive)/.test(error.text)) : [];
    evidence.navigationErrors = errors.filter(error => !evidence.navigationClosedPageErrors.includes(error));
    check('Navigation has no unexpected browser errors', evidence.navigationErrors.length === 0);
  } catch (error) {
    evidence.navigationFailure = await get('return {host:location.href,section:d.location.href,state:history.state,dialogs:[...d.querySelectorAll("dialog[open]")].map(e=>e.id),frames:[...document.querySelectorAll("iframe.me-section-frame")].map(e=>({section:e.dataset.meSection,hidden:e.hidden,inert:e.inert})),notice:d.getElementById("sectionNavigationError")?.textContent};').catch(() => null);
    throw error;
  } finally {
    for (const page of pages) await b.closePage(page).catch(() => {});
    for (const id of owned) { const script = (await send({ type: 'US_LIST' })).scripts?.find(s => s.id === id); if (script) check('Owned navigation script removed', (await send({ type: 'US_DELETE', id, revision: script.revision })).ok); }
    evidence.navigationProcessExit = await client.close();
    check('Owned MCP helper exits without unexpected output', !evidence.navigationProcessExit.stderr && !evidence.navigationProcessExit.stdout &&
      (evidence.navigationProcessExit.code === 0 || transport === 'http' && evidence.navigationProcessExit.signal === 'SIGTERM'));
  }
}
module.exports = { runNavigation };
