/* Filter-list updates in a real browser, offline. A loopback server stands in
   for the EasyList publishers: a copy of the extension lists its addresses as
   the sources, and it serves the bundled snapshots with a later version and a
   few real edits (tests/community-update-fixture.cjs) plus a hiding rule for the
   loopback page. Verifies that a new profile updates on its own, that the
   browser switches off exactly the dropped bundled rules and holds the added
   rules, that site hiding follows the new lists, that My lists and the popup
   show it, that Check for updates and the community switch work, and that no
   request leaves this computer.

   node tests/community-updates-browser.cjs [chrome|edge|firefox] [--headed]

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
const fixture = require('./community-update-fixture.cjs');
const root = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const NEWER = '202611171200';

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-list-updates-${browserName}-`));
  const extension = path.join(temporary, 'extension');
  for (const file of extensionFiles) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const served = { easylist: fixture.upstream('easylist', { version: NEWER }) + '\n127.0.0.1##.fresh-ad-slot\n127.0.0.1#@#.ADBAR\n', 'easylist-china': fixture.upstream('easylist-china') };
  const requests = [];
  let releaseLists;
  const pageReady = new Promise(resolve => { releaseLists = resolve; });
  const server = http.createServer(async (req, res) => {
    const list = /^\/lists\/([a-z-]+)\.txt$/.exec(req.url)?.[1];
    if (list) {
      requests.push({ list, cookie: req.headers.cookie ?? null, referer: req.headers.referer ?? null });
      await pageReady;
      if (!served[list]) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(served[list]);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><title>List fixture</title><div class="fresh-ad-slot">Fresh ad</div><div class="ADBAR">Excepted by update</div><div id="normal">Normal content</div>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  // The copy lists the loopback server as the publishers of both lists.
  const infoFile = path.join(extension, 'rules/community-info.json');
  const info = JSON.parse(await fs.readFile(infoFile, 'utf8'));
  for (const list of info.lists) list.source = `${origin}/lists/${list.id}.txt`;
  await fs.writeFile(infoFile, JSON.stringify(info, null, 2));
  const denied = [];
  const deny = http.createServer((req, res) => { denied.push(req.headers.host || req.url); res.writeHead(403, { Connection: 'close' }); res.end(); });
  deny.on('connect', (req, socket) => { denied.push(req.url); socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  deny.on('clientError', (error, socket) => socket.destroy());
  deny.listen(0, '127.0.0.1'); await once(deny, 'listening');

  const evidence = { browser: browserName, origin, temporary, checks: [], requests, denied, startedAt: new Date().toISOString() };
  const check = (condition, description) => { assert.ok(condition, description); evidence.checks.push(description); };
  let browser;
  try {
    browser = await (browserName === 'firefox' ? firefox : chromium)(extension, path.join(temporary, 'profile'), deny.address().port,
      { headless: !process.argv.includes('--headed') });
    evidence.version = browser.version;
    const until = async (description, probe, timeout = 30000) => {
      const start = Date.now();
      for (;;) {
        const value = await probe().catch(() => false);
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error('Timed out waiting for ' + description);
        await pause(150);
      }
    };
    await until('the popup state', () => browser.evaluate('typeof currentSettings !== "undefined" && currentSettings !== null && !busy'));
    const send = message => browser.evaluate(`api.runtime.sendMessage(${JSON.stringify(message)})`);
    const state = () => send({ type: 'GET_STATE' });
    const match = url => browser.evaluate(`api.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url, type: 'script', initiator: 'https://fixture.example' })})`);
    const matched = async url => (await match(url)).matchedRules.map(rule => `${rule.rulesetId}:${rule.ruleId}`);
    const disabled = async () => [...await browser.evaluate("api.declarativeNetRequest.getDisabledRuleIds({ rulesetId: 'community_ruleset' })")].sort((a, b) => a - b);
    const listIds = async () => (await browser.evaluate('api.declarativeNetRequest.getDynamicRules()')).filter(rule => rule.id > 1000000).map(rule => rule.id);

    const openPage = await browser.open(origin + '/before-update');
    const display = (page, selector) => browser.evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display`, page);
    await until('bundled generic CSS before the download', async () => (await display(openPage, '.ADBAR')) === 'none');
    check((await display(openPage, '.fresh-ad-slot')) !== 'none', 'the new site rule starts inactive');
    releaseLists();
    const installed = await until('the new profile to update its lists', async () => { const current = await state(); return current.communityStatus?.source === 'update' && current; });
    check(installed.settings.communityListUpdates === true, 'automatic filter-list updates are on in a new profile');
    check(JSON.stringify(requests.map(request => request.list).sort()) === JSON.stringify(['easylist', 'easylist-china']), 'both lists were downloaded from their listed sources');
    check(requests.every(request => request.cookie === null && request.referer === null), 'list downloads carry no cookies or referrer');
    check(installed.communityStatus.lists[0].version === NEWER && installed.communityStatus.updates.result === 'installed', 'the newer EasyList is installed');
    check(JSON.stringify(installed.communityStatus.changed) === JSON.stringify({ disabled: 2, added: 3 }), 'the change switches off 2 bundled rules and adds 3');
    check(JSON.stringify(await disabled()) === JSON.stringify([1, fixture.removedSingle.id]), 'the browser switched off exactly the bundled rules the new list dropped');
    check(JSON.stringify(await listIds()) === JSON.stringify([1000001, 1000002, 1000003]), 'the browser holds the added rules in their own ID range');
    check((await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).includes('community_ruleset'), 'the bundled community ruleset stays on');
    const neighbour = fixture.bundledRules[0].condition.requestDomains.find(host => host !== fixture.REMOVED_HOST), elsewhere = fixture.bundledRules[1].condition.requestDomains[0];
    check((await matched(`https://${fixture.ADDED_HOST}/ad.js`)).includes('_dynamic:1000002'), 'a domain added upstream is blocked');
    check(!(await matched(`https://${fixture.REMOVED_HOST}/ad.js`)).some(rule => rule.startsWith('community_ruleset:') || rule.startsWith('_dynamic:100000')), 'a domain removed upstream is no longer blocked by the lists');
    check((await matched(`https://${neighbour}/ad.js`)).includes('_dynamic:1000001'), 'the rest of its bundled chunk stays blocked through the re-added rule');
    check((await matched(`https://${elsewhere}/ad.js`)).includes('community_ruleset:2'), 'untouched bundled rules still block');
    check(!(await matched(`https://pattern.example/x${fixture.removedSingle.condition.urlFilter}1`)).includes(`community_ruleset:${fixture.removedSingle.id}`), 'a pattern removed upstream no longer matches');
    check((await matched(`https://pattern.example/x${fixture.ADDED_PATTERN}gif`)).includes('_dynamic:1000003'), 'a pattern added upstream matches');

    const page = await browser.open(origin + '/page');
    for (const tab of [openPage, page]) {
      await until('updated site hiding and generic exception', async () =>
        (await display(tab, '.fresh-ad-slot')) === 'none' && (await display(tab, '.ADBAR')) !== 'none');
      check((await display(tab, '#normal')) !== 'none', 'the updated rules apply selectively in ' + (tab === openPage ? 'an already-open page' : 'a new page'));
    }

    const lists = await browser.open(await browser.evaluate("api.runtime.getURL('src/ui/lists/lists.html')"));
    const text = id => browser.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`, lists);
    await until('My lists to show the updated lists', async () => (await text('filterListsStatus')).includes('updated: 2 bundled rules switched off, 3 added'));
    check((await text('filterListsStatus')).startsWith(`EasyList ${NEWER}, EasyList China`), 'My lists names the versions in use');
    check((await text('filterListsStatus')).includes(' and uBlock filters of 19 Nov 2026 · '), 'My lists dates the bundled uBlock filters');
    check((await text('filterListsCheck')).includes('installed newer lists'), 'My lists reports the installed update');
    check(await browser.evaluate("document.getElementById('communityListUpdates').checked", lists), 'My lists shows automatic updates on');
    const point = await browser.evaluate("(() => { const node = document.getElementById('checkFilterLists'); node.scrollIntoView({ block: 'center' }); const box = node.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2, disabled: node.disabled }; })()", lists);
    check(!point.disabled, 'Check for updates is available');
    await browser.clickAt(point.x, point.y, lists);
    await until('the check to finish', async () => (await text('filterListsCheck')).includes(': up to date.'));
    check(requests.length === 4, 'Check for updates downloads both lists again and finds them current');
    await until('the popup line', () => browser.evaluate("document.getElementById('communityStatus').textContent.includes('· updated')"));
    check(await browser.evaluate("/^EasyList \\+ EasyList China \\+ uBlock filters · [\\d,]+ rules · .+ · updated$/.test(document.getElementById('communityStatus').textContent)"), 'the popup says the lists were updated');

    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: false } } });
    check((await listIds()).length === 0 && !(await matched(`https://${fixture.ADDED_HOST}/ad.js`)).length, 'switching Community lists off removes the added rules');
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: true } } });
    check((await listIds()).length === 3 && (await matched(`https://${fixture.ADDED_HOST}/ad.js`)).includes('_dynamic:1000002'), 'switching it back on restores them without a download');
    check(requests.length === 4, 'no download while switching');

    check(!denied.some(entry => /easylist/i.test(entry)), 'no list request reached the network');
    check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || (event.method === 'log.entryAdded' && event.params.level === 'error')),
      'no uncaught errors in the extension pages');
    evidence.success = true;
  } catch (error) {
    evidence.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    releaseLists();
    if (browser) evidence.close = await browser.close().catch(error => ({ error: String(error) }));
    server.close(); deny.close();
    await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, success: Boolean(evidence.success), checks: evidence.checks.length, requests: requests.length,
      denied: denied.length, error: evidence.error, evidence: path.join(temporary, 'evidence.json') }, null, 2));
  }
})();
