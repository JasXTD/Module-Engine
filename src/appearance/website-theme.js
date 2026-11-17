/* Website theme: a dark version of light websites while Module Engine's theme
   is dark and Appearance applies it to websites. Runs at document_start in
   every frame of HTTP(S) pages, after src/shared/appearance-settings.js, and
   changes nothing on a page while the setting is off.

   This is a filter-based dark mode. The page is inverted with its hues kept;
   images, video, canvases and embedded frames are turned back. Each frame
   themes its own document, which is why parents turn frames back. Pages that
   are already dark are recognised from their own colours, which a filter does
   not change in computed styles, and left alone. */
(() => {
  'use strict';
  const root = document.documentElement;
  // XML, SVG and other non-HTML documents keep their own rendering.
  if (!(root instanceof HTMLHtmlElement) || globalThis.ModuleEngineWebsiteTheme) return;
  globalThis.ModuleEngineWebsiteTheme = true;
  const api = globalThis.browser || globalThis.chrome;
  const settings = globalThis.ModuleEngineAppearance;
  const ATTRIBUTE = 'data-module-engine-dark', STYLE_ID = 'module-engine-website-theme';
  const MEDIA = 'img, video, canvas, iframe, frame, embed, object, svg image, [style*="background-image"]';
  // Attributes sites switch their own themes with. Inline styles are left out:
  // many pages rewrite them on every scroll frame.
  const THEME_ATTRIBUTES = ['class', 'data-theme', 'data-color-mode', 'data-color-scheme', 'data-bs-theme', 'dark', 'theme'];
  // Points sampled in the window, and how many of them the page's own background
  // is worth: a dark banner across part of the first screen does not make a light
  // page dark, while a page whose content is dark at every point is.
  const SAMPLES = [[0.5, 0.5], [0.25, 0.3], [0.75, 0.3], [0.25, 0.75], [0.75, 0.75]], BASE_WEIGHT = 3;
  // After loading, a theme change below <body> is checked at most this often:
  // busy pages change classes deep in the page all the time.
  const RECHECK_MS = 500;
  // Measured in Chrome 157 and Firefox 160: Firefox's root filter also covers the
  // top layer (modal dialogs, popovers and their backdrops); Chrome's covers
  // neither it nor the page scrollbar. tests/website-theme-browser.cjs checks
  // the rendered pixels in both.
  const rootFilterCoversTopLayer = /\bFirefox\/\d/.test(navigator.userAgent);
  const ON = `:root[${ATTRIBUTE}="on"]`, PAGE = 'invert(0.95) hue-rotate(180deg)', BACK = 'invert(1) hue-rotate(180deg)';
  const CSS = `@media screen and (forced-colors: none) {
  ${ON} { filter: ${PAGE} !important; }
  /* Chrome leaves the canvas behind the root unfiltered; this filtered layer covers it. */
  ${ON}::before { content: "" !important; display: block !important; position: fixed !important; inset: 0 !important;
    z-index: -2147483648 !important; background: #fff !important; pointer-events: none !important; }
  /* Media keeps its own colours. SVG images are usually icons drawn in the text colour. */
  ${ON} :where(${MEDIA}):not(:where(img[src*=".svg"], img[src^="data:image/svg"])):not(:where(video, canvas, iframe, frame, embed, object, [style*="background-image"]) *) {
    filter: ${BACK} !important; }
  ${rootFilterCoversTopLayer ? `/* A dialog's dimming backdrop stays a dark dim. */
  ${ON} ::backdrop { filter: ${BACK} !important; }` : `${ON} :where(dialog:modal, :popover-open) { filter: ${PAGE} !important; }
  ${ON} { scrollbar-color: #4c4f55 #16181b; }`}
  /* Full-screen media shows its own colours. */
  ${ON}:has(:fullscreen), ${ON}:has(:fullscreen) * { filter: none !important; }
  ${ON}:has(:fullscreen)::before { display: none !important; }
}`;
  const systemDark = matchMedia('(prefers-color-scheme: dark)');
  let value = null, topHost = null, topRequested = false, pageDark = false;
  let frames = 0, pending = 0, observer = null, style = null, painter = null;
  let timer = 0, lastCheck = 0, overflow = false;
  const touched = new Set();

  // Computed colours are rgb() for most pages; newer colour syntaxes go through a canvas.
  function rgba(colour) {
    if (/^rgba?\(/.test(colour)) { const [r, g, b, alpha = 1] = colour.match(/[\d.]+/g).map(Number); return [r, g, b, alpha]; }
    try {
      painter ||= new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
      painter.clearRect(0, 0, 1, 1); painter.fillStyle = colour; painter.fillRect(0, 0, 1, 1);
      const [r, g, b, alpha] = painter.getImageData(0, 0, 1, 1).data;
      return [r, g, b, alpha / 255];
    } catch { return [0, 0, 0, 0]; }
  }
  const luminance = channels => channels.slice(0, 3).map(channel => channel / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  // An element's background colour with its own opacity applied.
  function paint(style) {
    const colour = rgba(style.backgroundColor);
    return [colour[0], colour[1], colour[2], colour[3] * (Number(style.opacity) || 0)];
  }
  // A see-through layer fixed over nearly the whole window and raised above the
  // page, such as the dimming backdrop of a cookie notice or a dialog. What it
  // covers is the page. Without a raised stacking order it is more likely the
  // page's own tinted background, which counts.
  function overlay(element, style, alpha) {
    if (alpha >= 0.95 || style.position !== 'fixed') return false;
    const box = element.getBoundingClientRect();
    if (box.width < innerWidth * 0.9 || box.height < innerHeight * 0.9) return false;
    for (let node = element; node && node !== document.body && node !== root; node = node.parentElement) {
      if (parseInt(getComputedStyle(node).zIndex, 10) > 0) return true;
    }
    return false;
  }
  // Without a background of its own, a page shows the canvas: dark only when it asks for a dark scheme.
  function canvas() {
    const scheme = getComputedStyle(root).colorScheme + ' ' + (document.querySelector('meta[name="color-scheme"]')?.content || '');
    return /\bdark\b/.test(scheme) && (!/\blight\b/.test(scheme) || systemDark.matches) ? [18, 18, 18, 1] : [255, 255, 255, 1];
  }
  // The colour seen at a point: the first mostly opaque background among the
  // elements painted there, topmost first, looking through dimming layers.
  // Media says nothing about the page, so a point on media is not counted.
  function sample(x, y) {
    for (const element of document.elementsFromPoint(x, y)) {
      if (element.closest(MEDIA)) return null;
      const style = getComputedStyle(element), colour = paint(style);
      if (colour[3] >= 0.5 && !overlay(element, style, colour[3])) return colour;
    }
    return canvas();
  }
  // What shows behind the page's content: the body's background, the root's, or the canvas.
  function base() {
    for (const node of [document.body, root]) {
      const colour = paint(getComputedStyle(node));
      if (colour[3] >= 0.5) return colour;
    }
    return canvas();
  }
  // Weighs the page's background and its colours where people read.
  function detect() {
    if (!document.body) return;
    const dark = colour => luminance(colour) < 0.2;
    let votes = BASE_WEIGHT, darkVotes = dark(base()) ? BASE_WEIGHT : 0;
    for (const [x, y] of SAMPLES) {
      const colour = sample(innerWidth * x, innerHeight * y);
      if (colour) { votes++; if (dark(colour)) darkVotes++; }
    }
    pageDark = darkVotes * 2 > votes;
  }

  function render() {
    if (!value?.websites) { stop(); return; }
    if (!style?.isConnected) {
      style = document.getElementById(STYLE_ID) || Object.assign(document.createElement('style'), { id: STYLE_ID, textContent: CSS });
      (document.head || root).append(style);
    }
    const excluded = topHost !== null && settings.excluded(topHost, value.websiteExceptions);
    const state = settings.websitesDark(value, systemDark.matches) && !pageDark && !excluded ? 'on' : 'off';
    if (root.getAttribute(ATTRIBUTE) !== state) root.setAttribute(ATTRIBUTE, state);
    if (!observer) watch();
  }
  // Leaves no trace when the setting is off.
  function stop() {
    observer?.disconnect(); observer = null;
    clearTimeout(timer); timer = 0; touched.clear(); overflow = false;
    style?.remove(); style = null;
    root.removeAttribute(ATTRIBUTE);
  }
  function check() {
    pending = 0; touched.clear(); overflow = false; lastCheck = performance.now();
    if (!value?.websites) return;
    if (settings.websitesDark(value, systemDark.matches)) detect();
    render();
    // Keep checking while the page loads its own styles and theme scripts.
    if (document.readyState !== 'complete' && ++frames < 600) schedule();
  }
  function schedule() { if (!pending) pending = requestAnimationFrame(check); }
  // Pages switch their own themes on <html> or <body>, checked on the next
  // frame, or on a wrapper spanning the whole page, such as an app's root,
  // checked at most every RECHECK_MS. A page that removes the style or
  // attribute gets them back. A check changes nothing when the state already
  // matches, so the observer cannot feed itself.
  function watch() {
    observer = new MutationObserver(changed);
    observer.observe(root, { attributeFilter: [...THEME_ATTRIBUTES, ATTRIBUTE], childList: true });
    if (document.body) observer.observe(document.body, { attributeFilter: THEME_ATTRIBUTES, subtree: true });
  }
  function changed(records) {
    let now = false;
    for (const record of records) {
      if (record.target === root || record.target === document.body) now = true;
      else if (!near(record.target)) continue;
      else if (touched.size < 64) touched.add(record.target);
      else overflow = true;
    }
    if (now) schedule(); else if (touched.size) later();
  }
  // A wrapper spanning the page sits near the top of it. Deeper changes, such
  // as a carousel or a button's state, are never worth a check.
  function near(node) {
    let depth = 0;
    for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) if (++depth > 4) return false;
    return true;
  }
  // A check already queued sees these changes too; one only for them waits its
  // turn. Too many changed wrappers to measure are checked anyway.
  function later() {
    if (timer || pending) return;
    if (!value?.websites || !settings.websitesDark(value, systemDark.matches)) { touched.clear(); overflow = false; return; }
    timer = setTimeout(() => {
      timer = 0;
      const wide = overflow || [...touched].some(spansPage);
      touched.clear(); overflow = false;
      if (wide) schedule();
    }, Math.max(0, lastCheck + RECHECK_MS - performance.now()));
  }
  // As wide as the window and nearly as tall as the page.
  function spansPage(node) {
    if (!node.isConnected) return false;
    const box = node.getBoundingClientRect();
    return box.width >= innerWidth * 0.9 && box.height >= Math.max(root.scrollHeight, innerHeight) * 0.9;
  }
  document.addEventListener('readystatechange', () => {
    if (!observer || !value?.websites) return;
    if (document.body) observer.observe(document.body, { attributeFilter: THEME_ATTRIBUTES, subtree: true });
    schedule();
  });

  function readTopHost() {
    if (window === top) return location.hostname;
    try { return top.location.hostname; } catch { /* A cross-origin top page. */ }
    const origins = location.ancestorOrigins;
    if (origins?.length) try { return new URL(origins[origins.length - 1]).hostname; } catch { /* Not a URL. */ }
    return null;
  }
  // Exceptions follow the tab's site. A cross-origin frame in Firefox cannot
  // read it, so the background answers from the browser's own tab record.
  function learnTopHost() {
    if (topHost !== null || topRequested || !value?.websites || !value.websiteExceptions.length) return;
    topRequested = true;
    try {
      api.runtime.sendMessage({ type: 'WEBSITE_THEME_TOP' }).then(reply => {
        if (typeof reply?.host === 'string') { topHost = reply.host; render(); }
      }, () => {});
    } catch { /* The extension was reloaded; this page keeps its current colours. */ }
  }
  function receive(stored) { value = settings.normalize(stored); learnTopHost(); render(); schedule(); }
  // A change that arrives first is newer than the initial read. A page restored
  // from the back/forward cache missed changes made while it was stored.
  function read(restored) {
    try { api.storage.local.get(settings.KEY).then(saved => { if (restored || value === null) receive(saved[settings.KEY]); }, () => {}); }
    catch { /* See learnTopHost. */ }
  }

  topHost = readTopHost();
  systemDark.addEventListener('change', () => { if (value?.websites) { render(); schedule(); } });
  addEventListener('pageshow', event => { if (event.persisted) read(true); });
  try { api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && settings.KEY in changes) receive(changes[settings.KEY].newValue); }); }
  catch { /* See learnTopHost. */ }
  read(false);
})();
