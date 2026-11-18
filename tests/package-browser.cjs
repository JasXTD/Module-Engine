/* The release packages load and work as extensions, offline. Builds the store
   packages with scripts/package-extension.cjs, unpacks the one for this
   browser exactly as the archive holds it, and loads that copy in a disposable
   profile: the Chromium package in Chrome or Edge, the Firefox package in
   Firefox. Checks the installed manifest, the verified protection state, native
   blocking and the extension pages.

   node tests/package-browser.cjs [chrome|edge|firefox] [--headed]

   Node 22+; no packages. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const browserName = (process.argv[2] || 'chrome').toLowerCase();
const { chromium, firefox } = require('./browser-smoke.cjs');
const { unzip } = require('../scripts/package-extension.cjs');
const root = path.resolve(__dirname, '..');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const UPDATE_URL = 'https://raw.githubusercontent.com/owner/Module-Engine/main/updates/firefox/updates.json';

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-package-${browserName}-`));
  const dist = path.join(temporary, 'dist'), extension = path.join(temporary, 'extension');
  execFileSync(process.execPath, [path.join(root, 'scripts/package-extension.cjs'), 'build', '--out', dist, '--firefox-update-url', UPDATE_URL], { stdio: 'pipe' });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const target = browserName === 'firefox' ? 'firefox' : 'chromium';
  const archive = path.join(dist, `module-engine-${manifest.version}-${target}.zip`);
  for (const [name, read] of unzip(await fs.readFile(archive))) {
    await fs.mkdir(path.dirname(path.join(extension, name)), { recursive: true });
    await fs.writeFile(path.join(extension, name), read());
  }
  const denied = [];
  const deny = http.createServer((req, res) => { denied.push(req.headers.host || req.url); res.writeHead(403, { Connection: 'close' }); res.end(); });
  deny.on('connect', (req, socket) => { denied.push(req.url); socket.on('error', () => {}); socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  deny.on('clientError', (error, socket) => socket.destroy());
  deny.listen(0, '127.0.0.1'); await once(deny, 'listening');
  const evidence = { browser: browserName, archive: path.basename(archive), temporary, checks: [], denied, startedAt: new Date().toISOString() };
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
    const installed = await browser.evaluate('api.runtime.getManifest()');
    check(installed.version === manifest.version, `the installed package reports version ${manifest.version}`);
    if (target === 'chromium') {
      check(installed.browser_specific_settings === undefined && installed.background.scripts === undefined, 'the Chromium package carries no Firefox keys');
    } else {
      // Firefox reports every manifest field it knows, with null for absent ones.
      check(installed.background.service_worker == null && installed.minimum_chrome_version == null, 'the Firefox package carries no Chrome keys');
      check(installed.browser_specific_settings.gecko.update_url === UPDATE_URL && installed.browser_specific_settings.gecko.id === manifest.browser_specific_settings.gecko.id,
        'the Firefox package keeps its add-on ID and names its update address');
    }
    const state = await send({ type: 'GET_STATE' });
    check(state.ok && !state.error, 'the packaged background verifies its protection state');
    const enabled = (await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).sort();
    check(JSON.stringify(enabled) === JSON.stringify(['ads_ruleset', 'community_ruleset', 'trackers_ruleset']), 'a new profile enables the ad, tracker and community rulesets, with Reported Threats off');
    const match = await browser.evaluate(`api.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url: 'https://doubleclick.net/test.js', type: 'script', initiator: 'https://fixture.example' })})`);
    check(match.matchedRules.length > 0, 'packaged rules block a bundled ad host');
    check(state.communityStatus.lists.length === 2 && state.communityStatus.source === 'bundled', 'the packaged list description is readable');
    const lists = await browser.open(await browser.evaluate("api.runtime.getURL('src/ui/lists/lists.html')"));
    await until('My lists', () => browser.evaluate("Boolean(settings) && document.getElementById('filterListsStatus').textContent.includes('bundled with this version')", lists));
    check(true, 'My lists loads from the package and shows the bundled filter lists');
    const manager = await browser.open(await browser.evaluate("api.runtime.getURL('src/ui/manager/manager.html')"));
    await until('Modules & scripts', () => browser.evaluate("document.readyState === 'complete' && document.querySelectorAll('h1, h2').length > 0", manager));
    check(true, 'Modules & scripts loads from the package');
    check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || (event.method === 'log.entryAdded' && event.params.level === 'error')),
      'no uncaught errors in the extension pages');
    evidence.success = true;
  } catch (error) {
    evidence.error = error.stack || String(error);
    process.exitCode = 1;
  } finally {
    if (browser) evidence.close = await browser.close().catch(error => ({ error: String(error) }));
    deny.close();
    await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, archive: evidence.archive, success: Boolean(evidence.success), checks: evidence.checks.length,
      error: evidence.error, evidence: path.join(temporary, 'evidence.json') }, null, 2));
  }
})();
