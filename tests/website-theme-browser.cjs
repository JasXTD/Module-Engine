/* Website theme in a real engine: owned localhost pages, real Appearance and
   popup controls, and rendered pixels read back from screenshots. Offline;
   tests/browser-smoke.cjs serves the fixtures and runs verify(). */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
// Light enough that the page filter alone would make it dark (about 80,53,4):
// a mid-tone such as 200,120,60 comes out of the filter almost unchanged.
const SWATCH = [235, 205, 150];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A solid 24-bit bitmap: a raster image with a known colour, no encoder needed.
function bitmap(width, height, [r, g, b]) {
  const row = Math.ceil(width * 3 / 4) * 4, out = Buffer.alloc(54 + row * height);
  out.write('BM', 0, 'latin1'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(width, 18); out.writeInt32LE(height, 22); out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out.set([b, g, r], 54 + y * row + x * 3);
  return out;
}
// Enough PNG decoding for browser screenshots: 8-bit RGB or RGBA, not interlaced.
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Screenshot is not a PNG');
  let offset = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset), kind = buffer.toString('latin1', offset + 4, offset + 8), body = buffer.subarray(offset + 8, offset + 8 + length);
    if (kind === 'IHDR') [width, height, depth, type, interlace] = [body.readUInt32BE(0), body.readUInt32BE(4), body[8], body[9], body[12]];
    else if (kind === 'IDAT') data.push(body);
    else if (kind === 'IEND') break;
    offset += 12 + length;
  }
  if (depth !== 8 || ![2, 6].includes(type) || interlace) throw new Error(`Unsupported screenshot PNG: depth ${depth}, type ${type}, interlace ${interlace}`);
  const channels = type === 6 ? 4 : 3, stride = width * channels, raw = zlib.inflateSync(Buffer.concat(data)), pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0, up = y ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left; else if (filter === 2) value += up; else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) { const p = left + up - corner, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - corner); value += a <= b && a <= c ? left : b <= c ? up : corner; }
      pixels[y * stride + x] = value & 255;
    }
  }
  return { width, height, at: (x, y) => [...pixels.subarray((y * width + x) * channels, (y * width + x) * channels + 3)] };
}

const page = body => `<!doctype html><html><head><meta charset="utf-8"><title>Website theme fixture</title><style>
  html, body, p { margin: 0; } body { font: 16px sans-serif; color: #111; background: #fff; min-height: 100vh; }
  #swatch { position: absolute; left: 20px; top: 20px; width: 80px; height: 80px; }
  #frame { position: absolute; left: 130px; top: 20px; width: 180px; height: 80px; border: 0; }
  #words { position: absolute; left: 20px; top: 120px; margin: 0; }
  #dialog { position: fixed; inset: 160px auto auto 20px; margin: 0; width: 200px; height: 60px; padding: 0; border: 0; background: #fff; color: #111; }
  .night { background: #101214; color: #eee; }
</style></head><body>${body}</body></html>`;
function serve(req, res) {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (!url.pathname.startsWith('/website-theme/')) return false;
  const port = req.socket.localPort;
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/website-theme/swatch.bmp') { res.setHeader('Content-Type', 'image/bmp'); res.end(bitmap(8, 8, SWATCH)); return true; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/website-theme/light') res.end(page(`<img id="swatch" src="/website-theme/swatch.bmp" alt="">
    <iframe id="frame" title="Cross-origin light frame" src="http://localhost:${port}/website-theme/frame"></iframe>
    <p id="words">Plain words on a white page.</p><dialog id="dialog"><p>A dialog on white.</p></dialog>`));
  else if (url.pathname === '/website-theme/frame') res.end(page('<p>A light frame from another origin.</p>'));
  else if (url.pathname === '/website-theme/dark') res.end(page('<p>Already dark.</p>').replace('<body>', '<body class="night">'));
  else if (url.pathname === '/website-theme/late') res.end(page('<p>Turns dark after it loads.</p>'));
  // Real-world patterns: a cookie notice dimming the window, a dialog whose backdrop
  // wraps it, a dark banner over a light page, and an app root with its own dark theme.
  else if (url.pathname === '/website-theme/consent') res.end(page(`<p id="words">Words behind a cookie notice.</p>
    <div id="notice" style="position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.6)">
    <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:260px;height:90px;background:#fff">We use cookies.</div></div>`));
  else if (url.pathname === '/website-theme/modal') res.end(page(`<p id="words">Words behind a dialog.</p><script>window.openModal = () => {
    document.body.classList.add('modal-open');
    document.body.insertAdjacentHTML('beforeend', '<div id="backdrop" style="position:fixed;inset:0;z-index:10;background:rgba(0,0,0,.5)"><div style="margin:30vh auto;width:260px;height:90px;background:#fff">A dialog.</div></div>');
  };</script>`));
  else if (url.pathname === '/website-theme/banner') res.end(page(`<header style="position:absolute;inset:0 0 auto 0;height:62vh;background:#16213e"></header>
    <p id="words" style="top:80vh">Light content below a dark banner.</p>`));
  else if (url.pathname === '/website-theme/app') res.end(page(`<style>#app { min-height: 100vh; } #app.dark { background: #111; color: #eee; }</style>
    <div id="app"><p id="words">An app root.</p></div><script>window.goDark = () => { document.getElementById('app').className = 'dark'; };</script>`));
  else { res.statusCode = 404; res.end('Not found'); }
  return true;
}

