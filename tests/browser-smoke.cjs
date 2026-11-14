const { files: extensionFiles } = require('../scripts/extension-files.cjs');
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

async function chromium(extension, profile, denyPort, { headless = true, networkMode = 'offline', downloadDirectory } = {}) {
  if (!['offline', 'live-public'].includes(networkMode)) throw new Error('Unknown browser network mode');
  if (downloadDirectory) {
    await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
    // CDP's setDownloadBehavior replaces extension-chosen filenames. Use the
    // normal download preference in this fresh profile to test native naming.
    await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: {
      default_directory: downloadDirectory, prompt_for_download: false, directory_upgrade: true } }));
  }
  // Edge may exit its launcher and relaunch for Windows compatibility handling.
  // A pipe belongs to the exited launcher; a loopback endpoint survives relaunch.
  const useSocket = browserName === 'edge';
  const child = spawn(executable, [
    ...(headless ? ['--headless=new'] : ['--window-size=1280,900']),
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--enable-unsafe-extension-debugging',
    '--disable-quic', '--dns-prefetch-disable',
    `--proxy-server=http://127.0.0.1:${denyPort}`,
    // Live pages must pass the proxy even for Chromium's implicit localhost
    // and link-local exclusions. Loopback fixtures remain offline-only.
    networkMode === 'live-public' ? '--proxy-bypass-list=<-loopback>' : '--proxy-bypass-list=localhost;127.0.0.1;[::1]',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
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
      { windowsHide: true, timeout: 30000, env: { ...process.env, BLOCKADS_TEST_PROFILE: profile } },
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
        } catch (error) { if (!['ENOENT', 'EBUSY'].includes(error.code)) throw error; }
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
      const { targetId } = await rpc.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await rpc.send('Target.attachToTarget', { targetId, flatten: true });
      await rpc.send('Runtime.enable', {}, sessionId);
      await rpc.send('Page.enable', {}, sessionId);
      const navigation = await rpc.send('Page.navigate', { url }, sessionId);
      if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
      // Return a committed document, never the about:blank context that the
      // requested navigation is about to destroy. Only transient navigation
      // context errors may be retried; probes with side effects are never replayed.
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const result = await rpc.send('Runtime.evaluate', { expression: 'location.href !== "about:blank" && document.readyState === "complete"', returnByValue: true }, sessionId);
          if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
          ready = result.result.value === true;
        } catch (error) {
          if (!/Execution context was destroyed|Cannot find context with specified id/.test(error.message)) throw error;
        }
        if (!ready) await pause(50);
      }
      if (!ready) throw new Error('New page did not finish its initial navigation.');
      return { id: targetId, session: sessionId };
    };
    const popup = await attach(`chrome-extension://${id}/src/ui/popup/popup.html`);
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
    const front = async target => {
      if (!headless) {
        const { windowId, bounds } = await rpc.send('Browser.getWindowForTarget', { targetId: target.id });
        if (bounds.windowState === 'minimized') await rpc.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      }
      await rpc.send('Page.bringToFront', {}, target.session);
    };
    return {
      version, id, popup, evaluate, front, open: attach, close, events: rpc.events,
      closePage: target => rpc.send('Target.closeTarget', { targetId: target.id }),
      send: (method, params, target) => rpc.send(method, params, target?.session),
      async clickAt(x, y, target = popup, button = 'left', clickCount = 1) {
        await front(target);
        for (const type of ['mouseMoved','mousePressed','mouseReleased']) await rpc.send('Input.dispatchMouseEvent',
          {type,x,y,button:type === 'mouseMoved' ? 'none' : button,clickCount:type === 'mouseMoved' ? 0 : clickCount},target.session);
      },
      async typeText(text, target = popup) { await rpc.send('Input.insertText', {text}, target.session); },
      async pressKey(key, target = popup, { control = false } = {}) {
        const code = {Escape:27,Tab:9,Enter:13,Space:32,PageDown:34,ArrowDown:40,ArrowUp:38}[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        for (const type of ['keyDown','keyUp']) await rpc.send('Input.dispatchKeyEvent',{type,key:key === 'Space' ? ' ' : key,code:key.length === 1 ? 'Key'+key.toUpperCase() : key,windowsVirtualKeyCode:code,modifiers:control ? 2 : 0,
          ...(type === 'keyDown' && !control && ['Enter','Space'].includes(key) ? {text:key === 'Enter' ? '\r' : ' ',unmodifiedText:key === 'Enter' ? '\r' : ' '} : {})},target.session);
      },
      launch: { transport: useSocket ? 'loopback-websocket' : 'pipe', networkMode, launcherPid: child.pid, browserPid, relaunched: child.pid !== browserPid },
      async screenshot(file) {
        // A background tab may never produce a frame; capture the popup in front.
        await rpc.send('Target.activateTarget', { targetId: popup.id });
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

async function firefox(extension, profile, denyPort, { ruleFeedback = true, downloadDirectory } = {}) {
  const firefoxExecutable = process.env.BLOCKADS_TEST_BROWSER || executables.firefox;
  const uuid = 'd73f30ed-9a72-486f-84f7-8a1d16be7021';
  await fs.mkdir(profile, { recursive: true });
  await fs.writeFile(path.join(profile, 'user.js'), [
    `user_pref("extensions.webextensions.uuids", ${JSON.stringify(JSON.stringify({ 'blockads-shield@local.extension': uuid }))});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    ...(downloadDirectory ? [`user_pref("browser.download.dir", ${JSON.stringify(downloadDirectory)});`, 'user_pref("browser.download.folderList", 2);', 'user_pref("browser.download.useDownloadDir", true);'] : []),
    `user_pref("extensions.dnr.feedback", ${Boolean(ruleFeedback)});`,
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
  // Extension pages are privileged contexts to BiDi. Firefox 159 no longer has
  // --remote-allow-system-access, which older releases need, and reads this instead.
  const child = spawn(firefoxExecutable, ['--headless', '--no-remote', '--profile', profile,
    '--remote-allow-system-access', '--remote-debugging-port', '0', 'about:blank'],
  { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' } });
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
      // Cold Firefox startup on Windows can exceed 20 seconds before exposing
      // BiDi. Wait for that endpoint, with a bounded startup timeout, not a sleep.
      const timer = setTimeout(() => reject(new Error('Firefox BiDi startup timed out')), 60000);
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
    const chromeEvaluate = async expression => {
      const { contexts: [window] } = await rpc.send('browsingContext.getTree', { 'moz:scope': 'chrome', maxDepth: 0 });
      const result = await rpc.send('script.evaluate', { expression, target: { context: window.context }, awaitPromise: true });
      if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    // log.entryAdded never reports extension documents, and the console store
    // keeps only 250 messages, so collect uncaught errors from before install.
    await chromeEvaluate(`(() => {
      const errors = window.moduleEngineErrors = [], prefix = ${JSON.stringify(`moz-extension://${uuid}/`)};
      Services.console.registerListener({ observe(message) {
        if (message instanceof Ci.nsIScriptError && !(message.flags & (message.warningFlag | message.infoFlag)) &&
          String(message.sourceName).startsWith(prefix)) errors.push({ text: message.errorMessage, source: message.sourceName });
      } });
    })()`);
    await rpc.send('webExtension.install', { extensionData: { type: 'path', path: extension } });
    const { contexts } = await rpc.send('browsingContext.getTree');
    const popup = { id: contexts[0].context, extensionPage: true };
    const navigate = (target, url) => rpc.send('browsingContext.navigate', { context: target.id, url, wait: 'complete' });
    await navigate(popup, `moz-extension://${uuid}/src/ui/popup/popup.html`);
    const evaluate = async (expression, target = popup) => {
      const result = await rpc.send('script.evaluate', {
        expression: `(async () => JSON.stringify(await (${expression})))()`,
        target: { context: target.id }, awaitPromise: true
      });
      if (result.type === 'exception') throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.type === 'undefined' ? undefined : JSON.parse(result.result.value);
    };
    // BiDi refuses browsingContext.activate on privileged contexts, but not
    // screenshots or native input, so extension pages front themselves.
    const front = async target => {
      if (target.extensionPage) await evaluate('browser.tabs.getCurrent().then(tab => browser.tabs.update(tab.id, { active: true }))', target);
      else await rpc.send('browsingContext.activate', { context: target.id });
      // Selecting a tab alone can leave native focus in browser chrome after
      // a permission prompt. DOM activeElement is insufficient for activation.
      await chromeEvaluate('gBrowser.selectedBrowser.focus()');
    };
    return {
      version: session.capabilities, id: uuid, popup, evaluate, navigate, close, front, events: rpc.events,
      consoleErrors: async () => JSON.parse(await chromeEvaluate('JSON.stringify(window.moduleEngineErrors)')),
      async userscriptPermissionPrompt(accept = false, kind = 'userscripts') {
        // Operate only the visible native prompt for this disposable extension.
        // This is a browser UI acceptance, not a permission-store/pref override.
        return JSON.parse(await chromeEvaluate(`(() => {
          const panel = PopupNotifications.panel;
          const node = [...panel.querySelectorAll('popupnotification')].find(item => !item.hidden && /webext-permissions/.test(item.id));
          const text = node ? (node.getAttribute('label') || '') + ' ' + node.textContent : '';
          const button = node?.button;
          const setting = node?.querySelector('moz-checkbox');
          const settingLabel = setting?.label || setting?.shadowRoot?.textContent || '';
          const info = { state: panel.state, id: node?.id, text: text.slice(0, 2000), button: button?.label, disabled: button?.disabled,
            settingLabel, checked: setting?.checked, accepted: false };
          if (${Boolean(accept && kind === 'userscripts')} && panel.state === 'open' && text.includes('Module Engine') &&
              node.querySelectorAll('moz-checkbox').length === 1 && settingLabel === 'Allow unverified third-party scripts to access your data') {
            if (!setting.checked) { setting.shadowRoot.querySelector('input[type="checkbox"]').click(); info.settingClicked = true; }
            if (setting.checked && button && !button.disabled) { button.click(); info.accepted = true; }
          }
          if (${Boolean(accept && kind === 'helpers')} && panel.state === 'open' && text.includes('Module Engine') &&
              node.querySelectorAll('moz-checkbox').length === 0 && /clipboard/i.test(text) && /notifications/i.test(text) && /download/i.test(text) && button && !button.disabled) {
            button.click(); info.accepted = true;
          }
          return JSON.stringify(info);
        })()`));
      },
      // emulation.setMediaFeaturesOverride also refuses extension pages.
      setColorScheme(scheme) {
        const pref = 'layout.css.prefers-color-scheme.content-override';
        return chromeEvaluate(scheme ? `Services.prefs.setIntPref('${pref}', ${scheme === 'dark' ? 0 : 1})` : `Services.prefs.clearUserPref('${pref}')`);
      },
      // The toolbar panel is outside BiDi's context tree, so its size and pixels
      // come from the chrome scope. openPopup needs a trusted click on a page.
      async openToolbarPopup(target, file) {
        await evaluate(`(document.addEventListener('click', () => { browser.action.openPopup(); }, { once: true }), true)`, target);
        const { x, y } = await evaluate(`(r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))(document.querySelector('h1').getBoundingClientRect())`, target);
        await this.clickAt(x, y, target);
        const popupBrowser = `document.querySelector('.webextension-popup-browser')`;
        // Firefox first opens a 16x8 placeholder panel, before the extension
        // document finishes loading and reports its preferred dimensions.
        const expectedURI = await evaluate('browser.runtime.getURL("src/ui/popup/popup.html")', target);
        const opened = `${popupBrowser}?.closest('panel').state === 'open' && ${popupBrowser}.currentURI.spec === ${JSON.stringify(expectedURI)} && !${popupBrowser}.webProgress.isLoadingDocument && ${popupBrowser}.getBoundingClientRect().height > 300`;
        for (let i = 0; i < 300 && !(await chromeEvaluate(opened)); i++) await pause(50);
        const panel = JSON.parse(await chromeEvaluate(`(() => { const node = ${popupBrowser}, box = node?.getBoundingClientRect();
          return JSON.stringify({ state: node?.closest('panel').state, width: box?.width, height: box?.height, uri: node?.currentURI.spec }); })()`));
        if (panel.state === 'open') {
          const image = await chromeEvaluate(`(async () => { const node = ${popupBrowser}, { width, height } = node.getBoundingClientRect();
            const bitmap = await node.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, width, height), 1, 'rgb(255, 0, 255)');
            const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); canvas.width = width; canvas.height = height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0); return canvas.toDataURL('image/png'); })()`);
          await fs.writeFile(file, Buffer.from(image.split(',')[1], 'base64'));
          await chromeEvaluate(`${popupBrowser}.closest('panel').hidePopup()`);
        }
        return panel;
      },
      async clickAt(x, y, target = popup, button = 'left') {
        await front(target);
        await rpc.send('input.performActions',{context:target.id,actions:[{type:'pointer',id:'fixture-mouse',parameters:{pointerType:'mouse'},actions:[
          {type:'pointerMove',origin:'viewport',x:Math.round(x),y:Math.round(y),duration:0},{type:'pointerDown',button:{left:0,middle:1,right:2}[button]},{type:'pointerUp',button:{left:0,middle:1,right:2}[button]}]}]});
      },
      async typeText(text, target = popup) {
        await rpc.send('input.performActions',{context:target.id,actions:[{type:'key',id:'fixture-keyboard',actions:
          [...text].flatMap(value=>[{type:'keyDown',value},{type:'keyUp',value}])}]});
      },
      async pressKey(key, target = popup, { control = false } = {}) {
        await front(target);
        // Use the main Return key (code Enter), not keypad Enter.
        const value = {Escape:'\uE00C',Tab:'\uE004',Enter:'\uE006',Space:' ',PageDown:'\uE00F',ArrowDown:'\uE015',ArrowUp:'\uE013'}[key] || key;
        await rpc.send('input.performActions',{context:target.id,actions:[{type:'key',id:'fixture-keyboard',actions:[...(control ? [{type:'keyDown',value:'\uE009'}] : []),{type:'keyDown',value},{type:'keyUp',value},...(control ? [{type:'keyUp',value:'\uE009'}] : [])]}]});
      },
      closePage: target => rpc.send('browsingContext.close', { context: target.id }),
      async open(url) {
        const { context } = await rpc.send('browsingContext.create', { type: 'tab' });
        const target = { id: context, extensionPage: url.startsWith('moz-extension:') }; await navigate(target, url); return target;
      },
      async screenshot(file, target = popup, clip) {
        // Extension pages cannot set a viewport here, so this is the full
        // document at the window's width. Narrow layouts are measured in frames.
        await front(target);
        await evaluate('(document.getAnimations().forEach(animation => animation.finish()), true)', target);
        const { data } = await rpc.send('browsingContext.captureScreenshot', { context: target.id, origin: 'document',
          ...(clip ? { clip: { type: 'box', x: 0, y: 0, ...clip } } : {}) });
        await fs.writeFile(file, Buffer.from(data, 'base64'));
      },
      stderr: () => stderr
    };
  } catch (error) {
    await close();
    error.message += `\nFirefox launcher PID ${child.pid}, exit ${child.exitCode}. Startup output: ${stderr || '(none)'}`;
    throw error;
  }
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
  for (const file of extensionFiles) {
    await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  }
  const testedManifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
  const sourceHashes = {};
  for (const file of extensionFiles) {
    sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  }
  const redditFixture = await require('./reddit-browser.cjs').aliasFixture(extension);
  const youtubeFixtures = process.argv.includes('--youtube-only') ? await require('./youtube-browser.cjs').aliasFixture(extension) : [];
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
    if (require('./youtube-browser.cjs').serve(req, res)) return;
    if (require('./buttons-browser.cjs').serve(req, res)) return;
    if (require('./prompts-browser.cjs').serve(req, res)) return;
    requests.push(req.url);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/picker-csp') res.setHeader('Content-Security-Policy', "require-trusted-types-for 'script'; trusted-types 'none'");
    if (req.url.startsWith('/blocked-probe.network')) {
      res.setHeader('Content-Type','application/javascript');
      res.setHeader('Cache-Control','no-store');
      return res.end('window.__blockadsNetworkProbe=(window.__blockadsNetworkProbe||0)+1;');
    }
    if (req.url.startsWith('/promo/')) {
      // A real image: browsers discard cross-site "images" served as HTML (ORB),
      // and a discarded response never counts as loaded.
      res.setHeader('Content-Type', 'image/gif');
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
      return;
    }
    if (req.url === '/flag-fixture') {
      // A third-party ad-like image and a frame in a standard ad size (300x250).
      const other = `http://localhost:${server.address().port}`;
      res.end(`<!doctype html><title>BlockAds flag fixture</title><img src="${other}/promo/ads/creative.gif?zoneid=7">` +
        `<iframe src="${other}/frame" width="300" height="250" style="border:0"></iframe>` +
        `<div><span>Sponsored</span><a href="${other}/landing">Great offer</a></div>`);
      return;
    }
    const frame = req.url === '/fixture'
      ? `<iframe id="child" src="http://localhost:${server.address().port}/frame"></iframe>
         <script>window.frameDisplay = () => new Promise(resolve => {
           const target = document.getElementById('child').contentWindow;
           const timer = setTimeout(() => { removeEventListener('message', receive); resolve(null); }, 250);
           const receive = event => { if (event.source === target && event.data?.kind === 'display') {
             clearTimeout(timer); removeEventListener('message', receive); resolve(event.data.value);
           }};
           addEventListener('message', receive); target.postMessage('measure', '*');
         });
         window.framePopup = url => new Promise(resolve => {
           const target = document.getElementById('child').contentWindow;
           const timer = setTimeout(() => { removeEventListener('message', receive); resolve(false); }, 1000);
           const receive = event => { if (event.source === target && event.data?.kind === 'popup-attempted') {
             clearTimeout(timer); removeEventListener('message', receive); resolve(true);
           }};
           addEventListener('message', receive); target.postMessage({kind:'popup-probe',url}, '*');
         });</script>`
      : `<script>addEventListener('message', event => {
           if (event.data === 'measure') event.source.postMessage({kind:'display',value:getComputedStyle(document.getElementById('ad')).display}, event.origin);
           if (event.data?.kind === 'popup-probe') {
             const link = document.createElement('a'); link.href = event.data.url; link.target = '_blank';
             document.body.append(link); link.click();
             event.source.postMessage({kind:'popup-attempted'}, event.origin);
           }
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
  const evidence = { browser: browserName, temporary, sourceHashes, fixtureOverrides: [redditFixture, ...youtubeFixtures], checks: [], startedAt: new Date().toISOString() };
  let browser;
  const check = (condition, description) => { assert.ok(condition, description); evidence.checks.push(description); };
  try {
    const downloadDirectory = path.join(temporary, 'downloads');
    await fs.mkdir(downloadDirectory);
    browser = await (browserName === 'firefox' ? firefox : chromium)(extension, path.join(temporary, 'profile'), denyProxy.address().port,
      { headless: !process.argv.includes('--headed'), downloadDirectory });
    evidence.version = browser.version;
    if (browser.launch) evidence.launch = browser.launch;
    await until(browser, 'typeof currentSettings !== "undefined" && currentSettings !== null && !busy');
    const send = message => browser.evaluate(`api.runtime.sendMessage(${JSON.stringify(message)})`);
    const state = () => send({ type: 'GET_STATE' });
    const match = (url, type = 'script', initiator = 'https://fixture.example') => browser.evaluate(
      `api.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url, type, initiator })})`);
    check((await state()).ok, 'extension loads and reports verified state (Reddit hostname alias is limited to the local fixture)');
    check(!(await browser.evaluate('errorPanel.hidden === false')), 'popup has no startup error');
    if (process.argv.includes('--youtube-only')) {
      await require('./youtube-browser.cjs').verify({ browser, send, state, until, check, origin: new URL(fixtureUrl).origin });
      check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || event.method === 'log.entryAdded' && event.params.level === 'error'),
        'no uncaught errors during native YouTube fixture checks');
      evidence.success = true; return;
    }
    if (process.argv.includes('--buttons-only')) {
      const page = await browser.open(fixtureUrl);
      await require('./buttons-browser.cjs').verify({ browser, page, send, state, until, check, temporary, baseline: process.argv.includes('--buttons-baseline') });
      await browser.closePage(page);
      check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || event.method === 'log.entryAdded' && event.params.level === 'error'),
        'no uncaught errors during the focused button fixture checks');
      evidence.success = true; return;
    }
    if (process.argv.includes('--prompts-only')) {
      const page = await browser.open(fixtureUrl);
      await require('./prompts-browser.cjs').verify({ browser, page, send, state, until, check, temporary });
      await browser.closePage(page);
      check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || event.method === 'log.entryAdded' && event.params.level === 'error'),
        'no uncaught errors during the focused prompt fixture checks');
      evidence.success = true; return;
    }
    if (process.argv.includes('--reddit-only')) {
      const page = await browser.open(fixtureUrl);
      await require('./reddit-browser.cjs').verify({ browser, page, send, state, until, check, temporary });
      await browser.closePage(page);
      check(!browser.events.some(event => event.method === 'Runtime.exceptionThrown' || event.method === 'log.entryAdded' && event.params.level === 'error'),
        'no uncaught errors during the focused Reddit fixture checks');
      evidence.success = true; return;
    }
    check((await match('https://doubleclick.net/test.js')).matchedRules.length > 0, 'bundled ad request matches');
    check((await match('https://customer.azioncdn.net/app.js')).matchedRules.length === 0, 'shared CDN customer is allowed');
    check((await match('https://legitimate.example.tk/app.js')).matchedRules.length === 0, 'country-code TLD is not blanket blocked');
    check((await match('https://fixture.example/ordinary.js')).matchedRules.length === 0, 'ordinary resource is allowed');

    // Native rule evaluation only: these strings are never navigated or fetched.
    evidence.requestedDomainMatches = [];
    const requestedDomainHit = async (url, type = 'main_frame') => {
      // As with the threat probes below, Firefox's simulator needs the HTTP(S)
      // handshake URL. The actual requested-rule WebSocket is tested on loopback.
      const testedUrl = browserName === 'firefox' && type === 'websocket' ? url.replace(/^ws/, 'http') : url;
      const matchedRules = (await match(testedUrl, type)).matchedRules;
      evidence.requestedDomainMatches.push({ url, testedUrl, type, matchedRules });
      // The older exact pxl rule and the new domain rule overlap at equal priority.
      // Accept either user-requested block; unrelated community rules cannot satisfy this check.
      return matchedRules.some(rule => rule.rulesetId === 'ads_ruleset' && [200001, 200002].includes(rule.ruleId));
    };
    for (const [url, type] of [['https://wheelroot.com/fixture', 'main_frame'], ['http://wheelroot.com:8080/fixture', 'sub_frame'],
      ['https://www.wheelroot.com/fixture', 'script'], ['https://a.b.wheelroot.com/fixture', 'media'],
      ['https://user:pass@wheelroot.com./fixture', 'main_frame'], ['wss://pxl.wheelroot.com/fixture', 'websocket'],
      ['wss://socket.wheelroot.com/fixture', 'websocket']])
      check(await requestedDomainHit(url, type), 'user-requested domain block matches natively: ' + url);
    for (const url of ['https://notwheelroot.com/fixture', 'https://wheelroot.com.other.net/fixture',
      'https://fixture.example/?next=wheelroot.com/fixture', 'https://wheelroot.com@fixture.example/fixture'])
      check(!await requestedDomainHit(url), 'user-requested domain block preserves hostname boundary: ' + url);
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false } } });
    check(!await requestedDomainHit('https://wheelroot.com/fixture'), 'ad-layer switch disables the user-requested domain block');
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: true } } });
    check(await requestedDomainHit('https://wheelroot.com/fixture'), 'ad-layer switch restores the user-requested domain block');
    await send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'wheelroot.com' });
    check(!await requestedDomainHit('https://child.wheelroot.com/fixture'), 'explicit allow preference overrides the reported domain request');
    await send({ type: 'REMOVE_ALLOWED_DOMAIN', domain: 'wheelroot.com' });
    check(await requestedDomainHit('https://child.wheelroot.com/fixture'), 'removing the allow preference restores the reported domain block');
    check(!denied.some(request => request.destination?.includes('wheelroot.com')), 'no wheelroot host was requested during offline rule evaluation');

    // Community lists: a domain from the built snapshot is blocked by its own switchable ruleset.
    const communityRules = JSON.parse(await fs.readFile(path.join(root, 'rules/community.json'), 'utf8'));
    const plainRule = communityRules.find(rule => rule.action.type === 'block' && rule.condition.requestDomains &&
      Object.keys(rule.condition).length === 1);
    check(Boolean(plainRule), 'community snapshot contains plain domain-list rules');
    const communityHost = plainRule.condition.requestDomains[0];
    const communityHit = async () => (await match(`https://${communityHost}/fixture.js`)).matchedRules.some(rule => rule.rulesetId === 'community_ruleset');
    check((await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).includes('community_ruleset'), 'community ruleset is enabled by default');
    check(await communityHit(), 'community list domain is blocked');
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: false } } });
    check(!(await communityHit()), 'community switch disables its rules');
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: true } } });
    check(await communityHit(), 'community switch re-enables its rules');
    check(await browser.evaluate(`fetch(api.runtime.getURL('rules/community-cosmetic.json')).then(r => r.json()).then(data => Object.keys(data.hide).length > 0)`),
      'packaged site hiding rules are readable by the extension');
    await until(browser, `/EasyList.*rules/.test(document.getElementById('communityStatus').textContent)`);
    check(true, 'popup describes the community snapshot');
    const pageScripts = () => browser.evaluate('api.scripting.getRegisteredContentScripts()');
    const youtubeScript = (await pageScripts()).find(script => script.id === 'youtube-ads');
    evidence.youtubeScript = youtubeScript;
    check(youtubeScript?.id === 'youtube-ads' && youtubeScript.world === 'MAIN' && youtubeScript.runAt === 'document_start' &&
      youtubeScript.matches.includes('*://*.youtube.com/*'), 'YouTube page filter is registered in the page world at document start');
    await send({ type: 'SET_SITE_PAUSED', domain: 'www.youtube.com', paused: true });
    check((await pageScripts()).find(script => script.id === 'youtube-ads')?.excludeMatches?.includes('*://*.youtube.com/*'), 'pausing YouTube excludes it from the page filter');
    await send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: false });
    check(!(await pageScripts()).find(script => script.id === 'youtube-ads')?.excludeMatches?.length, 'resuming YouTube restores the page filter');

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

    // Always-allowed domains, judged by the browser's own rule engine.
    const winners = async url => (await match(url)).matchedRules.map(rule => rule.rulesetId);
    check((await winners('https://doubleclick.net/test.js')).includes('ads_ruleset'), 'ad list blocks the domain before it is allowed');
    for (const domain of ['doubleclick.net', communityHost, threatHosts[0]]) {
      check((await send({ type: 'ADD_ALLOWED_DOMAIN', domain })).ok, `domain can be always allowed: ${domain}`);
    }
    check(String(await winners('https://doubleclick.net/test.js')) === '_dynamic', 'always-allowed domain overrides the ad list');
    check(String(await winners(`https://${communityHost}/fixture.js`)) === '_dynamic', 'always-allowed domain overrides the community lists');
    check((await winners('https://' + threatHosts[0] + '/fixture')).includes('threats_ruleset'), 'reported threats stay blocked even when always allowed');
    for (const domain of ['doubleclick.net', communityHost, threatHosts[0]]) await send({ type: 'REMOVE_ALLOWED_DOMAIN', domain });
    check((await winners('https://doubleclick.net/test.js')).includes('ads_ruleset'), 'removing the allowed domain restores blocking');

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
    check(!(await pageScripts()).some(script => script.id === 'youtube-ads'), 'ad switch removes the YouTube page filter');
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
    await browser.evaluate('(allowDomainInput.value = "https://translate.googleapis.com/translate_a/element.js", allowForm.requestSubmit(), true)');
    await until(browser, '!busy && currentSettings.allowedDomains.includes("translate.googleapis.com") && allowDomainList.textContent.includes("translate.googleapis.com") && allowDomainInput.value === ""');
    check(true, 'popup adds an always-allowed domain from a URL');
    await browser.evaluate('(allowDomainList.querySelector("button").click(), true)');
    await until(browser, '!busy && currentSettings.allowedDomains.length === 0 && !allowDomainList.children.length');
    check(true, 'popup removes an always-allowed domain');

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
    check(await browser.evaluate('getComputedStyle(document.getElementById("ad")).visibility === "hidden" && getComputedStyle(document.getElementById("ad")).pointerEvents === "none"', page), 'built-in hiding retains its visibility and pointer safeguards');
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
    // Only inert loopback elements are used to exercise the expanded filter engine.
    {
    const bundleCosmetic = JSON.parse(await fs.readFile(path.join(extension, 'rules/community-cosmetic.json'), 'utf8'));
    const genericSelector = bundleCosmetic.generic.find(selector => /^\.[a-zA-Z][\w-]+$/.test(selector) && selector !== '.ad-slot');
    check(Boolean(genericSelector), 'bundle contains a simple generic selector for the local fixture');
    await browser.evaluate(`(() => {
      for (const [id, className] of [['genericAd', ${JSON.stringify(genericSelector.slice(1))}], ['customCosmetic', 'blockads-custom-fixture']]) {
        const element = document.createElement('div'); element.id = id; element.className = className; element.textContent = 'Local cosmetic fixture'; document.body.append(element);
      }
      return true;
    })()`, page);
    await until(browser, 'getComputedStyle(document.getElementById("genericAd")).display === "none"', page);
    check(true, 'a newly inserted element matches the bundled generic CSS without a page reload');
    const toggleStarted = Date.now();
    await send({ type: 'UPDATE_SETTINGS', patch: { genericCosmeticFiltering: false } });
    await until(browser, 'getComputedStyle(document.getElementById("genericAd")).display !== "none"', page);
    check(true, 'turning generic cosmetics off restores the generic fixture');
    await send({ type: 'UPDATE_SETTINGS', patch: { genericCosmeticFiltering: true } });
    await until(browser, 'getComputedStyle(document.getElementById("genericAd")).display === "none"', page);
    evidence.cosmetic = { genericSelectors: bundleCosmetic.generic.length, toggleRoundTripMs: Date.now() - toggleStarted,
      styleCharacters: await browser.evaluate('document.getElementById("blockads-cosmetic-shield").textContent.length', page) };

    const listsPage = await browser.open(await browser.evaluate('api.runtime.getURL("src/ui/lists/lists.html")'));
    await until(browser, 'typeof settings !== "undefined" && settings !== null && !busy', listsPage);
    await browser.evaluate('(document.getElementById("customFilterPanel").open = true, true)', listsPage);
    const editDraft = async text => {
      await until(browser, '!busy && !document.getElementById("customFilters").disabled', listsPage);
      return browser.evaluate(`(() => { const input = document.getElementById('customFilters'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`, listsPage);
    };
    const saveDraft = async () => {
      await until(browser, '!busy && !document.getElementById("saveFilters").disabled', listsPage);
      return browser.evaluate('(document.getElementById("saveFilters").click(), true)', listsPage);
    };
    const savedFilter = '127.0.0.1##.blockads-custom-fixture';
    await editDraft(savedFilter);
    await saveDraft();
    await until(browser, 'getComputedStyle(document.getElementById("customCosmetic")).display === "none"', page);
    await until(browser, '!busy && !filterDraftDirty && /Saved 1 rules/.test(document.getElementById("filterStatus").textContent)', listsPage);
    check((await state()).settings.customCosmeticFilters === savedFilter, 'the visible custom editor saves a rule and updates an existing page');
    await editDraft('127.0.0.1##[broken');
    await saveDraft();
    await until(browser, '/Line 1:/.test(document.getElementById("filterStatus").textContent)', listsPage);
    check((await state()).settings.customCosmeticFilters === savedFilter, 'invalid CSS is reported without replacing saved filters');
    const draft = '127.0.0.1##.unsaved-draft';
    await editDraft(draft);
    const externalFilter = '127.0.0.1##.blockads-custom-fixture\n127.0.0.1#@#' + genericSelector;
    check((await send({ type: 'SAVE_COSMETIC_FILTERS', previous: savedFilter, text: externalFilter })).ok, 'a second editor can save with the current revision');
    await until(browser, `!busy && settings.customCosmeticFilters === ${JSON.stringify(externalFilter)}`, listsPage);
    check(await browser.evaluate(`document.getElementById('customFilters').value === ${JSON.stringify(draft)}`, listsPage), 'external changes preserve an unsaved draft');
    await saveDraft();
    await until(browser, '/another window/.test(document.getElementById("filterStatus").textContent)', listsPage);
    check((await state()).settings.customCosmeticFilters === externalFilter, 'a stale draft cannot overwrite newer saved filters');
    await until(browser, '!busy && !document.getElementById("discardFilters").disabled', listsPage);
    await browser.evaluate('(document.getElementById("discardFilters").click(), true)', listsPage);
    await until(browser, '!filterDraftDirty && document.getElementById("customFilters").value === settings.customCosmeticFilters', listsPage);
    await until(browser, 'getComputedStyle(document.getElementById("genericAd")).display !== "none"', page);
    check(true, 'custom selector exceptions undo generic hiding without removing unrelated custom hiding');
    check(await browser.evaluate('getComputedStyle(document.getElementById("customCosmetic")).display === "none"', page), 'unrelated custom hiding remains active');

    const enabledBeforeCosmeticPause = (await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).sort();
    await browser.evaluate(`(() => { const form = document.querySelector('[data-list="cosmeticPausedDomains"] form'); form.querySelector('input').value = '127.0.0.1'; form.requestSubmit(); return true; })()`, listsPage);
    await until(browser, '!busy && settings.cosmeticPausedDomains.includes("127.0.0.1")', listsPage);
    await until(browser, 'getComputedStyle(document.getElementById("customCosmetic")).display !== "none" && window.frameDisplay().then(value => value !== null && value !== "none")', page);
    check(true, 'cosmetic-only site pause restores local and cross-origin embedded elements');
    check(JSON.stringify((await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).sort()) === JSON.stringify(enabledBeforeCosmeticPause), 'cosmetic-only pause keeps every network ruleset enabled');
    check((await match('https://doubleclick.net/fixture', 'script', fixtureUrl)).matchedRules.length > 0, 'ad network matching remains active on a cosmetically paused site');
    check((await match('https://' + threatHosts[0] + '/fixture', 'script', fixtureUrl)).matchedRules.some(rule => rule.rulesetId === 'threats_ruleset'), 'reported-threat matching remains active on a cosmetically paused site');
    await browser.evaluate('(document.querySelector("[data-list=cosmeticPausedDomains] tbody button").click(), true)', listsPage);
    await until(browser, 'getComputedStyle(document.getElementById("customCosmetic")).display === "none"', page);
    check(true, 'removing the cosmetic exception immediately restores hiding');
    if (browser.send) {
      await browser.send('Target.activateTarget', { targetId: listsPage.id });
      for (const width of [1100, 380]) {
        await browser.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, listsPage);
        await browser.evaluate('(scrollTo(0, 0), document.getElementById("customFilters").focus(), true)', listsPage);
        check(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth', listsPage), `custom editor fits a ${width}px viewport`);
        const capture = await browser.send('Page.captureScreenshot', { format: 'png' }, listsPage);
        await fs.writeFile(path.join(temporary, `cosmetic-editor-${width}.png`), Buffer.from(capture.data, 'base64'));
      }
    }
    await editDraft('');
    await saveDraft();
    await until(browser, 'getComputedStyle(document.getElementById("customCosmetic")).display !== "none"', page);
    check((await state()).settings.customCosmeticFilters === '', 'saving an empty custom list removes its effects');
    // This editor's storage listeners must not issue late reconciliation requests
    // during the later probe that deliberately installs a temporary DNR rule.
    await until(browser, '!busy && !filterDraftDirty', listsPage);
    await browser.closePage(listsPage);
    }
    await require('./procedural-browser.cjs')({ browser, page, send, state, until, check, root });
    await require('./reddit-browser.cjs').verify({ browser, page, send, state, until, check, temporary });
    await require('./prompts-browser.cjs').verify({ browser, page, send, state, until, check, temporary });
    await require('./buttons-browser.cjs').verify({ browser, page, send, state, until, check, temporary });
    await require('./picker-browser.cjs')({ browser, page, send, state, until, check, temporary });
    await require('./network-browser.cjs')({ browser, page, send, state, match, until, check, temporary, requests, threatHosts });
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
    await until(browser, '!busy && currentSettings.whitelistedDomains.length === 0');
    await until(browser, 'getComputedStyle(document.getElementById("ad")).display === "none" && window.frameDisplay().then(value => value === "none")', page);
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
    evidence.socketRuleBefore = await browser.evaluate('api.declarativeNetRequest.getDynamicRules().then(rules => rules.filter(rule => rule.id === 9001))');
    assert.equal(evidence.socketRuleBefore.length, 1, 'temporary loopback WebSocket rule is installed before the probe');
    const blockedSocket = await socketProbe('ws-blocked');
    evidence.socketRuleAfter = await browser.evaluate('api.declarativeNetRequest.getDynamicRules().then(rules => rules.filter(rule => rule.id === 9001))');
    check(!blockedSocket && !socketUpgrades.includes('/ws-blocked'), 'reported-rule regex blocks a real loopback WebSocket before handshake');
    await browser.evaluate('api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[9001],addRules:[]})');
    check(await socketProbe('ws-blocked'), 'removing the isolated regex rule restores the WebSocket handshake');

    const requestedSocketRule = JSON.parse(await fs.readFile(path.join(root, 'rules/ads.json'), 'utf8')).find(rule => rule.id === 200002);
    requestedSocketRule.id = 9002;
    requestedSocketRule.condition.regexFilter = requestedSocketRule.condition.regexFilter.replace('wheelroot\\.com', 'localhost');
    requestedSocketRule.condition.resourceTypes = ['websocket'];
    await browser.evaluate(`api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[],addRules:[${JSON.stringify(requestedSocketRule)}]})`);
    evidence.requestedSocketRule = await browser.evaluate('api.declarativeNetRequest.getDynamicRules().then(rules => rules.filter(rule => rule.id === 9002))');
    assert.equal(evidence.requestedSocketRule.length, 1, 'requested-domain fixture rule is installed before the real WebSocket probe');
    check(!await socketProbe('ws-requested-blocked') && !socketUpgrades.includes('/ws-requested-blocked'), 'requested-domain regex blocks a real loopback WebSocket before handshake');
    await browser.evaluate('api.declarativeNetRequest.updateDynamicRules({removeRuleIds:[9002],addRules:[]})');
    check(await socketProbe('ws-requested-blocked'), 'removing the requested-domain fixture rule restores the WebSocket handshake');

    // Per-site pop-up blocking. Network observations, including a synthetic
    // click inside the cross-origin child frame, establish what was refused.
    await send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: true });
    check((await pageScripts()).some(script => script.id === 'popup-blocker' && script.matches.includes('*://127.0.0.1/*')),
      'pop-up blocker is registered for the chosen site');
    const popupPage = await browser.open(fixtureUrl);
    await until(browser, 'document.readyState === "complete"', popupPage);
    const popupTarget = `http://localhost:${server.address().port}/popup-`;
    const popupResult = await browser.evaluate(`(async () => {
      const opened = window.open('${popupTarget}open');
      const clicked = document.createElement('a');
      clicked.href = '${popupTarget}click'; clicked.target = '_blank'; clicked.click();
      const dispatched = document.createElement('a');
      dispatched.href = '${popupTarget}dispatch'; dispatched.target = '_blank'; document.body.append(dispatched);
      dispatched.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const sameSite = document.createElement('a');
      sameSite.href = '#same-site'; document.body.append(sameSite); sameSite.click();
      document.dispatchEvent(new CustomEvent('blockads-popup-blocked', {detail:'spoof.example'}));
      // Firefox updates the fragment after the click task finishes.
      await new Promise(resolve => setTimeout(resolve, 300));
      return { opened: opened === null, sameSite: location.hash === '#same-site' };
    })()`, popupPage);
    evidence.popupBlocking = popupResult;
    check(popupResult.opened, 'window.open to another site is refused');
    check(popupResult.sameSite, 'same-site links still work on a pop-up-blocked site');
    const framePopupTarget = `http://127.0.0.1:${server.address().port}/popup-frame`;
    check(await browser.evaluate(`window.framePopup(${JSON.stringify(framePopupTarget)})`, popupPage),
      'cross-origin child frame completes its synthetic pop-up probe');
    await pause(1000);
    check(!requests.some(url => url.startsWith('/popup-')), 'top-page and cross-origin-frame pop-ups never load');
    check(!(await send({ type: 'GET_LOG' })).entries.some(entry => /^Blocked a pop-up/.test(entry.message)),
      'page-dispatched pop-up events cannot forge activity-log entries');
    await send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: false });
    check(!(await pageScripts()).some(script => script.id === 'popup-blocker'), 'turning pop-up blocking off unregisters its script');
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
    const logPage = await browser.open(`${browserName === 'firefox' ? 'moz' : 'chrome'}-extension://${browser.id}/src/ui/log/log.html`);
    if (browserName === 'firefox') {
      await until(browser, `[...document.querySelectorAll('#entryTable tbody td')].some(cell => cell.textContent === 'Custom block added localhost')`, logPage);
      check(await browser.evaluate(`!document.getElementById('notice').hidden && !document.getElementById('notice').classList.contains('error') &&
        document.documentElement.scrollWidth <= innerWidth`, logPage), 'Firefox log page lists events and explains missing block entries');
    } else {
      await until(browser, `[...document.querySelectorAll('#summaryTable tbody td')].some(cell => cell.textContent === 'localhost')`, logPage);
      check(await browser.evaluate(`document.getElementById('notice').hidden && document.documentElement.scrollWidth <= innerWidth`, logPage),
        'activity log page shows the blocked server without errors or horizontal overflow');
      check(await browser.evaluate(`[...document.querySelectorAll('#summaryTable tbody tr')].some(row =>
        row.textContent.includes('localhost') && row.textContent.includes('Remove it from Custom Blocked Domains') && !row.querySelector('button'))`, logPage),
        'log page does not offer Allow for a custom-blocked server');
    }
    check(await browser.evaluate('document.getElementById("logLink").pathname === "/src/ui/log/log.html"'), 'popup links to the activity log');
    check(await browser.evaluate('document.getElementById("listsLink").pathname === "/src/ui/lists/lists.html"'), 'popup links to the lists page');

    // My lists page: tables show, add and exactly remove entries, and follow changes made elsewhere.
    const siteHostInfo = JSON.parse(await fs.readFile(path.join(root, 'rules/site-ad-hosts-info.json'), 'utf8'));
    const listsPage = await browser.open(`${browserName === 'firefox' ? 'moz' : 'chrome'}-extension://${browser.id}/src/ui/lists/lists.html`);
    const rowsOf = key => `document.querySelectorAll('section[data-list="${key}"] tbody tr').length`;
    await until(browser, `document.querySelectorAll('#siteHosts tbody tr').length === ${siteHostInfo.length}`, listsPage);
    check(siteHostInfo.length > 0, 'lists page shows the site-check hosts with their sites');
    // The page disables its forms until its first verified state arrives.
    await until(browser, `!document.querySelector('section[data-list="allowedDomains"] input').disabled`, listsPage);
    await browser.evaluate(`(() => { const form = document.querySelector('section[data-list="allowedDomains"] form');
      form.querySelector('input').value = 'https://www.lists-allow.example/path'; form.requestSubmit(); return true; })()`, listsPage);
    await until(browser, `[...document.querySelectorAll('section[data-list="allowedDomains"] tbody td')].some(cell => cell.textContent === 'lists-allow.example')`, listsPage);
    check((await state()).settings.allowedDomains.includes('lists-allow.example'), 'lists page adds an always-allowed domain');
    await send({ type: 'SET_SITE_PAUSED', domain: 'paused-parent.example', paused: true });
    await send({ type: 'SET_SITE_PAUSED', domain: 'shop.paused-parent.example', paused: true });
    await until(browser, `${rowsOf('whitelistedDomains')} === 2`, listsPage);
    check(true, 'lists page follows changes made elsewhere');
    await browser.evaluate(`[...document.querySelectorAll('section[data-list="whitelistedDomains"] tbody tr')]
      .find(row => row.cells[0].textContent === 'shop.paused-parent.example').querySelector('button').click()`, listsPage);
    await until(browser, `${rowsOf('whitelistedDomains')} === 1`, listsPage);
    check(JSON.stringify((await state()).settings.whitelistedDomains) === '["paused-parent.example"]', 'lists page removes exactly one entry, not its parent');
    await browser.evaluate(`(document.getElementById('filter').value = 'a-ads', document.getElementById('filter').dispatchEvent(new Event('input')), true)`, listsPage);
    check(await browser.evaluate(`document.querySelectorAll('#siteHosts tbody tr').length === 1 && ${rowsOf('allowedDomains')} === 0 &&
      document.getElementById('notice').hidden && document.documentElement.scrollWidth <= innerWidth`, listsPage),
      'lists page filter narrows every table, with no error or horizontal overflow');
    await send({ type: 'REMOVE_ALLOWED_DOMAIN', domain: 'lists-allow.example' });
    await send({ type: 'REMOVE_PAUSED_SITE', domain: 'paused-parent.example' });

    // Flagging: an ad-like request that loads is flagged, never blocked; the lists page decides.
    // localhost is custom-blocked by an earlier check; a blocked request is never flagged.
    // The Block step below adds it back for the checks that follow.
    await send({ type: 'REMOVE_CUSTOM_DOMAIN', domain: 'localhost' });
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false, trackers_ruleset: false, community_ruleset: false } } });
    await browser.evaluate(`(document.getElementById('filter').value = '', document.getElementById('filter').dispatchEvent(new Event('input')), true)`, listsPage);
    await send({ type: 'FLAG_ACTION', action: 'clear' });
    await send({ type: 'UPDATE_SETTINGS', patch: { flagSuspects: false } });
    await browser.open(`http://127.0.0.1:${server.address().port}/flag-fixture`);
    await pause(3500);
    check((await send({ type: 'GET_FLAGS' })).flags.length === 0, 'disabled flagging does not scan an open page');
    await send({ type: 'UPDATE_SETTINGS', patch: { flagSuspects: true } });
    try {
      await until(browser, `api.runtime.sendMessage({type:'GET_FLAGS'}).then(r => r.flags.some(f => f.site === 'localhost' &&
        ['ad-size-frame', 'ad-label'].every(reason => f.reasons.includes(reason))))`);
    } catch (error) {
      // Keep what the flag store and settings held, to explain the failure.
      evidence.flagDebug = { flags: (await send({ type: 'GET_FLAGS' })).flags, settings: (await state()).settings,
        fixtureRequests: requests.filter(url => url.startsWith('/promo/') || url === '/frame' || url === '/flag-fixture') };
      throw error;
    }
    check(requests.includes('/promo/ads/creative.gif?zoneid=7'), 'fixture request loaded while flagging was disabled');
    check(true, 'enabling flagging scans the already-open page and records its ad-sized frame and Sponsored label');
    const flagRow = `[...document.querySelectorAll('#flagTable tbody tr')].find(row => row.cells[0].firstChild.textContent === 'localhost')`;
    await until(browser, `Boolean(${flagRow})`, listsPage);
    check(await browser.evaluate(`${flagRow}.cells[1].textContent.includes('standard ad size')`, listsPage), 'lists page explains why the server was flagged');
    await browser.evaluate('refreshFlagCount().then(() => true)');
    check(await browser.evaluate('/flagged for review/.test(flagStatus.textContent) && flagStatus.classList.contains("has-flags")'), 'popup shows the number of flags waiting');
    await until(browser, `!${flagRow}.querySelectorAll('button')[2].disabled`, listsPage);
    await browser.evaluate(`(${flagRow}.querySelectorAll('button')[2].click(), true)`, listsPage);
    await until(browser, `api.runtime.sendMessage({type:'GET_FLAGS'}).then(r => r.flags.find(f => f.site === 'localhost')?.status === 'ignored')`);
    await until(browser, `document.querySelector('#ignoredFlags tbody tr') && !${flagRow}`, listsPage);
    check(true, 'Ignore moves a flag to the ignored servers');
    await until(browser, `!document.querySelector('#ignoredFlags tbody tr button').disabled`, listsPage);
    await browser.evaluate(`(document.querySelector('#ignoredFlags tbody tr button').click(), true)`, listsPage);
    await until(browser, `Boolean(${flagRow})`, listsPage);
    // Block asks for confirmation; answer it for the test.
    await until(browser, `!${flagRow}.querySelectorAll('button')[0].disabled`, listsPage);
    await browser.evaluate(`(window.confirm = () => true, ${flagRow}.querySelectorAll('button')[0].click(), true)`, listsPage);
    await until(browser, `api.runtime.sendMessage({type:'GET_STATE'}).then(r => r.settings.customBlockedDomains.includes('localhost'))`);
    await until(browser, `api.runtime.sendMessage({type:'GET_FLAGS'}).then(r => !r.flags.some(f => f.site === 'localhost'))`);
    check(true, 'Block adds the server to Custom Blocked Domains and removes its flag');
    await send({ type: 'FLAG_ACTION', action: 'clear' });
    await send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ...defaults.rulesets, community_ruleset: true } } });

    await send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
    check((await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).length === 0, 'master pause disables all static rules');
    check((await browser.evaluate('api.declarativeNetRequest.getDynamicRules()')).length === 0, 'master pause disables all dynamic rules');
    check((await pageScripts()).length === 0, 'master pause removes the YouTube page filter');
    await until(browser, 'getComputedStyle(document.getElementById("ad")).display !== "none"', page);
    check(!(await browser.evaluate(fetchExpression, page)), 'master pause allows the previously blocked local request');
    await send({ type: 'UPDATE_SETTINGS', patch: defaults });
    await until(browser, '!busy && currentSettings.enabled');
    await browser.navigate(browser.popup, `${browserName === 'firefox' ? 'moz' : 'chrome'}-extension://${browser.id}/src/ui/popup/popup.html`);
    await until(browser, 'typeof currentSettings !== "undefined" && currentSettings !== null && !busy');
    check((await state()).ok, 'reopened popup reconciles and verifies saved state');
    check(!(await browser.evaluate('document.documentElement.scrollWidth > innerWidth')), 'popup has no horizontal overflow');
    await browser.screenshot(path.join(temporary, 'popup-final.png'));
    await require('./pages-browser.cjs')({ browser, send, state, until, check, temporary,
      url: file => `${browserName === 'firefox' ? 'moz' : 'chrome'}-extension://${browser.id}/${file}` });
    if (browser.consoleErrors) {
      // Prove the reader sees extension pages before trusting an empty result.
      const canary = 'module-engine-console-canary';
      await browser.evaluate(`(setTimeout(() => { throw new Error(${JSON.stringify(canary)}); }), true)`);
      await until({ evaluate: async () => (await browser.consoleErrors()).some(error => error.text.includes(canary)) },
        'an uncaught error on an extension page reaches the console store');
      const reported = (await browser.consoleErrors()).filter(error => !error.text.includes(canary));
      // Leaving a page with a reply pending is ordinary: Firefox's own wrapPromise
      // logs the dropped reply for that page. Keep it as evidence, as above.
      evidence.closedPageErrors = reported.filter(error => /^Promise (rejected|resolved) (after context unloaded|while context is inactive)/.test(error.text));
      evidence.extensionErrors = reported.filter(error => !evidence.closedPageErrors.includes(error));
      check(evidence.extensionErrors.length === 0, 'no uncaught errors on Firefox extension pages, background or content scripts');
    }
    evidence.success = true;
    const loggedErrors = browser.events.filter(event => event.method === 'Runtime.exceptionThrown' ||
      event.method === 'log.entryAdded' && event.params.level === 'error');
    // Firefox reports intentionally DNR-blocked fetches and WebSockets as network errors.
    // Keep that evidence, but distinguish it from unexpected runtime errors.
    evidence.expectedNetworkErrors = loggedErrors.filter(event => event.params?.source?.context === page.id &&
      (event.params.text?.startsWith('Cross-Origin Request Blocked:') &&
        (event.params.text.includes(`http://localhost:${server.address().port}/blocked-probe.`) ||
         event.params.text.includes('https://blockads-network-guard.invalid/probe.')) ||
       event.params.text?.includes(`ws://localhost:${server.address().port}/ws-blocked`) ||
       event.params.text === `Firefox can’t establish a connection to the server at ws://localhost:${server.address().port}/ws-requested-blocked.`));
    evidence.events = loggedErrors.filter(event => !evidence.expectedNetworkErrors.includes(event));
    check(evidence.events.length === 0, 'no uncaught extension runtime exceptions');
  } catch (error) {
    evidence.success = false; evidence.error = error.stack;
    if (browser) evidence.failurePopup = await browser.evaluate(`({url:location.href,ready:document.readyState,
      status:document.getElementById('statusText')?.textContent,error:document.getElementById('errorPanel')?.textContent,
      busy:document.body.getAttribute('aria-busy')})`).catch(problem => ({error:problem.message}));
    evidence.failureEvents = browser?.events.filter(event => event.method === 'Runtime.exceptionThrown' ||
      event.method === 'Runtime.consoleAPICalled' || event.method === 'log.entryAdded');
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
