/* Owned localhost data/media only; disposable hostname aliases are hashed.
 * No YouTube host, asset, account or remote connection is used. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const player = { videoDetails: { videoId: 'owned-offline' }, streamingData: { keep: true }, adPlacements: [{}], adSlots: [{}], playerAds: [{}] };

async function aliasFixture(extension) {
  const changes = [
    ['src/background/background.js', [
      ['const YOUTUBE_DOMAINS = ["youtube.com", "youtube-nocookie.com"];', 'const YOUTUBE_DOMAINS = ["youtube.com", "youtube-nocookie.com", "127.0.0.1"];'],
      ['matches: YOUTUBE_DOMAINS.flatMap(sitePatterns),', 'matches: YOUTUBE_DOMAINS.filter(domain => domain !== "127.0.0.1").flatMap(sitePatterns).concat("http://127.0.0.1/youtube-fixture*"),']
    ]],
    ['src/blocking/content.js', [
      ['const onYouTube = onSite("youtube.com") || onSite("youtube-nocookie.com");', 'const onYouTube = onSite("youtube.com") || onSite("youtube-nocookie.com") || hostname === "127.0.0.1" && location.pathname === "/youtube-fixture";']
    ]]
  ];
  const records = [];
  for (const [file, replacements] of changes) {
    const original = await fs.readFile(path.join(extension, file), 'utf8'); let modified = original;
    for (const [needle, replacement] of replacements) {
      if (modified.split(needle).length !== 2) throw Error('YouTube fixture alias no longer matches ' + file);
      modified = modified.replace(needle, replacement);
    }
    await fs.writeFile(path.join(extension, file), modified);
    const sha = text => createHash('sha256').update(text).digest('hex');
    records.push({ file, purpose: 'Only loopback /youtube-fixture enables YouTube policy; loopback pauses still apply', originalSha256: sha(original), fixtureSha256: sha(modified) });
  }
  return records;
}

function serve(req, res) {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname === '/youtube-media.wav') {
    // Two seconds of generated PCM silence: real native decoding and seeking.
    const samples = 16000, wav = Buffer.alloc(44 + samples * 2);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    if (start > end || start >= wav.length) { res.writeHead(416, { 'Content-Range': 'bytes */' + wav.length }); res.end(); return true; }
    res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) });
    res.end(wav.subarray(start, end + 1)); return true;
  }
  if (['/youtubei/v1/player', '/youtubei/v1/next', '/ordinary-json'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ envelope: { playerResponse: player } })); return true;
  }
  if (!['/youtube-fixture', '/not-youtube'].includes(url.pathname)) return false;
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><title>Offline YouTube player fixture</title>
    <script>var ytInitialPlayerResponse = ${JSON.stringify(player)};
      window.earlyClean = !ytInitialPlayerResponse.adSlots && ytInitialPlayerResponse.videoDetails.videoId === 'owned-offline';
      window.batch = JSON.parse(${JSON.stringify(JSON.stringify({ parts: Array.from({ length: 20 }, () => ({ playerResponse: player })) }))});
    </script><style>body{font:18px sans-serif;background:#172026;color:#fff;padding:24px}video{width:320px;height:180px;background:#263742}button{padding:12px}</style>
    <h1>Owned offline player fixture</h1><p>No YouTube connection is used.</p>
    <div id="ad" class="ad-slot">Local cosmetic ad canary</div><p id="normal">Ordinary video and page content</p>
    <div id="player" class="html5-video-player"><video id="video" preload="auto" src="/youtube-media.wav"></video><div id="controls"></div></div>
    <video id="outside" preload="none"></video><script>window.p=document.getElementById('player');window.v=document.getElementById('video');window.clicks=0;</script>`);
  return true;
}

async function verify({ browser, send, state, until, check, origin }) {
  const original = (await state()).settings, opened = [];
  const patch = async values => { const result = await send({ type: 'UPDATE_SETTINGS', patch: values }); check(result.ok, 'YouTube settings verified: ' + Object.keys(values)); };
  const open = async route => { const page = await browser.open(origin + route); opened.push(page); await until(browser, 'window.v && document.readyState === "complete"', page); return page; };
  const readScripts = () => browser.evaluate('api.scripting.getRegisteredContentScripts()');
  const logs = async () => (await send({ type: 'GET_LOG' })).entries.filter(entry => entry.message?.includes('Skipped a YouTube video ad')).length;
  try {
    await patch({ enabled: true, rulesets: { ...original.rulesets, ads_ruleset: true }, cosmeticFiltering: true, whitelistedDomains: [], cosmeticPausedDomains: [] });
    const page = await open('/youtube-fixture');
    const evaluate = expression => browser.evaluate(expression, page);
    const wait = async expression => {
      try { await until(browser, expression, page); }
      catch (error) {
        error.message += '\nPlayer state: ' + JSON.stringify(await evaluate(`({ className:p.className, muted:v.muted, rate:v.playbackRate, time:v.currentTime, duration:v.duration, ready:v.readyState, seekable:Array.from({length:v.seekable.length},(_,i)=>[v.seekable.start(i),v.seekable.end(i)]), error:v.error?.message, controls:document.getElementById('controls').innerHTML })`));
        throw error;
      }
    };
    const act = code => evaluate(`(() => { ${code}; return true; })()`);
    await wait('v.duration === 2 && v.seekable.length > 0 && v.seekable.end(v.seekable.length - 1) > 1.9 && document.getElementById("blockads-cosmetic-shield")');
    check(await evaluate('earlyClean && batch.parts.length === 20 && batch.parts.every(part => !part.playerResponse.adSlots && part.playerResponse.streamingData.keep)'), 'native MAIN document_start precedes the first inline script and cleans nested batches');
    check(await evaluate('getComputedStyle(document.getElementById("ad")).display === "none" && getComputedStyle(document.getElementById("normal")).display !== "none"'), 'cosmetic ad filtering and ordinary content remain intact');
    check(await evaluate(`fetch('/youtubei/v1/player').then(r => r.json()).then(data => !data.envelope.playerResponse.playerAds && data.envelope.playerResponse.videoDetails.videoId === 'owned-offline')`), 'native fetch Response.json cleans a player response');
    check(await evaluate(`fetch('/youtubei/v1/next').then(r => r.text()).then(text => !text.includes('"adSlots"') && text.includes('owned-offline'))`), 'native Response.text is cleaned before parsing a same-origin player API');
    check(await evaluate(`fetch('/ordinary-json').then(r => r.text()).then(text => text.includes('"adSlots"'))`), 'unrelated text response bytes are retained');
    check(await evaluate(`fetch('/youtubei/v1/player').then(async r => { const copy=r.clone(); await r.text(); let rejected=false; try { await r.json(); } catch(e) { rejected=e instanceof TypeError; } return rejected && r.bodyUsed && !(await copy.json()).envelope.playerResponse.adSlots; })`), 'native clone, body consumption and rejection semantics remain intact');

    await act('v.playbackRate=1.25; v.muted=false; v.currentTime=0'); await wait('v.currentTime === 0 && v.playbackRate === 1.25');
    const before = await logs();
    await act('p.classList.add("ad-showing")'); // No media event dispatch.
    await wait('v.muted && v.playbackRate === 16 && v.currentTime > 1.9');
    check(true, 'ad class alone triggers mute, acceleration and a real native seek');
    check(await evaluate('!document.getElementById("outside").muted && document.getElementById("outside").playbackRate === 1'), 'video outside the marked player remains untouched');
    check(await logs() === before, 'no skip success is logged while the ad state remains active');
    await act('p.classList.remove("ad-showing")'); await wait('!v.muted && v.playbackRate === 1.25');
    await until(browser, `api.runtime.sendMessage({type:'GET_LOG'}).then(r=>r.entries.filter(e=>e.message?.includes('Skipped a YouTube video ad')).length === ${before + 1})`);
    check(true, 'ending ad state restores native sound/speed and logs one observed skip');

    // Unknown duration: observer/control handling cannot rely on timeupdate.
    await act('v.removeAttribute("src"); v.load(); v.currentTime=0'); await wait('v.readyState === 0');
    // load() resets playbackRate to defaultPlaybackRate in the native element.
    await act('v.playbackRate=1.25; p.classList.add("ad-interrupting")'); await wait('v.muted && v.playbackRate === 16');
    await act(`const button=document.createElement('button'); button.className='ytp-skip-ad-button'; button.textContent='Skip local ad'; button.disabled=true; button.onclick=()=>{clicks++;p.classList.remove('ad-interrupting','ad-showing');}; document.getElementById('controls').append(button);`);
    check(await evaluate('clicks === 0 && v.currentTime === 0 && !Number.isFinite(v.duration)'), 'unknown media is not sought and disabled skip control is not clicked');
    await act('document.querySelector("button").disabled=false'); await wait('clicks === 1 && !v.muted && v.playbackRate === 1.25');
    check(true, 'a dynamically enabled skip control works without a media event');
    await act('document.querySelector("button").remove(); p.classList.add("ad-showing")'); await wait('v.muted');
    await act('v.playbackRate=1.5; v.muted=false; p.classList.remove("ad-showing")'); await wait('v.playbackRate === 1.5 && !v.muted');
    check(true, 'newer user/player sound and speed changes survive restoration');
    await act('p.classList.add("ad-showing")'); await wait('v.muted');
    await act('window.detached=v; v.remove()'); await wait('!detached.muted && detached.playbackRate === 1.5');
    await act('v=document.createElement("video");v.id="replacement";p.prepend(v)'); await wait('v.muted && v.playbackRate === 16');
    check(true, 'removed media is restored and a replacement video is detected');
    await act('p.className="retired-player"'); await wait('!v.muted && v.playbackRate === 1');
    check(true, 'removing the player identity releases owned media changes');
    await act('p.className="html5-video-player ad-showing"'); await wait('v.muted');
    await act('dispatchEvent(new PageTransitionEvent("pagehide", {persisted:true}))');
    check(await evaluate('v.muted && v.playbackRate === 16'), 'synthetic lifecycle events cannot switch off protection');
    await patch({ rulesets: { ...original.rulesets, ads_ruleset: false } }); await wait('!v.muted && v.playbackRate === 1');
    check(!(await readScripts()).some(script => script.id === 'youtube-ads'), 'ad-layer pause removes registration and restores current media');
    const disabled = await open('/youtube-fixture?disabled'); check(await browser.evaluate('!earlyClean && Boolean(ytInitialPlayerResponse.adSlots)', disabled), 'new page stays unfiltered while the ad layer is off');
    await patch({ rulesets: { ...original.rulesets, ads_ruleset: true } }); await wait('v.muted');
    await patch({ cosmeticFiltering: false }); await wait('!document.getElementById("blockads-cosmetic-shield")');
    check(await evaluate('v.muted && v.playbackRate === 16'), 'video fallback is independent of cosmetic hiding');
    await patch({ cosmeticFiltering: true, whitelistedDomains: ['127.0.0.1'] }); await wait('!v.muted');
    check((await readScripts()).find(script => script.id === 'youtube-ads').excludeMatches.some(pattern => pattern.includes('127.0.0.1')), 'native in-place update excludes a paused site');
    const paused = await open('/youtube-fixture?paused'); check(await browser.evaluate('!earlyClean', paused), 'new paused page is excluded before its first script');
    await patch({ whitelistedDomains: [] }); await wait('v.muted');
    check(!(await readScripts()).find(script => script.id === 'youtube-ads').excludeMatches?.length, 'native update with [] clears the exclusion');
    for (let i = 0; i < 4; i++) {
      const [result, fresh] = await Promise.all([send({ type: 'SET_SITE_POPUPS', domain: 'owned.example', blocked: i % 2 === 0 }), open('/youtube-fixture?update=' + i)]);
      check(result.ok && await browser.evaluate('earlyClean', fresh), 'unrelated registration update retains early injection: ' + i);
    }
    const other = await open('/not-youtube');
    await browser.evaluate('(p.classList.add("ad-showing"), v.dispatchEvent(new Event("playing")), true)', other);
    await until(browser, 'document.getElementById("blockads-cosmetic-shield")', other);
    check(await browser.evaluate('!earlyClean && !v.muted && v.playbackRate === 1', other), 'matching-looking player markup outside YouTube is untouched');
    await act(`addEventListener('pagehide', () => sessionStorage.setItem('youtubeHide', JSON.stringify({muted:v.muted,rate:v.playbackRate})), {once:true}); location.href='/not-youtube?departed';`);
    await until(browser, 'location.pathname === "/not-youtube" && document.readyState === "complete"', page);
    check(await evaluate(`JSON.parse(sessionStorage.getItem('youtubeHide')).muted === false && JSON.parse(sessionStorage.getItem('youtubeHide')).rate === 1`), 'trusted navigation restores owned media before the document is cached or discarded');
    await act('history.back()');
    await until(browser, 'location.pathname === "/youtube-fixture" && window.v && document.readyState === "complete"', page);
    await act('p.classList.add("ad-showing")'); await wait('v.muted && v.playbackRate === 16');
    check(true, 'returning through browser history re-enables the authorized fallback');
  } finally {
    for (const page of opened) await browser.closePage(page);
    await patch({ enabled: original.enabled, rulesets: original.rulesets, cosmeticFiltering: original.cosmeticFiltering,
      whitelistedDomains: original.whitelistedDomains, cosmeticPausedDomains: original.cosmeticPausedDomains, popupBlockedDomains: original.popupBlockedDomains });
  }
}
module.exports = { aliasFixture, serve, verify };
