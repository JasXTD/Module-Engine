/* Signed reported-threat updates in a real browser, offline. A loopback folder
   stands in for the project's update repository; a copy of the extension
   trusts only a throwaway key and checks only that folder. Verifies that a new
   profile starts with Reported Threats off and requests nothing; that turning
   it on downloads, verifies and installs the newer list as dynamic rules,
   including dropping the host the update removed; that site pauses still win;
   that the Lists page shows the installed list and its Check button works;
   that a tampered list is refused while the installed one stays; that the
   expiry switch saves the person's choice; and that no request leaves this
   computer.

   node tests/threat-updates-browser.cjs [chrome|edge|firefox] [--headed]

   Node 22+; no packages. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const browserName = (process.argv[2] || 'chrome').toLowerCase();
const { chromium, firefox } = require('./browser-smoke.cjs');
const { files: extensionFiles } = require('../scripts/extension-files.cjs');
const { keyPair, updateFolder, tamper } = require('./threat-update-fixture.cjs');
const root = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const NAMES = ['threat-evidence.json', 'threat-evidence.sig', 'threat-policy.json', 'threats.json'];

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-threat-updates-${browserName}-`));
  const extension = path.join(temporary, 'extension');
  for (const file of extensionFiles) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const key = keyPair();
  const folder = { files: updateFolder({ privateKey: key.privateKey, reviewedOn: '2026-11-17', hosts: 23 }) };
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = /^\/updates\/threats\/([a-z.-]+)$/.exec(req.url)?.[1] || null;
    requests.push({ method: req.method, name: name || req.url, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null });
    const body = name && folder.files[name];
    // The headers raw.githubusercontent.com sends for repository files.
    if (!body) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=300' });
    res.end(body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${server.address().port}`, source = `http://${host}/updates/threats/`;
  await fs.writeFile(path.join(extension, 'src/shared/update-config.js'),
    `globalThis.ModuleEngineUpdateConfig = Object.freeze({ threatSource: ${JSON.stringify(source)}, keys: Object.freeze([Object.freeze(${JSON.stringify(key.jwk)})]) });\n`);
  // This proxy never forwards anything: every request that would leave this
  // computer is refused and recorded, as in the blocker suite.
  const denied = [];
  const deny = http.createServer((req, res) => { denied.push(req.headers.host || req.url); res.writeHead(403, { Connection: 'close' }); res.end(); });
  deny.on('connect', (req, socket) => { denied.push(req.url); socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  deny.on('clientError', (error, socket) => socket.destroy());
  deny.listen(0, '127.0.0.1'); await once(deny, 'listening');

  const evidence = { browser: browserName, source, temporary, checks: [], requests, denied, startedAt: new Date().toISOString() };
  const check = (condition, description) => { assert.ok(condition, description); evidence.checks.push(description); };
  let browser;
  try {
    browser = await (browserName === 'firefox' ? firefox : chromium)(extension, path.join(temporary, 'profile'), deny.address().port,
      { headless: !process.argv.includes('--headed') });
    evidence.version = browser.version;
    const until = async (description, probe, timeout = 20000) => {
      const start = Date.now();
      for (;;) {
        const value = await probe().catch(() => false);
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + description);
        await pause(100);
      }
    };
    await until('the popup state', () => browser.evaluate('typeof currentSettings !== "undefined" && currentSettings !== null && !busy'));
    const send = message => browser.evaluate(`api.runtime.sendMessage(${JSON.stringify(message)})`);
    const state = () => send({ type: 'GET_STATE' });
    const match = url => browser.evaluate(`api.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url, type: 'script', initiator: 'https://fixture.example' })})`);
    const enabled = () => browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()');
    const updatedIds = async () => (await browser.evaluate('api.declarativeNetRequest.getDynamicRules()')).filter(rule => rule.id > 900000).map(rule => rule.id);
    const blockedByUpdate = async url => (await match(url)).matchedRules.some(rule => rule.rulesetId === '_dynamic' && rule.ruleId > 900000);
    const ids = count => Array.from({ length: count }, (_, index) => 900001 + index);

    const first = await state();
    check(first.ok && first.settings.rulesets.threats_ruleset === false, 'a new profile starts with Reported Threats off');
    check(!(await enabled()).includes('threats_ruleset'), 'the bundled reported-threat rules are not enabled on a new profile');
    check(first.threatStatus.available && first.threatStatus.source === 'bundled', 'the bundled list is current and in use');
    check(first.threatStatus.updates.configured && first.threatStatus.updates.host === host, 'the build names its update folder');
    check(await browser.evaluate('toggleThreats.checked === false && toggleThreats.disabled === false'), 'the popup offers Reported Threats as a switch that is off');
    await pause(1500);
    check(requests.length === 0, 'nothing is requested while Reported Threats is off');

    await browser.evaluate('(toggleThreats.click(), true)');
    const installed = await until('the update to install', async () => { const current = await state(); return current.threatStatus.source === 'update' && current; });
    check(installed.settings.rulesets.threats_ruleset === true, 'the popup switch turns Reported Threats on');
    check(requests[0]?.name === 'threat-evidence.sig', 'the signature is downloaded first');
    check(JSON.stringify(requests.map(request => request.name).sort()) === JSON.stringify(NAMES), 'turning the layer on downloads exactly the four update files');
    check(requests.every(request => request.method === 'GET' && request.cookie === null && request.referer === null), 'update requests carry no cookies or referrer');
    check(installed.threatStatus.reviewedAt === '2026-11-17T00:00:00Z' && installed.threatStatus.count === 23 && installed.threatStatus.updates.result === 'installed',
      'the newer signed list is installed');
    check(!(await enabled()).includes('threats_ruleset'), 'the installed list replaces the bundled ruleset');
    check(JSON.stringify(await updatedIds()) === JSON.stringify(ids(23)), 'the browser holds the 23 updated rules in their own ID range');
    const listed = JSON.parse(folder.files['threat-evidence.json']).catalog.domains.map(item => item.host);
    const bundled = JSON.parse(await fs.readFile(path.join(root, 'lists/reported-threats.json'), 'utf8')).domains.map(item => item.host);
    const dropped = bundled.filter(item => !listed.includes(item));
    check(dropped.length === 1, 'the test update leaves out one bundled host');
    for (const item of listed) check(await blockedByUpdate(`https://${item}/fixture.js`), 'the updated rule blocks ' + item);
    check((await match(`https://${dropped[0]}/fixture.js`)).matchedRules.length === 0, 'the host the update removed is no longer blocked');
    check((await match(`https://child.${listed[0]}/fixture.js`)).matchedRules.length === 0, 'updated rules still match exact hosts only');
    await send({ type: 'SET_SITE_PAUSED', domain: 'fixture.example', paused: true });
    check(!(await blockedByUpdate(`https://${listed[0]}/fixture.js`)), 'a site pause still overrides updated threat rules');
    await send({ type: 'SET_SITE_PAUSED', domain: 'fixture.example', paused: false });
    check(await blockedByUpdate(`https://${listed[0]}/fixture.js`), 'resuming the site restores them');

    const lists = await browser.open(await browser.evaluate("api.runtime.getURL('src/ui/lists/lists.html')"));
    const page = expression => browser.evaluate(expression, lists);
    const text = id => page(`document.getElementById(${JSON.stringify(id)}).textContent`);
    await until('the Lists page to show the installed list', () => page("threatEvidence?.source === 'update' && document.querySelectorAll('#threatEvidence tbody tr').length === 23"));
    check((await text('threatUpdateStatus')).startsWith(`Signed updates from ${host}, checked daily while Reported Threats is on.`) &&
      (await text('threatUpdateStatus')).includes('installed a newer list'), 'the Lists page names the update folder and the installed list');
    check((await text('threatEvidenceDates')).startsWith('Reviewed 2026-11-17') && (await text('threatEvidenceDates')).includes('signed update'),
      'the evidence shown is the installed list');
    check((await text('threatEvidenceStatus')).includes('enabled'), 'the evidence panel reports the updated rules as enabled');
    const point = await page("(() => { const node = document.getElementById('checkThreatUpdate'); node.scrollIntoView({ block: 'center' }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, disabled: node.disabled, hidden: node.closest('[hidden]') !== null }; })()");
    check(!point.disabled && !point.hidden, 'the Check for updates button is available');
    await browser.clickAt(point.x, point.y, lists);
    await until('the check to finish', async () => (await text('threatUpdateStatus')).includes(': up to date.'));
    check(requests.length === 8, 'Check for updates downloads the folder again and finds the list current');

    folder.files = tamper(updateFolder({ privateKey: key.privateKey, reviewedOn: '2026-11-18', hosts: 22 }), 'threats.json');
    const refused = await send({ type: 'CHECK_THREAT_UPDATE' });
    check(refused.ok && refused.threatStatus.updates.result === 'error' && /does not match/.test(refused.threatStatus.updates.error), 'a tampered newer list is refused');
    check(refused.threatStatus.reviewedAt === '2026-11-17T00:00:00Z' && JSON.stringify(await updatedIds()) === JSON.stringify(ids(23)), 'the installed list stays in use');
    await until('the Lists page to report the failure', async () => (await text('threatUpdateStatus')).includes('failed: '));
    check(true, 'the Lists page reports the failed check');

    folder.files = updateFolder({ privateKey: key.privateKey, reviewedOn: '2026-11-18', hosts: 22 });
    const next = await send({ type: 'CHECK_THREAT_UPDATE' });
    check(next.threatStatus.updates.result === 'installed' && next.threatStatus.count === 22 && JSON.stringify(await updatedIds()) === JSON.stringify(ids(22)),
      'a valid newer list replaces it');
    await until('the Lists page to show the newer list', () => page("document.querySelectorAll('#threatEvidence tbody tr').length === 22"));
    check(true, 'the Lists page follows the newer list');

    // The expiry switch, clicked for real. What happens at the expiry date is
    // covered by the unit tests, which control the clock.
    const expirySwitch = () => page("(() => { const node = document.getElementById('retireExpiredThreats'); node.scrollIntoView({ block: 'center' }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, checked: node.checked, disabled: node.disabled }; })()");
    const usableSwitch = () => until('the expiry switch to be usable', async () => { const current = await expirySwitch(); return !current.disabled && current; });
    // The page disables its switches while a protection check runs, and the
    // update just installed starts checks of its own. A click that lands fires
    // `change` at once, so only a click that fired nothing is repeated. The
    // page's own handler redraws the switch from the saved settings before
    // later listeners run, so the events are counted, not read.
    await page("(window.__expiryChanges = 0, document.getElementById('retireExpiredThreats').addEventListener('change', () => window.__expiryChanges++), true)");
    const setExpirySwitch = async on => {
      for (let attempt = 1; ; attempt++) {
        const before = await page('window.__expiryChanges');
        const box = await usableSwitch();
        await browser.clickAt(box.x, box.y, lists);
        if (await until('the click to land', () => page(`window.__expiryChanges > ${before}`), 2000).catch(() => false)) break;
        if (attempt === 3) throw new Error('Three clicks on the expiry switch did not land');
      }
      await until('the choice to save', () => page(`!busy && settings.retireExpiredThreats === ${on} && document.getElementById('retireExpiredThreats').checked === ${on}`));
    };
    const initial = await usableSwitch();
    check(!initial.checked && (await state()).settings.retireExpiredThreats === false, 'the expiry switch is off in a new profile and can be changed');
    await setExpirySwitch(true);
    const retiring = await state();
    check(retiring.settings.retireExpiredThreats === true && retiring.threatStatus.retireAt === retiring.threatStatus.expiresAt && retiring.threatStatus.available,
      'turning it on saves the choice and sets the list to stop at its expiry date');
    check(JSON.stringify(await updatedIds()) === JSON.stringify(ids(22)), 'before that date the rules stay in place');
    await setExpirySwitch(false);
    const keeping = await state();
    check(keeping.threatStatus.retireAt === null && keeping.threatStatus.available && JSON.stringify(await updatedIds()) === JSON.stringify(ids(22)),
      'turning it off keeps the list until a newer one replaces it');

    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { threats_ruleset: false } } });
    check((await updatedIds()).length === 0 && !(await enabled()).includes('threats_ruleset'), 'switching Reported Threats off removes the updated rules');
    const before = requests.length;
    await send({ type: 'GET_STATE' }); await pause(1000);
    check(requests.length === before, 'no check runs while the layer is off');
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { threats_ruleset: true } } });
    check(JSON.stringify(await updatedIds()) === JSON.stringify(ids(22)), 'switching it back on restores the installed list without a download');

    const threatHosts = new Set([...bundled, ...listed]);
    check(!denied.some(entry => [...threatHosts].some(item => entry.includes(item))), 'no reported host was requested');
    check(!denied.some(entry => entry.includes('raw.githubusercontent.com')), 'nothing was fetched from a real update address');
    check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || (event.method === 'log.entryAdded' && event.params.level === 'error')),
      'no uncaught errors in the extension pages');
    evidence.success = true;
  } catch (error) {
    evidence.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (browser) evidence.close = await browser.close().catch(error => ({ error: String(error) }));
    server.close(); deny.close();
    await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, success: Boolean(evidence.success), checks: evidence.checks.length, requests: requests.length,
      denied: denied.length, error: evidence.error, evidence: path.join(temporary, 'evidence.json') }, null, 2));
  }
})();
