/* Opt-in ad check for one public HTTPS page that the person names.
 * Loads the page twice in a fresh, headless, signed-out Chrome/Edge profile:
 * first with every BlockAds layer on, then with the ad, tracker and cosmetic
 * layers off (reported threats stay on in both). No clicks, typing or
 * downloads. Only HTTPS CONNECT on port 443 leaves the loopback proxy, and
 * reported or unverified hosts are refused. Page text is not recorded: only
 * request hosts, extension blocks, ad-shaped elements and screenshots.
 *
 *   node tests/site-ad-check.cjs chrome https://example.com/page --allow-live-sites [--visible] [--click]
 *
 * --visible uses an ordinary browser window instead of headless mode. Nothing
 * disguises the browser, and verification challenges are never solved.
 * --click makes one real click on an empty page area after the screenshots,
 * to expose click-triggered pop-ups. window.open calls are recorded and
 * refused instead of opened; any other new tab is recorded and closed.
 */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { chromium } = require('./browser-smoke.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (host, domain) => host === domain || host.endsWith('.' + domain);
const EXTENSION_FILES = ['manifest.json', 'shared.js', 'background.js', 'content.js', 'youtube.js',
  'popup.js', 'popup.html', 'popup.css', 'log.html', 'log.js', 'log.css', 'rules', 'icons'];

// Runs in the page. Returns element metadata only, never page text.
const snapshotExpression = `(() => {
  const shown = element => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width >= 30 && box.height >= 30 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity) > 0.05;
  };
  const size = element => { const box = element.getBoundingClientRect(); return [Math.round(box.width), Math.round(box.height)]; };
  const hostOf = value => { try { return new URL(value, location.href).hostname; } catch { return ''; } };
  const label = element => (element.tagName + (element.id ? '#' + element.id : '') +
    (typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\\s+/).join('.') : '')).slice(0, 120);
  // Common ad naming, including "gg" (guanggao) used by Chinese-language sites.
  const adName = /(^|[-_\\s])(ad|ads|adv|advert|advertisement|adsbygoogle|banner|sponsor|sponsored|gg|guanggao|promo)([-_\\s0-9]|$)/i;
  const frames = [...document.querySelectorAll('iframe')].map(frame => ({ host: hostOf(frame.src), shown: shown(frame), size: size(frame) }));
  const adLike = [...document.querySelectorAll('body *')].filter(element =>
    adName.test(element.id || '') || adName.test(typeof element.className === 'string' ? element.className : ''))
    .filter(shown)
    .map(element => ({ label: label(element), size: size(element) }));
  const overlays = [...document.querySelectorAll('body *')].filter(element => {
    const style = getComputedStyle(element);
    if (!['fixed', 'sticky'].includes(style.position) || !shown(element)) return false;
    const [w, h] = size(element);
    return w * h >= 15000 && element.querySelector('img, iframe, a[target="_blank"], video, canvas');
  }).map(element => ({ label: label(element), size: size(element) }));
  return {
    title: document.title.slice(0, 120), finalUrl: location.origin + location.pathname,
    frames, shownFrames: frames.filter(frame => frame.shown).length,
    adLike: adLike.slice(0, 60), adLikeCount: adLike.length,
    overlays: overlays.slice(0, 30), overlayCount: overlays.length,
    cosmeticStyle: !!document.getElementById('blockads-cosmetic-shield'),
    height: document.documentElement.scrollHeight
  };
})()`;

async function main() {
  const [, , browserName, target] = process.argv;
  let url;
  try { url = new URL(target); } catch { url = null; }
  if (!['chrome', 'edge'].includes(browserName) || !process.argv.includes('--allow-live-sites') || url?.protocol !== 'https:') {
    throw new Error('Explicit opt-in required: node tests/site-ad-check.cjs chrome https://site/page --allow-live-sites');
  }
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'lists/reviewed-domains.json'), 'utf8'));
  const threats = JSON.parse(await fs.readFile(path.join(root, 'lists/reported-threats.json'), 'utf8'));
  const prohibited = [...catalog.domains.filter(item => item.category === 'unverified').map(item => item.domain),
    ...threats.domains.map(item => item.host)];
  if (prohibited.some(host => within(url.hostname, host))) throw new Error('The page host is a reported or unverified host.');

  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-site-${browserName}-`));
  const extension = path.join(temporary, 'extension');
  await fs.mkdir(extension);
  for (const file of EXTENSION_FILES) await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  const headless = !process.argv.includes('--visible');
  const click = process.argv.includes('--click');
  const evidence = { startedAt: new Date().toISOString(), browser: browserName, page: url.origin + url.pathname, headless,
    policy: 'HTTPS CONNECT :443 only; reported/unverified hosts refused; downloads denied; no clicks or typing; page text not recorded',
    phases: {} };

  let phase = 'startup';
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
  const tally = (kind, host) => {
    const group = (evidence.phases[phase] ??= {}).proxy ??= { allowed: {}, denied: {} };
    group[kind][host] = (group[kind][host] || 0) + 1;
  };
  // Some servers omit their intermediate certificate, and the browser then
  // fetches it over plain HTTP from the issuer. Forward only such certificate
  // file downloads (size-capped); every other plain-HTTP request is refused.
  const proxy = http.createServer((request, response) => {
    let target;
    try { target = new URL(request.url); } catch { target = null; }
    const host = target?.hostname.toLowerCase() || 'invalid';
    if (request.method !== 'GET' || target?.protocol !== 'http:' || target.port && target.port !== '80' ||
        !/\.(cer|crt|der|p7c)$/i.test(target.pathname) || prohibited.some(domain => within(host, domain))) {
      tally('denied', 'http:' + host);
      response.writeHead(403); response.end();
      return;
    }
    tally('allowed', 'http-certificate:' + host);
    const upstream = http.get(target, { timeout: 10000 }, reply => {
      if (Number(reply.headers['content-length'] || 0) > 65536) { reply.destroy(); response.destroy(); return; }
      let received = 0;
      reply.on('data', chunk => { received += chunk.length; if (received > 65536) { reply.destroy(); response.destroy(); } });
      response.writeHead(reply.statusCode, { 'Content-Type': reply.headers['content-type'] || 'application/pkix-cert' });
      reply.pipe(response);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  proxy.on('connection', socket => { track(socket); socket.on('error', () => {}); });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('connect', (request, client, head) => {
    client.on('error', () => {});
    const match = /^([a-z0-9.-]+):443$/i.exec(request.url || '');
    const host = match?.[1].toLowerCase().replace(/\.$/, '');
    if (!host || prohibited.some(domain => within(host, domain))) {
      tally('denied', host || 'invalid-connect');
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    tally('allowed', host);
    const upstream = track(net.connect({ host, port: 443 }));
    const timer = setTimeout(() => upstream.destroy(new Error('Upstream connection timeout')), 15000);
    upstream.once('connect', () => {
      clearTimeout(timer);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => { clearTimeout(timer); client.destroy(); });
    client.on('close', () => { clearTimeout(timer); upstream.destroy(); });
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');

  let browser;
  console.log(JSON.stringify({ stage: 'starting', output: temporary, page: evidence.page }));
  try {
    browser = await chromium(extension, path.join(temporary, 'profile'), proxy.address().port, { headless });
    evidence.version = browser.version.product;
    await browser.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    const state = await browser.evaluate(`chrome.runtime.sendMessage({type:'GET_STATE'})`);
    if (!state.ok) throw new Error('Extension protection did not initialize');
    await browser.evaluate(`(() => { globalThis.liveMatches = []; chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
      liveMatches.push({ruleset: info.rule.rulesetId, host: new URL(info.request.url).hostname, type: info.request.type});
    }); })()`);
    const page = await browser.open('about:blank');
    await browser.send('Network.enable', {}, page);
    await browser.send('Page.enable', {}, page);
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, page);
    const initialPages = new Set((await browser.send('Target.getTargets')).targetInfos.filter(info => info.type === 'page').map(info => info.targetId));
    if (click) {
      // Test instrumentation, installed before page scripts: record pop-up
      // attempts and refuse them, so the ad destination is never loaded.
      await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const attempts = [];
        Object.defineProperty(window, '__blockadsTestOpened', { value: attempts });
        window.open = new Proxy(window.open, { apply: (_target, _self, args) => { attempts.push(String(args[0] ?? '').slice(0, 300)); return null; } });
      })()` }, page);
    }
    for (const enabled of [true, false]) {
      phase = enabled ? 'blockads-on' : 'ads-trackers-cosmetics-off';
      const result = await browser.evaluate(`chrome.runtime.sendMessage({type:'UPDATE_SETTINGS',patch:{enabled:true,
        cosmeticFiltering:${enabled},rulesets:{ads_ruleset:${enabled},trackers_ruleset:${enabled},threats_ruleset:true}}})`);
      if (!result.ok) throw new Error(result.error);
      await browser.send('Network.clearBrowserCache', {}, page);
      await browser.send('Network.clearBrowserCookies', {}, page);
      await browser.evaluate('liveMatches = []');
      const eventStart = browser.events.length;
      console.log(JSON.stringify({ stage: 'loading', phase }));
      await browser.navigate(page, url.href);
      await pause(12000);
      // Scroll (no clicks) so lazily loaded ad slots appear, then return to the top.
      await browser.evaluate(`(async () => { for (let i = 0; i < 8; i++) { scrollBy(0, innerHeight * 0.8); await new Promise(r => setTimeout(r, 600)); } })()`, page)
        .catch(() => {});
      await pause(3000);
      const bottom = await browser.evaluate(snapshotExpression, page).catch(error => ({ error: String(error).slice(0, 300) }));
      await browser.evaluate('scrollTo({top: 0, behavior: "instant"})', page).catch(() => {});
      await pause(1500);
      const top = await browser.evaluate(snapshotExpression, page).catch(error => ({ error: String(error).slice(0, 300) }));
      const shot = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
      await fs.writeFile(path.join(temporary, `${phase}.png`), Buffer.from(shot.data, 'base64'));
      const { cssContentSize } = await browser.send('Page.getLayoutMetrics', {}, page);
      const full = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 1280, height: Math.min(Math.ceil(cssContentSize.height), 4000), scale: 0.5 } }, page);
      await fs.writeFile(path.join(temporary, `${phase}-full.png`), Buffer.from(full.data, 'base64'));

      const hostOf = value => { try { return new URL(value).hostname; } catch { return ''; } };
      let clicked = null;
      if (click) {
        // Pick a point whose element is not a link, control or frame, as a reader's stray click would be.
        const point = await browser.evaluate(`(() => {
          for (let y = 300; y < innerHeight - 50; y += 60) for (let x = 100; x < innerWidth - 100; x += 120) {
            const element = document.elementFromPoint(x, y);
            if (element && !element.closest('a, button, input, select, textarea, iframe, video, [onclick]')) {
              return { x, y, target: element.tagName + (element.id ? '#' + element.id : '') };
            }
          }
          return null;
        })()`, page);
        const startUrl = (await browser.evaluate('location.href', page)).split('?')[0];
        if (point) {
          for (const type of ['mousePressed', 'mouseReleased']) {
            await browser.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, page);
          }
          await pause(5000);
        }
        const endUrl = await browser.evaluate('location.href', page).catch(() => '');
        clicked = { point, windowOpen: await browser.evaluate('window.__blockadsTestOpened ? [...window.__blockadsTestOpened] : []', page)
          .catch(() => ['(page changed before reading)']), navigatedTo: endUrl.split('?')[0] === startUrl ? null : hostOf(endUrl) };
        clicked.windowOpen = clicked.windowOpen.map(value => {
          try { return hostOf(new URL(value, url).href) || value.slice(0, 40); } catch { return value.slice(0, 40); }
        });
      }

      const events = browser.events.slice(eventStart).filter(event => event.sessionId === page.session);
      const requests = new Map(events.filter(event => event.method === 'Network.requestWillBeSent')
        .map(event => [event.params.requestId, hostOf(event.params.request.url)]));
      // Third-party request shapes and the script or document that asked for them.
      const initiatorOf = initiator => initiator?.url || initiator?.stack?.callFrames?.[0]?.url ||
        initiator?.stack?.parent?.callFrames?.[0]?.url || '';
      const siteHost = url.hostname.replace(/^www\./, '');
      const thirdParty = events.filter(event => event.method === 'Network.requestWillBeSent' &&
        !within(hostOf(event.params.request.url), siteHost)).map(event => {
        const request = new URL(event.params.request.url);
        return { host: request.hostname, path: request.pathname.slice(0, 120), type: event.params.type,
          initiator: hostOf(initiatorOf(event.params.initiator)) };
      });
      const blockedByExtension = events.filter(event => event.method === 'Network.loadingFailed' &&
        event.params.errorText === 'net::ERR_BLOCKED_BY_CLIENT').map(event => requests.get(event.params.requestId));
      const count = list => Object.fromEntries([...list.reduce((map, item) => map.set(item, (map.get(item) || 0) + 1), new Map())]
        .sort((a, b) => b[1] - a[1]));
      const matches = await browser.evaluate('liveMatches');
      const { targetInfos } = await browser.send('Target.getTargets');
      const extraPages = targetInfos.filter(info => info.type === 'page' && !initialPages.has(info.targetId) && info.targetId !== browser.popup.id);
      for (const info of extraPages) await browser.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
      Object.assign(evidence.phases[phase] ??= {}, {
        top, bottom, clicked, thirdParty, requestCount: requests.size, requestHosts: count([...requests.values()]),
        blockedByExtension: count(blockedByExtension), ruleMatches: count(matches.map(item => `${item.ruleset} ${item.host}`)),
        popups: extraPages.map(info => hostOf(info.url) || info.url.slice(0, 40)),
        downloads: browser.events.slice(eventStart).filter(event => event.method === 'Browser.downloadWillBegin').length
      });
      await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
      console.log(JSON.stringify({ stage: 'observed', phase, title: top.title, requests: requests.size,
        blocked: blockedByExtension.length, shownFrames: bottom.shownFrames, adLike: bottom.adLikeCount, overlays: bottom.overlayCount,
        popups: extraPages.length, clicked }));
    }
    evidence.completed = true;
  } catch (error) {
    evidence.error = error.stack; process.exitCode = 1;
  } finally {
    if (browser) {
      try { evidence.cleanup = await browser.close(); if (!evidence.cleanup.closed) throw new Error('Isolated browser cleanup failed'); }
      catch (error) { evidence.cleanupError = error.stack; process.exitCode = 1; }
    }
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    evidence.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ stage: 'finished', completed: evidence.completed || false,
      evidence: path.join(temporary, 'evidence.json'), cleanup: evidence.cleanup, error: evidence.error }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
