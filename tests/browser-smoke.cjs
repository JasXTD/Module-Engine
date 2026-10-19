/* Real-browser integration checks. Node 22+; no packages or personal profiles. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const browserName = (process.argv[2] || 'chrome').toLowerCase();
const executables = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  firefox: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
};
const executable = process.env.BLOCKADS_TEST_BROWSER || executables[browserName];
if (!executable) throw new Error('Choose chrome, edge or firefox.');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const defaults = { enabled: true, cosmeticFiltering: true,
  rulesets: { ads_ruleset: true, trackers_ruleset: true, threats_ruleset: true },
  customBlockedDomains: [], whitelistedDomains: [] };

function protocol(write) {
  let next = 0;
  let closed = false;
  const pending = new Map();
  const events = [];
  return {
    events,
    receive(message) {
      if (!message.id) { events.push(message); return; }
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(JSON.stringify(message)));
      else item.resolve(message.result);
    },
    send(method, params = {}, sessionId) {
      if (closed) return Promise.reject(new Error('Browser connection closed'));
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 20000);
        pending.set(id, { resolve, reject, timer });
        write({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      });
    },
    close() {
      closed = true;
      for (const { timer, reject } of pending.values()) { clearTimeout(timer); reject(new Error('Browser connection closed')); }
      pending.clear();
    }
  };
}

async function chromium(extension, profile, denyPort, { headless = true } = {}) {
  // Edge may exit its launcher and relaunch for Windows compatibility handling.
  // A pipe belongs to the exited launcher; a loopback endpoint survives relaunch.
  const useSocket = browserName === 'edge';
  const child = spawn(executable, [
    ...(headless ? ['--headless=new'] : ['--window-size=1280,900']),
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--enable-unsafe-extension-debugging',
    '--disable-quic', '--dns-prefetch-disable',
    `--proxy-server=http://127.0.0.1:${denyPort}`, '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1, EXCLUDE [::1]',
    ...(useSocket ? ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'] : ['--remote-debugging-pipe']),
    `--user-data-dir=${profile}`, 'about:blank'
  ], { windowsHide: true, stdio: useSocket ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  let rpc, socket, browserPid, spawnError;
  child.on('error', error => { spawnError = error; rpc?.close(); });
  if (!useSocket) {
    rpc = protocol(message => child.stdio[3].write(JSON.stringify(message) + '\0'));
    let buffer = '';
    child.stdio[4].on('data', chunk => {
      buffer += chunk.toString();
      let boundary;
      while ((boundary = buffer.indexOf('\0')) >= 0) {
        const message = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        if (message) rpc.receive(JSON.parse(message));
      }
    });
    child.stdio[3].on('error', () => rpc.close());
    child.on('exit', () => rpc.close());
  }
  const processAlive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  };
  const ownedEdgePids = async () => {
    // Also covers a relaunch that happens before CDP becomes usable. Match the
    // exact fresh profile argument, never all Edge processes or a path prefix.
    const script = String.raw`
      $ErrorActionPreference = 'Stop'
      $escaped = [regex]::Escape($env:BLOCKADS_TEST_PROFILE)
      $pattern = '(?:^|\s)--user-data-dir=(?:"' + $escaped + '"|' + $escaped + ')(?:\s|$)'
      $matches = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
        Where-Object { $_.CommandLine -match $pattern } | ForEach-Object { [int]$_.ProcessId })
      ConvertTo-Json -InputObject $matches -Compress
    `;
    const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, env: { ...process.env, BLOCKADS_TEST_PROFILE: profile } },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    const pids = JSON.parse(output);
    if (!Array.isArray(pids) || pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error('Invalid isolated Edge process inventory');
    return pids;
  };
  const close = async () => {
    if (rpc) await rpc.send('Browser.close').catch(() => {});
    socket?.close();
    const pid = browserPid || child.pid;
    for (let i = 0; i < 50 && pid && processAlive(pid); i++) await pause(100);
    let forced = false;
    const remaining = useSocket ? await ownedEdgePids() : pid && processAlive(pid) ? [pid] : [];
    for (const ownedPid of remaining) {
      if (!processAlive(ownedPid)) continue;
      forced = true;
      await new Promise((resolve, reject) => execFile('taskkill.exe', ['/PID', String(ownedPid), '/T', '/F'],
        { windowsHide: true }, error => error && processAlive(ownedPid) ? reject(error) : resolve()));
    }
    rpc?.close();
    const leftoverPids = useSocket ? await ownedEdgePids() : [];
    return { browserPid: pid, forced, leftoverPids, closed: (!pid || !processAlive(pid)) && !leftoverPids.length };
  };
  try {
    if (useSocket) {
      let endpoint;
      for (let i = 0; i < 200; i++) {
        if (spawnError) throw spawnError;
        try {
          const lines = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
          if (!/^\d+$/.test(lines[0]) || Number(lines[0]) < 1 || Number(lines[0]) > 65535 ||
              !/^\/devtools\/browser\/[a-z0-9-]+$/.test(lines[1])) throw new Error('Invalid private debugging endpoint');
          endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
          break;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`Edge launcher exited ${child.exitCode}`);
        // A successful launcher exit is not browser termination: wait for the
        // private profile's relaunched browser, keeping the deny proxy running.
        await pause(100);
      }
      if (!endpoint) throw new Error('Edge did not publish its private debugging endpoint');
      socket = new WebSocket(endpoint);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('Edge debugging connection timed out')); }, 5000);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Edge debugging connection failed')); }, { once: true });
      });
      rpc = protocol(message => socket.send(JSON.stringify(message)));
      socket.addEventListener('message', event => rpc.receive(JSON.parse(event.data)));
      socket.addEventListener('close', () => rpc.close());
    }
    if (spawnError) throw spawnError;
    const version = await rpc.send('Browser.getVersion');
    const processes = await rpc.send('SystemInfo.getProcessInfo');
    browserPid = processes.processInfo.find(item => item.type === 'browser')?.id;
    if (!Number.isInteger(browserPid) || browserPid <= 0) throw new Error('Browser did not identify its process');
    const { id } = await rpc.send('Extensions.loadUnpacked', { path: extension });
    const attach = async url => {
      const { targetId } = await rpc.send('Target.createTarget', { url });
      const { sessionId } = await rpc.send('Target.attachToTarget', { targetId, flatten: true });
      await rpc.send('Runtime.enable', {}, sessionId);
      return { id: targetId, session: sessionId };
    };
    const popup = await attach(`chrome-extension://${id}/popup.html`);
    const { targetInfos } = await rpc.send('Target.getTargets');
    for (const target of targetInfos.filter(info => info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${id}/`))) {
      const worker = await rpc.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      await rpc.send('Runtime.enable', {}, worker.sessionId);
    }
    const evaluate = async (expression, target = popup) => {
      const result = await rpc.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, target.session);
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    return {
      version, id, popup, evaluate, open: attach, close, events: rpc.events,
      send: (method, params, target) => rpc.send(method, params, target?.session),
      launch: { transport: useSocket ? 'loopback-websocket' : 'pipe', launcherPid: child.pid, browserPid, relaunched: child.pid !== browserPid },
      async screenshot(file) {
        await rpc.send('Emulation.setDeviceMetricsOverride', { width: 350, height: 600, deviceScaleFactor: 1, mobile: false }, popup.session);
        await rpc.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, popup.session);
        const { cssContentSize } = await rpc.send('Page.getLayoutMetrics', {}, popup.session);
        const result = await rpc.send('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: 350, height: cssContentSize.height, scale: 1 }
        }, popup.session);
        await fs.writeFile(file, Buffer.from(result.data, 'base64'));
      },
      async navigate(target, url) { await rpc.send('Page.navigate', { url }, target.session); },
      stderr: () => stderr
    };
  } catch (error) { await close(); error.message += `\nBrowser exit ${child.exitCode}: ${stderr}`; throw error; }
}

async function firefox(extension, profile, denyPort) {
  const uuid = 'd73f30ed-9a72-486f-84f7-8a1d16be7021';
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'blockads-shield@local.extension': uuid }))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("extensions.dnr.feedback", true);',
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "127.0.0.1");',
    `user_pref("network.proxy.http_port", ${denyPort});`,
    'user_pref("network.proxy.ssl", "127.0.0.1");',
    `user_pref("network.proxy.ssl_port", ${denyPort});`,
    'user_pref("network.proxy.no_proxies_on", "localhost,127.0.0.1,::1");',
    'user_pref("network.proxy.failover_direct", false);',
    'user_pref("network.dns.disablePrefetch", true);',
    'user_pref("network.prefetch-next", false);',
    'user_pref("network.predictor.enabled", false);',
    'user_pref("network.http.speculative-parallel-limit", 0);',
    'user_pref("network.trr.mode", 5);',
    'user_pref("network.http.http3.enable", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("toolkit.telemetry.enabled", false);'
  ].join('\n'));
  const child = spawn(executable, ['--headless', '--no-remote', '--profile', profile,
    '--remote-allow-system-access', '--remote-debugging-port', '0', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let socket, rpc;
  const close = async () => {
    if (rpc) await rpc.send('browser.close').catch(() => {});
    socket?.close();
    for (let i = 0; i < 50 && child.exitCode === null; i++) await pause(100);
    if (child.exitCode === null) child.kill();
    rpc?.close();
  };
  try {
    const endpoint = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Firefox BiDi startup timed out')), 20000);
      const read = data => {
        stderr += data;
        const match = stderr.match(/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      };
      child.stderr.on('data', read); child.stdout.on('data', read);
      child.once('error', reject);
    });
    socket = new WebSocket(endpoint + '/session');
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    rpc = protocol(message => socket.send(JSON.stringify(message)));
    socket.addEventListener('message', event => rpc.receive(JSON.parse(event.data)));
    const session = await rpc.send('session.new', { capabilities: { alwaysMatch: {} } });
    await rpc.send('session.subscribe', { events: ['log.entryAdded'] });
    await rpc.send('webExtension.install', { extensionData: { type: 'path', path: extension } });
    const { contexts } = await rpc.send('browsingContext.getTree');
    const popup = { id: contexts[0].context };
    const navigate = (target, url) => rpc.send('browsingContext.navigate', { context: target.id, url, wait: 'complete' });
    await navigate(popup, `moz-extension://${uuid}/popup.html`);
    const evaluate = async (expression, target = popup) => {
      const result = await rpc.send('script.evaluate', {
        expression: `(async () => JSON.stringify(await (${expression})))()`,
        target: { context: target.id }, awaitPromise: true
      });
      if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.type === 'undefined' ? undefined : JSON.parse(result.result.value);
    };
    return {
      version: session.capabilities, id: uuid, popup, evaluate, navigate, close, events: rpc.events,
      async open(url) {
        const { context } = await rpc.send('browsingContext.create', { type: 'tab' });
        const target = { id: context }; await navigate(target, url); return target;
      },
      async screenshot(file) {
        // Firefox BiDi does not support screenshots of privileged extension
        // contexts. Popup behavior is asserted through its DOM; Chromium supplies
        // the rendered 350px screenshots for visual review.
        return { unavailable: 'Firefox extension context screenshot unsupported' };
      },
      stderr: () => stderr
    };
  } catch (error) { await close(); throw error; }
}

async function until(browser, expression, target) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < 15000) {
    try { if (await browser.evaluate(expression, target)) return; } catch (error) { lastError = error; }
    await pause(50);
  }
  throw new Error(`Condition timed out: ${expression}${lastError ? '\n' + lastError : ''}`);
}

module.exports = { chromium, firefox };

if (require.main === module) (async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-verify-${browserName}-`));
  const extension = path.join(temporary, 'extension');
  await fs.mkdir(extension);
  for (const file of ['manifest.json', 'shared.js', 'background.js', 'content.js', 'youtube.js', 'popup.js', 'popup.html', 'popup.css', 'log.html', 'log.js', 'log.css', 'rules', 'icons']) {
    await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  }
  const testedManifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const sourceHashes = {};
  for (const file of ['manifest.json', 'shared.js', 'background.js', 'content.js', 'youtube.js', 'popup.js', 'popup.html', 'popup.css', 'log.html', 'log.js', 'log.css', 'rules/threat-policy.json',
    ...testedManifest.declarative_net_request.rule_resources.map(rule => rule.path)]) {
    sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  }
  const requests = [];
  // This proxy never resolves or forwards a destination. Every non-loopback
  // request from the isolated browser profile is rejected here, including CONNECT.
  const denied = [];
  const proxyErrors = [];
  let proxyPeerResets = 0;
  const onProxyError = error => {
    // Edge may abort a background CONNECT as soon as the deny response arrives.
    // An expected peer reset must not crash Node and strand the isolated browser.
    if (error.code === 'ECONNRESET') proxyPeerResets++;
    else proxyErrors.push({ code: error.code, message: error.message });
  };
  const denyProxy = http.createServer((req, res) => {
    denied.push({ method: req.method, destination: req.headers.host });
    res.writeHead(403, { Connection: 'close' }); res.end('Offline browser test');
  });
  denyProxy.on('connect', (req, socket) => {
    socket.on('error', onProxyError);
    denied.push({ method: 'CONNECT', destination: req.url });
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  denyProxy.on('clientError', (error, socket) => { onProxyError(error); socket.destroy(); });
  denyProxy.listen(0, '127.0.0.1'); await once(denyProxy, 'listening');
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/html');
    const frame = req.url === '/fixture'
      ? `<iframe id="child" src="http://localhost:${server.address().port}/frame"></iframe>
         <script>window.frameDisplay = () => new Promise(resolve => {
           const target = document.getElementById('child').contentWindow;
           const timer = setTimeout(() => { removeEventListener('message', receive); resolve(null); }, 250);
           const receive = event => { if (event.source === target && event.data?.kind === 'display') {
             clearTimeout(timer); removeEventListener('message', receive); resolve(event.data.value);
           }};
           addEventListener('message', receive); target.postMessage('measure', '*');
         });</script>`
      : `<script>addEventListener('message', event => {
           if (event.data === 'measure') event.source.postMessage({kind:'display',value:getComputedStyle(document.getElementById('ad')).display}, event.origin);
         });</script>`;
    res.end(`<!doctype html><html><head><title>BlockAds local fixture</title></head><body><div id="ad" class="ad-slot">Ad fixture</div><div id="normal">Normal content</div><div id="fandom-lookalike" class="fandom-ad-wrapper">Unrelated site content</div><ytd-ad-slot-renderer id="youtube-lookalike">Unrelated site content</ytd-ad-slot-renderer>${frame}</body></html>`);
  });
  const socketUpgrades = [];
  server.on('upgrade', (req, socket) => {
    socketUpgrades.push(req.url);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('error', () => {});
    socket.on('data', () => socket.end(Buffer.from([0x88, 0x00])));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;
  const evidence = { browser: browserName, temporary, sourceHashes, checks: [], startedAt: new Date().toISOString() };
  let browser;
  const check = (condition, description) => { assert.ok(condition, description); evidence.checks.push(description); };
  try {
    browser = await (browserName === 'firefox' ? firefox : chromium)(extension, path.join(temporary, 'profile'), denyProxy.address().port);
    evidence.version = browser.version;
    if (browser.launch) evidence.launch = browser.launch;
    await until(browser, 'typeof currentSettings !== "undefined" && currentSettings !== null && !busy');
    const send = message => browser.evaluate(`api.runtime.sendMessage(${JSON.stringify(message)})`);
    const state = () => send({ type: 'GET_STATE' });
    const match = (url, type = 'script', initiator = 'https://fixture.example') => browser.evaluate(
      `api.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url, type, initiator })})`);
    check((await state()).ok, 'unmodified extension loads and reports verified state');
    check(!(await browser.evaluate('errorPanel.hidden === false')), 'popup has no startup error');
    check((await match('https://doubleclick.net/test.js')).matchedRules.length > 0, 'bundled ad request matches');
    check((await match('https://customer.azioncdn.net/app.js')).matchedRules.length === 0, 'shared CDN customer is allowed');
    check((await match('https://legitimate.example.tk/app.js')).matchedRules.length === 0, 'country-code TLD is not blanket blocked');
    check((await match('https://fixture.example/ordinary.js')).matchedRules.length === 0, 'ordinary resource is allowed');
    const pageScripts = () => browser.evaluate('api.scripting.getRegisteredContentScripts()');
    const [youtubeScript] = await pageScripts();
    evidence.youtubeScript = youtubeScript;
    check(youtubeScript?.id === 'youtube-ads' && youtubeScript.world === 'MAIN' && youtubeScript.runAt === 'document_start' &&
      youtubeScript.matches.includes('*://*.youtube.com/*'), 'YouTube page filter is registered in the page world at document start');
    await send({ type: 'SET_SITE_PAUSED', domain: 'www.youtube.com', paused: true });
    check((await pageScripts())[0]?.excludeMatches?.includes('*://*.youtube.com/*'), 'pausing YouTube excludes it from the page filter');
    await send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: false });
    check(!(await pageScripts())[0]?.excludeMatches?.length, 'resuming YouTube restores the page filter');

    const threatHosts = JSON.parse(await fs.readFile(path.join(root, 'lists/reported-threats.json'), 'utf8')).domains.map(entry => entry.host);
    const threatState = await state();
    check(threatState.threatStatus.available && threatState.threatStatus.count === threatHosts.length, 'dated threat policy is current and active');
    const probes = threatHosts.flatMap(host => [
      ['https://' + host + '/fixture.js', 'script', true],
      ['http://' + host + ':8080/fixture', 'main_frame', true],
      ['ws://' + host + '/fixture', 'websocket', true],
      ['wss://' + host + ':8443/fixture', 'websocket', true],
      ['https://' + host.toUpperCase() + './fixture', 'sub_frame', true],
      ['https://user:pass@' + host + '/fixture', 'xmlhttprequest', true],
      ['https://child.' + host + '/fixture', 'script', false],
      ['https://' + host + '.example/fixture', 'script', false],
      ['https://prefix' + host + '/fixture', 'script', false]
    ]);
    // Browser DNR's test API receives inert strings. No navigation, DNS, fetch,
    // scanner submission or connection is made to any reported hostname.
    const outcomes = await browser.evaluate(`(async () => {
      const outcomes = [];
      for (const [url,type,expected] of ${JSON.stringify(probes)}) {
        // Firefox's simulator rejects ws(s) URIs before rule evaluation. Use
        // the HTTP(S) handshake representation there, and verify real loopback
        // WebSocket enforcement below. Preserve both URLs in the evidence.
        const testedUrl = ${JSON.stringify(browserName)} === 'firefox' && type === 'websocket'
          ? url.replace(/^ws/, 'http') : url;
        const result = await api.declarativeNetRequest.testMatchOutcome({url:testedUrl,type,initiator:'https://fixture.example'});
        outcomes.push({url,testedUrl,type,expected,blocked:result.matchedRules.some(rule=>rule.rulesetId==='threats_ruleset')});
      }
      return outcomes;
    })()`);
    evidence.threatProbes = outcomes;
    for (const outcome of outcomes) check(outcome.blocked === outcome.expected, `exact threat scope: ${outcome.type} ${outcome.url}`);
    for (const host of ['workers.dev', 'another-tenant.workers.dev', 'kmjukilo-lkjh.workers.dev', 'gitprogram.com', 'shinewrist.net',
      'aurexdefense.online', 'cyclokinetics.online', 'sncorp.fit']) {
      check((await match('https://' + host + '/fixture')).matchedRules.length === 0, 'unlisted parent, tenant or suspected host is allowed: ' + host);
    }
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { threats_ruleset: false } } });
    check((await match('https://' + threatHosts[0] + '/fixture')).matchedRules.length === 0, 'reported-threat switch disables its rules');
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { threats_ruleset: true } } });
    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
    check((await match('https://' + threatHosts[0] + '/fixture')).matchedRules.length === 0, 'master pause disables reported threats');
    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: true, whitelistedDomains: ['fixture.example'] } });
    const exception = await match('https://' + threatHosts[0] + '/fixture');
    check(exception.matchedRules.some(rule => rule.rulesetId === '_dynamic') &&
      !exception.matchedRules.some(rule => rule.rulesetId === 'threats_ruleset'), 'explicit site pause overrides reported-threat blocking');
    await send({ type: 'UPDATE_SETTINGS', patch: defaults });
    check(!denied.some(request => threatHosts.some(host => request.destination?.includes(host))), 'no reported-host request reached the deny proxy');

    evidence.dnrRoundTrip = await browser.evaluate(`(async () => {
      const rule = {id:1,priority:50,action:{type:'block'},condition:{requestDomains:['roundtrip.example'],resourceTypes:['script']}};
      await api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[],addRules:[rule]});
      const returned = await api.declarativeNetRequest.getDynamicRules();
      await api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[1],addRules:[]});
      return {sent:rule,returned};
    })()`);

    const concurrent = await browser.evaluate(`Promise.all([
      api.runtime.sendMessage({type:'UPDATE_SETTINGS',patch:{rulesets:{ads_ruleset:false}}}),
      api.runtime.sendMessage({type:'UPDATE_SETTINGS',patch:{rulesets:{trackers_ruleset:false}}}),
      api.runtime.sendMessage({type:'ADD_CUSTOM_DOMAIN',domain:'one.example'}),
      api.runtime.sendMessage({type:'ADD_CUSTOM_DOMAIN',domain:'two.example'})])`);
    const changed = await state();
    evidence.concurrent = { responses: concurrent, state: changed };
    check(concurrent.every(item => item.ok) && !changed.settings.rulesets.ads_ruleset && !changed.settings.rulesets.trackers_ruleset,
      'simultaneous switch updates both persist');
    check((await pageScripts()).length === 0, 'ad switch removes the YouTube page filter');
    check(changed.settings.customBlockedDomains.length === 2, 'simultaneous domain additions both persist');
    check((await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'bücher.example' })).ok, 'IDN is accepted as punycode');
    check((await match('https://xn--bcher-kva.example/file.js')).matchedRules.length > 0, 'IDN request is actually matched');
    check(!(await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'bad^example.test' })).ok, 'invalid domain returns failure');
    check((await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'valid.example' })).ok, 'valid edit succeeds after rejection');

    await send({ type: 'UPDATE_SETTINGS', patch: { ...defaults, whitelistedDomains: ['example.test', 'shop.example.test'] } });
    const allowed = await match('https://shop.example.test/', 'main_frame');
    check(allowed.matchedRules.some(rule => rule.rulesetId === '_dynamic'), 'parent exception applies to subdomain');
    await until(browser, '!busy && currentSettings.whitelistedDomains.includes("example.test") && Object.values(currentSettings.rulesets).every(Boolean)');
    await browser.evaluate('(activeHostname = "shop.example.test", currentDomainEl.textContent = activeHostname, renderUI(), true)');
    check((await browser.evaluate('siteWhitelistBtn.textContent')).includes('example.test'), 'popup identifies inherited parent exception');
    await browser.screenshot(path.join(temporary, 'popup-inherited.png'));
    await browser.evaluate('(siteWhitelistBtn.click(), true)');
    await until(browser, '!busy && currentSettings.whitelistedDomains.length === 0');
    check((await state()).settings.whitelistedDomains.length === 0, 'resume button removes matching parent and child exceptions');

    await browser.evaluate('(customDomainInput.value = "invalid^domain.test", customBlockForm.requestSubmit(), true)');
    await until(browser, '!busy && !errorPanel.hidden');
    check(await browser.evaluate('customDomainInput.value === "invalid^domain.test" && statusText.textContent === "Check protection status"'),
      'popup visibly reports rejection and preserves entered text');
    await browser.screenshot(path.join(temporary, 'popup-error.png'));
    await browser.evaluate('(retryButton.click(), true)');
    await until(browser, '!busy && errorPanel.hidden');

    const longDomain = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.example';
    await send({ type: 'UPDATE_SETTINGS', patch: { whitelistedDomains: [longDomain], customBlockedDomains: [longDomain] } });
    await until(browser, `!busy && currentSettings.whitelistedDomains.includes(${JSON.stringify(longDomain)})`);
    await browser.evaluate(`(activeHostname = ${JSON.stringify(longDomain)}, currentDomainEl.textContent = activeHostname, renderUI(), true)`);
    await browser.screenshot(path.join(temporary, 'popup-long-domain.png'));
    check(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth && siteWhitelistBtn.getBoundingClientRect().right <= innerWidth'),
      'long inherited and custom domains fit the popup width');
    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
    await until(browser, '!busy && !currentSettings.enabled');
    check(await browser.evaluate('toggleAds.disabled && toggleTrackers.disabled && toggleCosmetic.disabled && siteWhitelistBtn.disabled && !masterToggle.disabled'),
      'paused state disables dependent switches and keeps master control usable');
    await browser.screenshot(path.join(temporary, 'popup-paused.png'));
    await send({ type: 'UPDATE_SETTINGS', patch: defaults });
    await until(browser, '!busy && currentSettings.enabled && currentSettings.whitelistedDomains.length === 0');

    const page = await browser.open(fixtureUrl);
    await until(browser, 'document.getElementById("ad") && getComputedStyle(document.getElementById("ad")).display === "none"', page);
    check(await browser.evaluate('getComputedStyle(document.getElementById("normal")).display !== "none"', page), 'cosmetic filter hides ad fixture and preserves ordinary content');
    check(await browser.evaluate('getComputedStyle(document.getElementById("fandom-lookalike")).display !== "none"', page),
      'Fandom-specific cosmetic rule preserves similarly named content on other sites');
    check(await browser.evaluate('getComputedStyle(document.getElementById("youtube-lookalike")).display !== "none"', page),
      'YouTube-specific cosmetic rule preserves similarly named content on other sites');
    check(await browser.evaluate("fetch('https://blockads-network-guard.invalid/probe').then(() => false, () => true)", page),
      'non-loopback canary request is rejected by the isolated profile');
    check(denied.some(entry => entry.destination === 'blockads-network-guard.invalid:443'),
      'deny proxy confirms the canary was rejected without DNS lookup or forwarding');
    await until(browser, 'document.getElementById("child") && window.frameDisplay().then(value => value === "none")', page);
    check(true, 'cosmetic filter also applies inside a cross-origin frame');
    await send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: false } });
    await until(browser, 'getComputedStyle(document.getElementById("ad")).display !== "none"', page);
    check(true, 'cosmetic toggle updates an already-open page');
    await send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: true } });
    await until(browser, 'getComputedStyle(document.getElementById("ad")).display === "none"', page);
    await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: true });
    await until(browser, 'getComputedStyle(document.getElementById("ad")).display !== "none"', page);
    check(true, 'site pause removes cosmetic filtering immediately');
    await until(browser, 'window.frameDisplay().then(value => value !== null && value !== "none")', page);
    check(true, 'site pause also clears cosmetic filtering in cross-origin frames');
    await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: false });
    const socketProbe = endpoint => browser.evaluate(`new Promise((resolve, reject) => {
      const socket = new WebSocket('ws://localhost:${server.address().port}/${endpoint}');
      const timer = setTimeout(() => { socket.close(); reject(new Error('Loopback WebSocket timed out')); }, 5000);
      socket.onopen = () => { clearTimeout(timer); socket.close(); resolve(true); };
      socket.onerror = () => { clearTimeout(timer); resolve(false); };
    })`, page);
    check(await socketProbe('ws-control'), 'real loopback WebSocket control connects');
    const socketRule = JSON.parse(await fs.readFile(path.join(root, 'rules/threats.json'), 'utf8'))[0];
    socketRule.id = 9001;
    socketRule.condition.regexFilter = socketRule.condition.regexFilter.replace(threatHosts[0].replaceAll('.', '\\.'), 'localhost');
    socketRule.condition.resourceTypes = ['websocket'];
    await browser.evaluate(`api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[],addRules:[${JSON.stringify(socketRule)}]})`);
    check(!(await socketProbe('ws-blocked')) && !socketUpgrades.includes('/ws-blocked'), 'reported-rule regex blocks a real loopback WebSocket before handshake');
    await browser.evaluate('api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[9001],addRules:[]})');
    check(await socketProbe('ws-blocked'), 'removing the isolated regex rule restores the WebSocket handshake');
    evidence.socketUpgrades = socketUpgrades;
    await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'localhost' });
    const fetchExpression = `fetch('http://localhost:${server.address().port}/blocked-probe').then(() => false, () => true)`;
    check(await browser.evaluate(fetchExpression, page), 'custom domain blocks a real local network request');
    check(!requests.includes('/blocked-probe'), 'blocked local request never reaches the fixture server');
    // Firefox has no rule-match feed for extensions, so its log lists events only.
    if (browserName === 'firefox') {
      check((await send({ type: 'GET_LOG' })).blockLogging === false, 'Firefox log reports that blocked requests are unavailable');
    } else {
      await until(browser, `api.runtime.sendMessage({type:'GET_LOG'}).then(log => log.ok && log.entries.some(entry =>
        entry.kind === 'blocked' && entry.host === 'localhost' && entry.path === '/blocked-probe' && entry.layer === 'Custom block'))`);
      check(true, 'activity log records the blocked request with its layer and path');
    }
    check((await send({ type: 'GET_LOG' })).entries.some(entry => entry.message === 'Custom block added localhost'), 'activity log records the settings change');
    const logPage = await browser.open(`${browserName === 'firefox' ? 'moz' : 'chrome'}-extension://${browser.id}/log.html`);
    if (browserName === 'firefox') {
      await until(browser, `[...document.querySelectorAll('#entryTable tbody td')].some(cell => cell.textContent === 'Custom block added localhost')`, logPage);
      check(await browser.evaluate(`!document.getElementById('notice').hidden && !document.getElementById('notice').classList.contains('error') &&
        document.documentElement.scrollWidth <= innerWidth`, logPage), 'Firefox log page lists events and explains missing block entries');
    } else {
      await until(browser, `[...document.querySelectorAll('#summaryTable tbody td')].some(cell => cell.textContent === 'localhost')`, logPage);
      check(await browser.evaluate(`document.getElementById('notice').hidden && document.documentElement.scrollWidth <= innerWidth`, logPage),
        'activity log page shows the blocked server without errors or horizontal overflow');
    }
    check(await browser.evaluate('document.getElementById("logLink").getAttribute("href") === "log.html"'), 'popup links to the activity log');

    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
    check((await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).length === 0, 'master pause disables all static rules');
    check((await browser.evaluate('api.declarativeNetRequest.getDynamicRules()')).length === 0, 'master pause disables all dynamic rules');
    check((await pageScripts()).length === 0, 'master pause removes the YouTube page filter');
    await until(browser, 'getComputedStyle(document.getElementById("ad")).display !== "none"', page);
    check(!(await browser.evaluate(fetchExpression, page)), 'master pause allows the previously blocked local request');
    await send({ type: 'UPDATE_SETTINGS', patch: defaults });
    await until(browser, '!busy && currentSettings.enabled');
    await browser.navigate(browser.popup, `${browserName === 'firefox' ? 'moz' : 'chrome'}-extension://${browser.id}/popup.html`);
    await until(browser, 'typeof currentSettings !== "undefined" && currentSettings !== null && !busy');
    check((await state()).ok, 'reopened popup reconciles and verifies saved state');
    check(!(await browser.evaluate('document.documentElement.scrollWidth > innerWidth')), 'popup has no horizontal overflow');
    await browser.screenshot(path.join(temporary, 'popup-final.png'));
    evidence.success = true;
    const loggedErrors = browser.events.filter(event => event.method === 'Runtime.exceptionThrown' ||
      event.method === 'log.entryAdded' && event.params.level === 'error');
    // Firefox labels an intentionally DNR-blocked fetch as a CORS network error.
    // Keep that evidence, but distinguish it from unexpected runtime errors.
    evidence.expectedNetworkErrors = loggedErrors.filter(event => event.params?.source?.context === page.id &&
      (event.params.text?.startsWith('Cross-Origin Request Blocked:') &&
        (event.params.text.includes(`http://localhost:${server.address().port}/blocked-probe.`) ||
         event.params.text.includes('https://blockads-network-guard.invalid/probe.')) ||
       event.params.text?.includes(`ws://localhost:${server.address().port}/ws-blocked`)));
    evidence.events = loggedErrors.filter(event => !evidence.expectedNetworkErrors.includes(event));
    check(evidence.events.length === 0, 'no uncaught extension runtime exceptions');
  } catch (error) {
    evidence.success = false; evidence.error = error.stack;
    process.exitCode = 1;
  } finally {
    if (browser) {
      evidence.stderr = browser.stderr();
      try {
        evidence.cleanup = await browser.close();
        if (browser.launch) check(evidence.cleanup.closed, 'isolated browser process is closed after testing');
      } catch (error) {
        evidence.success = false; evidence.cleanupError = error.stack; process.exitCode = 1;
      }
    }
    await new Promise(resolve => server.close(resolve));
    evidence.networkGuard = { policy: 'deny all proxy; only loopback bypass; speculative DNS disabled', denied, peerResets: proxyPeerResets, errors: proxyErrors };
    if (proxyErrors.length) {
      evidence.success = false; evidence.networkGuardError = 'Unexpected deny proxy errors'; process.exitCode = 1;
    }
    await new Promise(resolve => denyProxy.close(resolve));
    await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ browser: browserName, success: evidence.success, checks: evidence.checks.length,
      evidence: path.join(temporary, 'evidence.json'), error: evidence.error }, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
