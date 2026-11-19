/* Review-gated MCP proposals end to end: a real --allow-changes process, the real
   MCP page, trusted clicks, the native userscript runtime and a blocked ad canary. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { processClient } = require('./mcp-client.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runChanges({ b, manager, send, check, until, browse, scriptSource, evidence, temp, transport = 'stdio' }) {
  const client = await processClient({ transport, allowChanges: true }), pages = [], owned = new Set();
  const name = 'MCP proposed change';
  const version = marker => scriptSource(name, '// @grant none\n', 'document.body.dataset.agentChange=' + JSON.stringify(marker) + ';').replace('http://127.0.0.1/*', 'http://127.0.0.1/mcp-change/*');
  const first = version('v1'), second = version('v2');
  const click = async (id, target) => {
    await b.front(target);
    const point = await until('(()=>{const e=document.getElementById(' + JSON.stringify(id) + ');if(!e||e.disabled)return null;e.scrollIntoView({block:"center",behavior:"instant"});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()', target);
    await b.clickAt(point.x, point.y, target);
  };
  const decided = (page, text) => until('document.getElementById("decisions").textContent.includes(' + JSON.stringify(text) + ')', page);
  const record = async id => (await send({ type: 'US_LIST' })).scripts.find(script => script.id === id);
  try {
    await client.initialize();
    const tools = (await client.request('tools/list')).result.tools;
    check('A --allow-changes server adds three review-gated tools', tools.length === 10 && tools.filter(tool => !tool.annotations.readOnlyHint).length === 2);
    const page = await b.open(await b.evaluate('(globalThis.browser||chrome).runtime.getURL("src/ui/mcp/debug.html")', manager)); pages.push(page);
    check('Change proposals are unchecked by default', await b.evaluate('!document.getElementById("shareChanges").checked', page));
    const connection = await client.tool('connection');
    check('The connection tells the agent changes need a separate approval', connection.changesOffered === true && /Propose script changes/.test(connection.instructions));
    await b.evaluate('(()=>{document.getElementById("pairingCode").value=' + JSON.stringify(connection.pairingCode) + ';for(const [id,on] of [["shareScripts",true],["shareLogs",true],["shareNetwork",false],["shareChanges",true]])document.getElementById(id).checked=on;})()', page);
    await click('connect', page);
    await require('./mcp-browser.cjs').approveMCPData(b, page, evidence);
    await until('document.getElementById("connectionBadge").textContent==="Connected · changes need your review"', page);
    check('Pending changes appear only with change approval', await b.evaluate('!document.getElementById("proposalsCard").hidden', page));

    const broken = await client.tool('propose_script', { source: scriptSource('MCP broken proposal', '// @grant none\n', 'if (') });
    check('Source with syntax errors returns diagnostics and never reaches the review', broken.ok === false && broken.diagnostics?.some(item => item.kind === 'syntax') &&
      await b.evaluate('document.querySelectorAll(".proposal").length===0', page));
    const before = JSON.stringify((await send({ type: 'US_LIST' })).scripts);
    const created = await client.tool('propose_script', { source: first, note: 'Marks the page for the offline test.' });
    const id = created.proposal?.id;
    check('A new script proposal is pending', created.ok && created.proposal.status === 'pending');
    await until('document.querySelectorAll(".proposal").length===1', page);
    check('The review shows sites, the unverified note and the exact source', await b.evaluate('(()=>{const card=document.querySelector(".proposal"),after=document.getElementById(' + JSON.stringify('after-' + id) + ');' +
      'return card.querySelector("h3").textContent===' + JSON.stringify('New script: ' + name) + '&&card.querySelector(".review-table").textContent.includes("http://127.0.0.1/mcp-change/*")' +
      '&&card.querySelector(".agent-note").textContent==="Agent’s note (unverified): Marks the page for the offline test."&&after.value===' + JSON.stringify(first) +
      '&&document.getElementById(' + JSON.stringify('before-' + id) + ').parentElement.hidden})()', page));
    check('The tab title counts pending proposals', await b.evaluate('document.title==="(1) MCP · Module Engine"', page));
    check('A proposal leaves the library untouched', JSON.stringify((await send({ type: 'US_LIST' })).scripts) === before);
    await b.evaluate('document.getElementById(' + JSON.stringify('applyEnable-' + id) + ').click()', page); await pause(300);
    check('A script-dispatched click cannot apply a proposal', (await client.tool('get_proposal', { proposalId: id })).proposal.status === 'pending' &&
      JSON.stringify((await send({ type: 'US_LIST' })).scripts) === before);

    await click('apply-' + id, page); await decided(page, 'Applied · off');
    const applied = (await client.tool('get_proposal', { proposalId: id })).proposal; owned.add(applied.scriptId);
    const saved = await record(applied.scriptId);
    check('Apply saves exactly the reviewed source, turned off', applied.status === 'applied' && saved?.source === first && saved.enabled === false && applied.revision === saved.revision);
    check('The tab title clears when nothing is pending', await b.evaluate('document.title==="MCP · Module Engine"&&document.querySelectorAll(".proposal").length===0', page));
    const off = await browse('/mcp-change/off'); pages.push(off);
    await until('document.readyState==="complete"', off); await pause(500);
    check('An applied script that stays off does not run', await b.evaluate('document.body.dataset.agentChange===undefined&&window.fixtureAd===undefined', off));

    const current = (await client.tool('get_script', { id: saved.id })).script;
    const edit = (await client.tool('propose_script', { source: second, id: saved.id, revision: current.revision })).proposal;
    await until('Boolean(document.getElementById(' + JSON.stringify('applyEnable-' + edit.id) + '))', page);
    check('An edit shows the current and proposed source side by side', await b.evaluate('document.getElementById(' + JSON.stringify('before-' + edit.id) + ').value===' + JSON.stringify(first) +
      '&&document.getElementById(' + JSON.stringify('after-' + edit.id) + ').value===' + JSON.stringify(second) + '&&!document.getElementById(' + JSON.stringify('before-' + edit.id) + ').parentElement.hidden', page));
    await click('applyEnable-' + edit.id, page); await decided(page, 'Applied · on');
    const running = await record(saved.id);
    check('Apply & enable saves and turns on the reviewed edit', running.enabled === true && running.source === second);
    const on = await browse('/mcp-change/on'); pages.push(on);
    await until('document.body.dataset.agentChange==="v2"', on);
    check('The enabled edit runs while the ad canary stays blocked', await b.evaluate('window.fixtureAd===undefined', on));

    await click('revert-' + edit.id, page); await decided(page, 'Reverted');
    const reverted = await record(saved.id);
    check('Revert restores the previous source, turned off', reverted.source === first && reverted.enabled === false);
    const latest = (await client.tool('get_script', { id: saved.id })).script;
    const enable = (await client.tool('propose_enabled', { id: saved.id, revision: latest.revision, enabled: true, note: 'Turn it back on.' })).proposal;
    await until('Boolean(document.getElementById(' + JSON.stringify('reject-' + enable.id) + '))', page);
    check('An enable proposal shows the code it would run', await b.evaluate('document.getElementById(' + JSON.stringify('after-' + enable.id) + ').value===' + JSON.stringify(first) +
      '&&document.getElementById(' + JSON.stringify('apply-' + enable.id) + ').textContent==="Turn on"', page));
    await click('reject-' + enable.id, page); await decided(page, 'Rejected');
    check('Rejecting leaves the script off', (await client.tool('get_proposal', { proposalId: enable.id })).proposal.status === 'rejected' && (await record(saved.id)).enabled === false);
    const activity = await client.tool('get_logs', { kind: 'activity', limit: 100 });
    check('The activity log records each decision', ['applied the agent’s new script', 'and turned it on', 'reverted the agent’s change', 'rejected the agent’s proposed change']
      .every(text => activity.entries?.some(entry => entry.message.startsWith('MCP: ') && entry.message.includes(text))));

    const bidiSource = scriptSource('MCP bidi \u202e review', '// @grant none\n', '// \u2066 hidden direction\ndocument.body.dataset.bidiReviewed="yes";');
    const bidi = (await client.tool('propose_script', { source: bidiSource, note: 'Unverified \u202e note' })).proposal;
    check('Bidi warnings do not become syntax errors or hide the proposal', Boolean(bidi));
    await until('Boolean(document.getElementById(' + JSON.stringify('bidi-' + bidi.id) + '))', page);
    check('MCP escapes hidden controls in source, metadata, heading and note', await b.evaluate('(()=>{const card=document.querySelector(".proposal");return !/[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/.test(card.textContent+card.querySelector("textarea[id^=after]").value)&&card.textContent.includes("U+202E")&&card.textContent.includes("column")})()', page));
    check('Apply and enable starts disabled until controls are acknowledged', await b.evaluate('document.getElementById(' + JSON.stringify('applyEnable-' + bidi.id) + ').disabled', page));
    await b.evaluate('(()=>{const e=document.getElementById(' + JSON.stringify('bidi-' + bidi.id) + ');e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));})()', page);
    check('Synthetic acknowledgment cannot unlock enabling', await b.evaluate('document.getElementById(' + JSON.stringify('applyEnable-' + bidi.id) + ').disabled&&!document.getElementById(' + JSON.stringify('bidi-' + bidi.id) + ').checked', page));
    await click('bidi-' + bidi.id, page); await click('applyEnable-' + bidi.id, page);
    await until('!document.getElementById(' + JSON.stringify('applyEnable-' + bidi.id) + ')', page);
    const bidiSaved = (await client.tool('get_proposal', { proposalId: bidi.id })).proposal; owned.add(bidiSaved.scriptId);
    check('Trusted acknowledgment enables the exact original source bytes', (await record(bidiSaved.scriptId)).source === bidiSource && (await record(bidiSaved.scriptId)).enabled);
    const bidiPage = await browse('/mcp-change/bidi'); pages.push(bidiPage);
    await until('document.body.dataset.bidiReviewed==="yes"', bidiPage);
    check('Acknowledged script runs while the local ad remains blocked', await b.evaluate('window.fixtureAd===undefined', bidiPage));
    const bidiEdit = (await client.tool('propose_script', { id: bidiSaved.scriptId, revision: (await record(bidiSaved.scriptId)).revision, source: bidiSource + '\n// changed' })).proposal;
    await until('Boolean(document.getElementById(' + JSON.stringify('bidi-' + bidiEdit.id) + '))', page);
    check('A different proposal cannot inherit acknowledgment', await b.evaluate('!document.getElementById(' + JSON.stringify('bidi-' + bidiEdit.id) + ').checked&&document.getElementById(' + JSON.stringify('applyEnable-' + bidiEdit.id) + ').disabled', page));
    await click('apply-' + bidiEdit.id, page); await until('!document.getElementById(' + JSON.stringify('apply-' + bidiEdit.id) + ')', page);
    const bidiOff = await record(bidiSaved.scriptId);
    const bidiEnable = (await client.tool('propose_enabled', { id: bidiOff.id, revision: bidiOff.revision, enabled: true })).proposal;
    await until('Boolean(document.getElementById(' + JSON.stringify('bidi-' + bidiEnable.id) + '))', page);
    check('An enable-only proposal also requires acknowledgment', await b.evaluate('document.getElementById(' + JSON.stringify('apply-' + bidiEnable.id) + ').disabled', page));
    await click('reject-' + bidiEnable.id, page); await until('!document.getElementById(' + JSON.stringify('reject-' + bidiEnable.id) + ')', page);

    // A pending card at desktop and phone widths, then revocation on disconnect.
    const layout = await client.tool('propose_script', { source: scriptSource('MCP layout proposal with a long descriptive name for wrapping checks', '// @grant GM_xmlhttpRequest\n// @connect example.test\n', '// \u202e hidden direction\nvoid 0;'),
      note: 'A long unverified explanation from the agent that has to wrap on a phone screen without widening the page. '.repeat(3).trim() });
    await until('document.querySelectorAll(".proposal").length===1', page);
    const widths = evidence.browser === 'firefox' ? [await b.evaluate('innerWidth', page)] : [1280, 390], shots = [];
    for (const width of widths) {
      if (evidence.browser !== 'firefox') await b.send('Emulation.setDeviceMetricsOverride', { width, height: 960, deviceScaleFactor: 1, mobile: false }, page);
      await b.front(page); await b.evaluate('document.querySelector(".proposal").scrollIntoView({block:"start",behavior:"instant"})', page);
      check('A pending proposal has no horizontal overflow at ' + width, await b.evaluate('document.documentElement.scrollWidth<=innerWidth+1', page));
      const output = path.join(temp, 'debug-changes-' + transport + '-' + width + '.png'); shots.push(path.basename(output));
      if (evidence.browser === 'firefox') await b.screenshot(output, page);
      else { const shot = await b.send('Page.captureScreenshot', { format: 'png' }, page); await fs.writeFile(output, Buffer.from(shot.data, 'base64')); }
    }
    if (evidence.browser !== 'firefox') await b.send('Emulation.clearDeviceMetricsOverride', {}, page);
    await click('disconnect', page);
    check('Disconnect discards pending proposals and their count', await b.evaluate('document.querySelectorAll(".proposal").length===0&&document.title==="MCP · Module Engine"', page) &&
      (await client.tool('get_proposal', { proposalId: layout.proposal.id })).ok === false);
    evidence.mcpChanges = { transport, checks: 'review-gated proposals', screenshots: shots };
  } finally {
    for (const target of pages) await b.closePage(target).catch(() => {});
    for (const scriptId of owned) { const script = await record(scriptId); if (script) check('Owned proposal script removed', (await send({ type: 'US_DELETE', id: scriptId, revision: script.revision })).ok); }
    evidence.mcpChangesExit = await client.close();
    check('Owned --allow-changes process stops without unexpected output', !evidence.mcpChangesExit.stderr && !evidence.mcpChangesExit.stdout &&
      (evidence.mcpChangesExit.code === 0 || transport === 'http' && evidence.mcpChangesExit.signal === 'SIGTERM'));
  }
}
module.exports = { runChanges };
