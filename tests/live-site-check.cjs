/* Opt-in live compatibility check. Never used by the offline regression suite.
 * Only named public sites and their reviewed service/CDN hosts can leave the
 * loopback proxy. No ad links, accounts, remote code packages, or downloads.
 * The proxy can suppress other providers: DNR events, not missing ads, are the
 * evidence of extension blocking. Baseline keeps reported-threat rules enabled.
 */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { chromium } = require('./browser-smoke.cjs');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sites = [
  { name: 'youtube', url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', media: true },
  // A widely viewed music video, more likely than Big Buck Bunny to carry ads.
  { name: 'youtube-ads', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', media: true },
  { name: 'twitch', url: 'https://www.twitch.tv/valorant', media: true },
  { name: 'fandom', url: 'https://starwars.fandom.com/wiki/Main_Page' },
  { name: 'google', url: 'https://www.google.com/search?q=wireless+headphones&hl=en' }
];
const serviceDomains = [
  'youtube.com', 'youtube-nocookie.com', 'ytimg.com', 'googlevideo.com',
  'ggpht.com', 'gstatic.com', 'google.com', 'googleusercontent.com',
  'googleadservices.com', 'googlesyndication.com', 'doubleclick.net',
  'twitch.tv', 'ttvnw.net', 'jtvnw.net', 'twitchcdn.net',
  'fandom.com', 'wikia.com', 'nocookie.net'
];
const within = (host, domain) => host === domain || host.endsWith('.' + domain);
const redact = value => {
  try { const url = new URL(value); return url.origin + url.pathname.split(';')[0].slice(0, 200); }
  catch { return String(value).slice(0, 200); }
};
const snapshotExpression = `(() => {
  const visible = element => !!(element.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
  const text = document.body?.innerText || '';
  return {
    title: document.title, url: location.href, ready: document.readyState,
    text: text.replace(/^IP address:.*$/gm, 'IP address: [redacted]').slice(0, 1500),
    cosmeticStyle: !!document.getElementById('blockads-cosmetic-shield'),
    // Which ad-schedule fields reached the page's player data (names only).
    youtube: (() => {
      const player = document.getElementById('movie_player');
      const adKeys = data => data && typeof data === 'object' ? ['adPlacements', 'adSlots', 'playerAds'].filter(key => key in data) : null;
      let current = null;
      try { current = player?.getPlayerResponse?.() || null; } catch {}
      return { initialAdKeys: adKeys(window.ytInitialPlayerResponse), playerAdKeys: adKeys(current),
        adShowing: !!player && (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) };
    })(),
    videos: [...document.querySelectorAll('video')].map(v => ({
      currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null,
      paused: v.paused, ended: v.ended, readyState: v.readyState,
      width: v.videoWidth, height: v.videoHeight, error: v.error?.code || null,
      srcHost: (() => { try { return new URL(v.currentSrc).hostname; } catch { return ''; } })()
    })),
    labels: text.split('\\n').filter(line => /ad.?block|sponsored|advertisement|not a bot|unusual traffic|verify you are human|error #|playback error/i.test(line)).slice(0, 35),
    candidateContainers: [...document.querySelectorAll('[data-text-ad], [data-ta-slot], [aria-label="Ads"], [aria-label="Sponsored"], #tads, #bottomads, .ad-slot, .fandom-ad-wrapper, .gpt-ad, ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer')]
      .slice(0, 35).map(e => ({ tag: e.tagName, id: e.id, className: e.className,
        visible: visible(e), text: (e.innerText || '').slice(0, 500),
        attributes: [...e.attributes].filter(a => /^(id|class|data-text-ad|data-ta-slot|aria-label)$/.test(a.name)).map(a => [a.name, a.value]) }))
  };
})()`;

async function main() {
  const browserName = process.argv[2];
  if (!['chrome', 'edge'].includes(browserName) || !process.argv.includes('--allow-live-sites')) {
    throw new Error('Explicit opt-in required: node tests/live-site-check.cjs chrome --allow-live-sites [site]');
  }
  const selected = process.argv[4] ? sites.filter(site => site.name === process.argv[4]) : sites;
  if (!selected.length) throw new Error('Choose youtube, youtube-ads, twitch, fandom, or google.');
  const catalog = JSON.parse(await fs.readFile(path.join(root, 'lists/reviewed-domains.json'), 'utf8'));
  const threats = JSON.parse(await fs.readFile(path.join(root, 'lists/reported-threats.json'), 'utf8'));
  const prohibited = [...catalog.domains.filter(item => item.category === 'unverified').map(item => item.domain),
    ...threats.domains.map(item => item.host)];
  for (const domain of serviceDomains) {
    if (prohibited.some(host => within(host, domain) || within(domain, host))) {
      throw new Error('Live allowlist overlaps an unverified or reported-threat host.');
    }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `blockads-live-${browserName}-`));
  const extension = path.join(temporary, 'extension');
  await fs.mkdir(extension);
  for (const file of ['manifest.json', 'shared.js', 'background.js', 'content.js', 'youtube.js', 'popups.js', 'popup.js', 'popup.html', 'popup.css', 'log.html', 'log.js', 'log.css', 'lists.html', 'lists.js', 'rules', 'icons']) {
    await fs.cp(path.join(root, file), path.join(extension, file), { recursive: true });
  }
  const evidence = { startedAt: new Date().toISOString(), browser: browserName, headed: true,
    sites: selected, sourceHashes: {}, observations: [], checks: [],
    networkGuard: { allowedServiceDomains: serviceDomains, allowed: {}, denied: {}, errors: [],
      policy: 'HTTPS CONNECT to named service domains only; no forwarding or DNS for other hosts; downloads denied',
      limitation: 'Third-party providers outside the allowlist are denied in both phases. Missing ads alone do not prove extension effectiveness.' } };
  for (const file of ['manifest.json', 'shared.js', 'background.js', 'content.js', 'youtube.js', 'popups.js', 'popup.js', 'popup.html', 'popup.css',
    'rules/ads.json', 'rules/trackers.json', 'rules/threats.json', 'rules/threat-policy.json']) {
    evidence.sourceHashes[file] = createHash('sha256').update(await fs.readFile(path.join(extension, file))).digest('hex');
  }
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); return socket; };
  const count = (group, key) => { group[key] = (group[key] || 0) + 1; };
  const proxy = http.createServer((request, response) => {
    count(evidence.networkGuard.denied, request.headers.host || 'invalid-http');
    response.writeHead(403); response.end();
  });
  proxy.on('connection', socket => { track(socket); socket.on('error', () => {}); });
  proxy.on('clientError', (_error, socket) => socket.destroy());
  proxy.on('connect', (request, client, head) => {
    const match = /^([a-z0-9.-]+):443$/i.exec(request.url || '');
    const host = match?.[1].toLowerCase().replace(/\.$/, '');
    if (!host || prohibited.some(domain => within(host, domain)) || !serviceDomains.some(domain => within(host, domain))) {
      count(evidence.networkGuard.denied, host || 'invalid-connect');
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    count(evidence.networkGuard.allowed, host);
    const upstream = track(net.connect({ host, port: 443 }));
    const timer = setTimeout(() => upstream.destroy(new Error('Upstream connection timeout')), 15000);
    upstream.once('connect', () => {
      clearTimeout(timer);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    upstream.on('error', error => {
      if (error.code !== 'ECONNRESET') evidence.networkGuard.errors.push({ host, error: error.code || error.message });
      client.destroy();
    });
    upstream.on('close', () => { clearTimeout(timer); client.destroy(); });
    client.on('close', () => { clearTimeout(timer); upstream.destroy(); });
  });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  let browser;
  console.log(JSON.stringify({ stage: 'starting', output: temporary, sites: selected.map(site => site.name) }));
  try {
    browser = await chromium(extension, path.join(temporary, 'profile'), proxy.address().port, { headless: false });
    evidence.version = browser.version; evidence.launch = browser.launch;
    await browser.send('Browser.setDownloadBehavior', { behavior: 'deny', eventsEnabled: true });
    const state = await browser.evaluate(`chrome.runtime.sendMessage({type:'GET_STATE'})`);
    if (!state.ok || !state.threatStatus.available) throw new Error('Extension protection did not initialize');
    await browser.evaluate(`(() => { globalThis.liveMatches = []; chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
      const url = new URL(info.request.url); liveMatches.push({rule:info.rule, type:info.request.type,
        host:url.hostname, path:url.pathname.split(';')[0].slice(0,200), tabId:info.request.tabId, time:Date.now()});
    }); })()`);
    for (const site of selected) {
      const page = await browser.open('about:blank');
      await browser.send('Network.enable', {}, page);
      await browser.send('Page.enable', {}, page);
      await browser.send('Target.activateTarget', { targetId: page.id });
      for (const enabled of [true, false]) {
        const phase = enabled ? 'enabled' : 'ads-trackers-cosmetics-off';
        const result = await browser.evaluate(`chrome.runtime.sendMessage({type:'UPDATE_SETTINGS',patch:{
          cosmeticFiltering:${enabled},rulesets:{ads_ruleset:${enabled},trackers_ruleset:${enabled}}}})`);
        if (!result.ok) throw new Error(result.error);
        await browser.evaluate('liveMatches = []');
        const eventStart = browser.events.length;
        await browser.send('Network.clearBrowserCache', {}, page);
        await browser.navigate(page, site.url);
        console.log(JSON.stringify({ stage: 'observing', site: site.name, phase }));
        await pause(12000);
        const first = await browser.evaluate(snapshotExpression, page);
        evidence.inProgress = { site: site.name, phase, first };
        await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
        let play = null;
        if (site.media && first.videos.length && !first.videos.some(video => video.ended)) {
          play = await browser.evaluate(`(async () => { const v = document.querySelector('video'); if (!v) return 'no video';
            v.muted = true; return Promise.race([
              v.play().then(() => 'playing', error => error.name + ': ' + error.message),
              new Promise(resolve => setTimeout(() => resolve('play did not settle within 3 seconds'), 3000))
            ]); })()`, page);
        }
        await pause(site.media ? 10000 : 3000);
        const second = await browser.evaluate(snapshotExpression, page);
        const matches = await browser.evaluate('liveMatches');
        const events = browser.events.slice(eventStart).filter(event => event.sessionId === page.session);
        const requests = new Map(events.filter(event => event.method === 'Network.requestWillBeSent')
          .map(event => [event.params.requestId, event.params.request.url]));
        const failures = events.filter(event => event.method === 'Network.loadingFailed').map(event => ({
          url: redact(requests.get(event.params.requestId) || ''), error: event.params.errorText,
          blockedReason: event.params.blockedReason || null, type: event.params.type }));
        const screenshot = `${site.name}-${phase}.png`;
        // Keep comparison screenshots at the same page position, even if a
        // person inspected the visible test window while the page was running.
        await browser.evaluate('window.scrollTo({top:0,left:0,behavior:"instant"})', page);
        const capture = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, page);
        await fs.writeFile(path.join(temporary, screenshot), Buffer.from(capture.data, 'base64'));
        const observation = { site: site.name, phase, first, second, play, matches, failures,
          requestCount: requests.size, screenshot, time: new Date().toISOString() };
        evidence.observations.push(observation);
        delete evidence.inProgress;
        await fs.writeFile(path.join(temporary, 'evidence.json'), JSON.stringify(evidence, null, 2));
        if (site.name.startsWith('youtube')) {
          const samples = [first.youtube, second.youtube];
          evidence.checks.push(`${site.name} ${phase}: initial ad fields ${JSON.stringify(samples.map(s => s.initialAdKeys))}, ` +
            `player ad fields ${JSON.stringify(samples.map(s => s.playerAdKeys))}, ad showing ${JSON.stringify(samples.map(s => s.adShowing))}`);
          if (enabled) {
            assert(samples.every(s => !s.initialAdKeys?.length && !s.playerAdKeys?.length),
              'YouTube player data must not contain ad-schedule fields with filtering enabled');
            assert(!second.youtube.adShowing, 'No YouTube video ad may be playing at the end of the enabled phase');
          }
        }
        if (site.name === 'fandom') {
          const wrappers = second.candidateContainers.filter(item => /\bfandom-ad-wrapper\b/.test(item.className));
          assert(wrappers.length > 0, 'Fandom must expose the ad wrappers being checked');
          assert(enabled ? wrappers.every(item => !item.visible) : wrappers.some(item => item.visible),
            'Fandom ad wrapper visibility must follow the cosmetic setting');
          evidence.checks.push(`Fandom wrappers ${enabled ? 'hidden with filtering enabled' : 'visible when cosmetics are disabled'}`);
        }
        console.log(JSON.stringify({ stage: 'observed', site: site.name, phase, title: second.title,
          labels: second.labels, videos: second.videos, matchedRules: matches.length, requests: requests.size }));
      }
      await browser.send('Target.closeTarget', { targetId: page.id });
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