async function verify({ browser, until, check, temporary, origin, url, popup }) {
  const wait = (expression, target) => until(browser, expression, target);
  const opened = [];
  const open = async address => { const target = await browser.open(address); opened.push(target); await wait('document.readyState === "complete"', target); return target; };
  const state = target => browser.evaluate('document.documentElement.getAttribute("data-module-engine-dark")', target);
  const settled = (target, value) => wait(`document.documentElement.getAttribute("data-module-engine-dark") === ${JSON.stringify(value)}`, target);
  const stored = target => browser.evaluate('(globalThis.browser||chrome).storage.local.get("appearance").then(saved=>JSON.stringify(saved.appearance||null))', target).then(JSON.parse);
  // Pointer clicks, as a person would make them; a click lost to a re-render is repeated.
  const click = async (target, selector) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await wait(`(node => node && !node.disabled && node.getClientRects().length > 0)(document.querySelector(${JSON.stringify(selector)}))`, target);
      const point = await browser.evaluate(`(() => {const node=document.querySelector(${JSON.stringify(selector)});node.scrollIntoView({block:'center',behavior:'instant'});
        globalThis.clickArrived=false;addEventListener('click',event=>{if(node.contains(event.target))globalThis.clickArrived=true;},{capture:true,once:true});
        const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`, target);
      await browser.clickAt(point.x, point.y, target);
      if (await browser.evaluate('globalThis.clickArrived', target)) return;
    }
    throw new Error('Pointer clicks never reached ' + selector);
  };
  const scheme = async (value, targets) => {
    if (!browser.send) return browser.setColorScheme(value);
    for (const target of targets) await browser.send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-color-scheme', value }] : [] }, target);
  };
  // A background tab does not render, so it hears about a new colour scheme only once shown.
  const front = target => browser.send ? browser.send('Target.activateTarget', { targetId: target.id }) : browser.front(target);
  // Rendered pixels at points within elements ([selector, x, y] as fractions,
  // centre by default), then a page-background point, in CSS pixels.
  const pixels = async (target, name, selectors) => {
    const spots = selectors.map(item => Array.isArray(item) ? item : [item, 0.5, 0.5]);
    const points = await browser.evaluate(`(${JSON.stringify(spots)}).map(([selector, x, y]) => {const r=document.querySelector(selector).getBoundingClientRect();
      return [Math.round(r.x+r.width*x),Math.round(r.y+r.height*y)];}).concat([[innerWidth-40,innerHeight-40]]).concat([[innerWidth]])`, target);
    const file = path.join(temporary, 'website-theme-' + name + '.png');
    if (browser.send) {
      await browser.send('Target.activateTarget', { targetId: target.id });
      const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, target);
      await fs.writeFile(file, Buffer.from(data, 'base64'));
    } else await browser.screenshot(file, target);
    const image = decodePng(await fs.readFile(file)), scale = image.width / points.pop()[0];
    return points.map(([x, y]) => image.at(Math.round(x * scale), Math.round(y * scale)));
  };
  // Whole-page screenshots kept with the evidence for visual review.
  const capture = async (target, name) => {
    const file = path.join(temporary, 'website-theme-' + name + '.png');
    if (!browser.send) return browser.screenshot(file, target);
    if (target === popup) return browser.screenshot(file);
    await browser.send('Target.activateTarget', { targetId: target.id });
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, target);
    await fs.writeFile(file, Buffer.from(data, 'base64'));
  };
  // Frames apply changes on their own schedule, so wait until the pixels agree.
  const sample = async (target, name, selectors, accept) => {
    let colours = await pixels(target, name, selectors);
    for (let attempt = 0; attempt < 30 && !accept(colours); attempt++) { await pause(100); colours = await pixels(target, name, selectors); }
    return colours;
  };
  const dark = colour => Math.max(...colour) < 60, white = colour => Math.min(...colour) > 225;
  const nearer = (colour, wanted) => colour.reduce((sum, value, index) => sum + Math.abs(value - wanted[index]), 0) <
    colour.reduce((sum, value, index) => sum + Math.abs(value - (255 - wanted[index])), 0);

  const light = await open(origin + '/website-theme/light');
  check(await browser.evaluate('!document.documentElement.hasAttribute("data-module-engine-dark") && !document.getElementById("module-engine-website-theme")', light),
    'websites carry no website-theme trace while it is off');
  const appearance = await open(url('src/ui/appearance/appearance.html'));
  await wait('!document.getElementById("websitesEnabled").disabled', appearance);
  const popupSite = await browser.evaluate('activeHostname', popup);
  try {
    await click(appearance, 'label:has(> input[name="mode"][value="dark"])');
    await wait(`(globalThis.browser||chrome).storage.local.get("appearance").then(saved=>saved.appearance?.mode==="dark")`, appearance);
    check(await state(light) === null, 'a dark Module Engine theme alone leaves websites alone');
    await click(appearance, '.website-switch');
    await settled(light, 'on');
    check(true, 'switching websites on darkens an open light page without a reload');
    check(await browser.evaluate(`(() => {const filter=node=>getComputedStyle(node).filter;
      return filter(document.documentElement).includes('invert(0.95)') && filter(document.getElementById('swatch')).includes('invert(1)') &&
        filter(document.getElementById('frame')).includes('invert(1)') && filter(document.getElementById('words')) === 'none';})()`, light),
      'the page is inverted and its image and frame are turned back');
    let [swatch, frame, , background] = await sample(light, 'on', ['#swatch', ['#frame', 0.08, 0.85], '#words'], ([, inner, , page]) => dark(inner) && dark(page));
    check(dark(background), `a white page renders dark (${background})`);
    check(nearer(swatch, SWATCH), `an image keeps its own colours (${swatch} for ${SWATCH})`);
    check(dark(frame), `a light cross-origin frame darkens itself inside a dark page (${frame})`);
    await browser.evaluate('(document.getElementById("dialog").showModal(), true)', light);
    const [dialog, behind] = await pixels(light, 'dialog', ['#dialog']);
    check(dark(dialog), `a modal dialog in the top layer is dark too (${dialog})`);
    check(Math.max(...behind) <= Math.max(...background) + 4, `its backdrop dims the page instead of lightening it (${behind} behind, ${background} before)`);
    await browser.evaluate('(document.getElementById("dialog").close(), true)', light);

    const already = await open(origin + '/website-theme/dark');
    await settled(already, 'off');
    check(await browser.evaluate('getComputedStyle(document.documentElement).filter === "none"', already), 'an already dark page keeps its own colours');
    const late = await open(origin + '/website-theme/late');
    await settled(late, 'on');
    await browser.evaluate('(document.body.classList.add("night"), true)', late);
    await settled(late, 'off');
    check(true, 'a page that switches to its own dark theme is left alone from then on');

    // A dimming layer is looked through: the page behind a cookie notice is light,
    // so it is darkened from the start and stays dark once the notice is gone.
    const consent = await open(origin + '/website-theme/consent');
    await settled(consent, 'on');
    await browser.evaluate('(document.getElementById("notice").remove(), true)', consent);
    const [, consentPage] = await sample(consent, 'consent', ['#words'], ([, page]) => dark(page));
    check(await state(consent) === 'on' && dark(consentPage), `a light page behind a cookie notice is dark from the start (${consentPage} once dismissed)`);
    const modal = await open(origin + '/website-theme/modal');
    await settled(modal, 'on');
    await browser.evaluate('(openModal(), true)', modal);
    // A body class is checked on the next frame; this outlasts any paced check too.
    await pause(900);
    check(await state(modal) === 'on', 'opening a dialog whose backdrop wraps it leaves the page dark');
    const banner = await open(origin + '/website-theme/banner');
    await settled(banner, 'on');
    const [, bannerPage] = await sample(banner, 'banner', ['#words'], ([, page]) => dark(page));
    check(dark(bannerPage), `a light page with a dark banner across the top of the window is darkened (${bannerPage})`);
    const app = await open(origin + '/website-theme/app');
    await settled(app, 'on');
    await browser.evaluate('(goDark(), true)', app);
    await settled(app, 'off');
    const [, appPage] = await sample(app, 'app', ['#words'], ([, page]) => dark(page));
    check(dark(appPage), `an app root that switches to its own dark theme after loading keeps it (${appPage})`);

    // The popup's switch for the current site; the popup tab names the fixture as its site.
    await browser.evaluate('(activeHostname = "127.0.0.1", renderWebsiteTheme(), true)', popup);
    await wait('!websiteThemeRow.hidden && toggleWebsiteTheme.checked && !toggleWebsiteTheme.disabled', popup);
    await capture(popup, 'popup');
    await click(popup, '#toggleWebsiteTheme');
    await settled(light, 'off');
    check(JSON.stringify((await stored(popup)).websiteExceptions) === '["127.0.0.1"]', 'the popup switch keeps this site in its own colours');
    [, frame, , background] = await sample(light, 'excepted', ['#swatch', ['#frame', 0.08, 0.85], '#words'], ([, inner, , page]) => white(inner) && white(page));
    check(white(background) && white(frame), `an excepted site and its cross-origin frames keep their colours (${background}; ${frame})`);
    await click(popup, '#toggleWebsiteTheme');
    await settled(light, 'on');
    check(JSON.stringify((await stored(popup)).websiteExceptions) === '[]', 'switching it back removes the exception');

    await click(appearance, 'label:has(> input[name="mode"][value="light"])');
    await settled(light, 'off');
    check(true, 'a light Module Engine theme returns websites to their own colours');
    await click(appearance, 'label:has(> input[name="mode"][value="system"])');
    await front(light);
    await scheme('dark', [light, appearance]);
    await settled(light, 'on');
    await scheme('light', [light, appearance]);
    await settled(light, 'off');
    check(true, 'System follows the device: dark websites while it is dark, their own colours while it is light');
    await scheme(null, [light, appearance]);

    await click(appearance, 'label:has(> input[name="mode"][value="dark"])');
    await browser.navigate(light, origin + '/website-theme/light');
    await wait('document.readyState === "complete" && document.documentElement.getAttribute("data-module-engine-dark") === "on"', light);
    check(true, 'a page loaded while the theme is on comes up dark');

    // Appearance's own list takes typed sites, and Reset leaves websites alone.
    await click(appearance, '#exceptionInput');
    await browser.typeText('https://www.Example.org/path', appearance);
    await click(appearance, '#addException');
    await wait(`(globalThis.browser||chrome).storage.local.get("appearance").then(saved=>JSON.stringify(saved.appearance?.websiteExceptions)==='["example.org"]')`, appearance);
    check(await browser.evaluate('document.getElementById("exceptionInput").value==="" && document.querySelector("#exceptionList li span").textContent==="example.org"', appearance),
      'a site typed into Appearance is saved as its hostname and listed');
    await capture(appearance, 'appearance');
    await click(appearance, '#resetAppearance');
    await wait('document.getElementById("status").textContent === "Restored the default theme and accent colour."', appearance);
    const afterReset = await stored(appearance);
    check(afterReset.mode === 'system' && afterReset.websites === true && JSON.stringify(afterReset.websiteExceptions) === '["example.org"]',
      'Reset restores the theme and colour but keeps the website setting and its sites');
    await click(appearance, '#exceptionList button[aria-label="Remove example.org"]');
    await wait('!document.querySelector("#exceptionList li") && !document.getElementById("exceptionEmpty").hidden && getComputedStyle(document.getElementById("exceptionEmpty")).display !== "none"', appearance);
    check(JSON.stringify((await stored(appearance)).websiteExceptions) === '[]', 'Remove takes a site off the list');
    await click(appearance, '.website-switch');
    await wait('!document.documentElement.hasAttribute("data-module-engine-dark") && !document.getElementById("module-engine-website-theme")', light);
    check(true, 'switching websites off removes every trace from open pages');
  } finally {
    await browser.evaluate(`(activeHostname = ${JSON.stringify(popupSite)}, renderWebsiteTheme(), true)`, popup).catch(() => {});
    await browser.evaluate('(globalThis.browser||chrome).storage.local.remove("appearance").then(()=>true)', appearance).catch(() => {});
    await scheme(null, opened).catch(() => {});
    for (const target of opened) await browser.closePage(target).catch(() => {});
  }
}

module.exports = { serve, verify, decodePng, bitmap };
