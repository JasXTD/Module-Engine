/* Website theme content script and the shared Appearance setting, against an
   offline document and extension storage. Rendering, filters and real frames
   are covered in each browser by tests/website-theme-browser.cjs. */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const settingsSource = fs.readFileSync(path.join(root, 'src/shared/appearance-settings.js'), 'utf8');
const source = fs.readFileSync(path.join(root, 'src/appearance/website-theme.js'), 'utf8');
require('../src/shared/appearance-settings.js');
const Settings = globalThis.ModuleEngineAppearance;
const plain = value => JSON.parse(JSON.stringify(value));
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:160.0) Gecko/20100101 Firefox/160.0';

test('the Appearance setting keeps valid websites fields and drops the rest', () => {
  assert.deepEqual(plain(Settings.normalize(undefined)), { mode: 'system', accent: '#c8f23a', websites: false, websiteExceptions: [] });
  const value = Settings.normalize({ mode: 'dark', websites: 'yes', websiteExceptions: ['b.example', 'a.example', 'a.example', 'Upper.example', 'localhost',
    '192.168.0.1', 'single', '-bad.example', 'a'.repeat(64) + '.example', 7, null] });
  assert.equal(value.websites, false, 'only true turns websites on');
  assert.deepEqual(value.websiteExceptions, ['192.168.0.1', 'a.example', 'b.example', 'localhost']);
  assert.equal(Settings.normalize({ websites: true }).websites, true);
  const many = Array.from({ length: 600 }, (_, index) => `site${String(index).padStart(3, '0')}.example`);
  assert.equal(Settings.normalize({ websiteExceptions: many }).websiteExceptions.length, Settings.MAX_EXCEPTIONS);
  assert.ok(Settings.same(Settings.normalize({ websiteExceptions: ['b.example', 'a.example'] }), Settings.normalize({ websiteExceptions: ['a.example', 'b.example'] })));
  assert.ok(!Settings.same(Settings.normalize({}), Settings.normalize({ websites: true })));
  assert.ok(!Settings.same(Settings.normalize({ websiteExceptions: ['a.example'] }), Settings.normalize({ websiteExceptions: ['b.example'] })));
});

test('exceptions cover subdomains, and websites follow the theme only while switched on', () => {
  assert.ok(Settings.excluded('news.example.com', ['example.com']));
  assert.ok(Settings.excluded('EXAMPLE.com.', ['example.com']));
  assert.ok(!Settings.excluded('badexample.com', ['example.com']));
  assert.ok(!Settings.excluded('', ['example.com']));
  const on = mode => Settings.normalize({ mode, websites: true });
  assert.equal(Settings.websitesDark(on('dark'), false), true);
  assert.equal(Settings.websitesDark(on('light'), true), false);
  assert.equal(Settings.websitesDark(on('system'), true), true);
  assert.equal(Settings.websitesDark(on('system'), false), false);
  assert.equal(Settings.websitesDark(Settings.normalize({ mode: 'dark' }), true), false);
});

// An offline frame: just enough DOM for the content script, with controllable
// styles, boxes, hit testing, colour scheme, frames, timers and extension storage.
function page({ host = 'news.example.com', userAgent = CHROME, frame = null, html = true, systemDark = false } = {}) {
  const calls = [], storageListeners = [], frames = [], observers = new Set(), mediaListeners = [], timers = [];
  const styles = new Map(), boxes = new Map();
  let resolveGet, rejectGet, messageReply = null, clock = 0, timerIds = 0;
  class Node {
    constructor(tag) { this.tagName = tag; this.parentElement = null; this.children = []; this.attributes = new Map(); }
    get isConnected() { let node = this; while (node.parentElement) node = node.parentElement; return node === documentElement; }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); notify(this, 'attributes', name); }
    removeAttribute(name) { if (this.attributes.delete(name)) notify(this, 'attributes', name); }
    append(child) { child.remove(); child.parentElement = this; this.children.push(child); notify(this, 'childList'); }
    remove() { if (!this.parentElement) return; const parent = this.parentElement; parent.children.splice(parent.children.indexOf(this), 1); this.parentElement = null; notify(parent, 'childList'); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.media && selector.includes('img')) return node; return null; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, ...boxes.get(this) }; }
  }
  class HTMLHtmlElement extends Node {}
  const documentElement = html ? new HTMLHtmlElement('HTML') : new Node('svg');
  documentElement.scrollHeight = 600;
  // Records only what each observation asked for, as MutationObserver does,
  // including changes below a node observed with its subtree.
  function notify(target, type, name) {
    for (const observer of observers) {
      let options = observer.targets.get(target);
      for (let node = target.parentElement; !options && node; node = node.parentElement) if (observer.targets.get(node)?.subtree) options = observer.targets.get(node);
      if (!options || (type === 'childList' ? !options.childList : !(options.attributes || options.attributeFilter) || options.attributeFilter && !options.attributeFilter.includes(name))) continue;
      observer.records.push({ type, target, attributeName: name });
    }
  }
  const document = {
    documentElement, head: null, body: null, readyState: 'loading', listeners: {},
    createElement: tag => new Node(tag.toUpperCase()),
    getElementById(id) { const find = node => node.id === id ? node : node.children.map(find).find(Boolean); return find(documentElement) || null; },
    querySelector: () => null,
    // Elements painted at a point, topmost first, as a browser reports them.
    elementsFromPoint: () => [document.body, documentElement].filter(Boolean),
    elementFromPoint: (x, y) => document.elementsFromPoint(x, y)[0] || null,
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  };
  const context = {
    document, HTMLHtmlElement, navigator: { userAgent }, innerWidth: 800, innerHeight: 600, console,
    location: { hostname: host },
    getComputedStyle: node => ({ backgroundColor: 'rgba(0, 0, 0, 0)', colorScheme: 'normal', position: 'static', opacity: '1', zIndex: 'auto', ...styles.get(node) }),
    matchMedia: () => media,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    performance: { now: () => clock },
    setTimeout: (callback, delay = 0) => { timers.push({ id: ++timerIds, callback, at: clock + Math.max(0, delay) }); return timerIds; },
    clearTimeout: id => { const index = timers.findIndex(timer => timer.id === id); if (index >= 0) timers.splice(index, 1); },
    MutationObserver: class { constructor(callback) { this.callback = callback; this.targets = new Map(); this.records = []; observers.add(this); }
      observe(target, options) { this.targets.set(target, options); } disconnect() { this.targets.clear(); observers.delete(this); } },
    addEventListener() {},
    chrome: {
      storage: { onChanged: { addListener: listener => storageListeners.push(listener) },
        local: { get: key => { calls.push(['get', key]); return new Promise((resolve, reject) => { resolveGet = resolve; rejectGet = reject; }); } } },
      runtime: { sendMessage: message => { calls.push(['message', message.type]); return new Promise(resolve => { messageReply = resolve; }); } }
    }
  };
  const media = { matches: systemDark, addEventListener: (type, listener) => mediaListeners.push(listener) };
  context.window = context;
  context.top = frame === null ? context : frame;
  vm.createContext(context);
  vm.runInContext(settingsSource, context);
  vm.runInContext(source, context, { filename: 'website-theme.js' });
  const view = {
    context, document, documentElement, calls,
    answer: value => resolveGet(value === undefined ? {} : { appearance: value }),
    refuse: () => rejectGet(new Error('Extension context invalidated.')),
    change: (newValue, area = 'local') => storageListeners.forEach(listener => listener({ appearance: { newValue } }, area)),
    reply: host => messageReply({ ok: true, host }),
    setSystemDark(value) { media.matches = value; mediaListeners.forEach(listener => listener()); },
    // Runs queued animation frames, then delivers pending mutations, until both
    // settle; then time moves on to the next timer, and so on.
    flush() {
      for (let round = 0; round < 50; round++) {
        const queued = frames.splice(0);
        queued.forEach(callback => callback());
        for (const observer of [...observers]) if (observer.records.length) observer.callback(observer.records.splice(0));
        if (frames.length || [...observers].some(observer => observer.records.length)) continue;
        if (!timers.length) return;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift(); clock = Math.max(clock, next.at); next.callback();
      }
    },
    // Delivers pending mutations only, as within one frame.
    deliver() { for (const observer of [...observers]) if (observer.records.length) observer.callback(observer.records.splice(0)); },
    // Parses the body, then finishes loading as a browser would.
    body(colour, { media: isMedia = false } = {}) {
      const body = new Node('BODY'); documentElement.append(body); document.body = body;
      if (colour) view.colour(body, colour);
      if (isMedia) { const image = new Node('IMG'); image.media = true; body.append(image); document.elementsFromPoint = () => [image, body, documentElement]; }
      for (const state of ['interactive', 'complete']) { document.readyState = state; (document.listeners.readystatechange || []).forEach(listener => listener()); }
      return body;
    },
    element(parent, tag = 'DIV') { const node = new Node(tag); parent.append(node); return node; },
    colour: (node, value) => view.css(node, { backgroundColor: value }),
    css: (node, values) => styles.set(node, { ...styles.get(node), ...values }),
    box: (node, width, height) => boxes.set(node, { width, height }),
    // Work waiting for the next frame, mutation delivery or timer.
    queued: () => frames.length + timers.length + [...observers].reduce((sum, observer) => sum + observer.records.length, 0),
    timers: () => timers.length,
    state: () => documentElement.getAttribute('data-module-engine-dark'),
    style: () => document.getElementById('module-engine-website-theme')
  };
  return view;
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('nothing changes on a page while websites are off', async () => {
  const view = page();
  assert.deepEqual(view.calls, [['get', 'appearance']], 'one storage read at document start');
  view.answer(undefined); await settle(); view.flush();
  assert.equal(view.state(), null);
  assert.equal(view.style(), null);
  view.change({ mode: 'dark' }); view.flush();
  assert.equal(view.style(), null, 'a dark theme alone does not reach websites');
});

test('a dark theme darkens a light page at once and its style turns media back', async () => {
  const view = page({ userAgent: CHROME });
  view.answer({ mode: 'dark', websites: true }); await settle();
  assert.equal(view.state(), 'on', 'applied before the body exists');
  const css = view.style().textContent;
  assert.match(css, /^@media screen and \(forced-colors: none\) \{/);
  assert.match(css, /:root\[data-module-engine-dark="on"\] \{ filter: invert\(0\.95\) hue-rotate\(180deg\) !important; \}/);
  assert.match(css, /:where\(img, video, canvas, iframe, frame, embed, object, svg image, \[style\*="background-image"\]\)/);
  assert.match(css, /filter: invert\(1\) hue-rotate\(180deg\) !important/);
  assert.match(css, /:has\(:fullscreen\)/);
  assert.match(css, /dialog:modal, :popover-open/, 'Chrome needs the top layer themed separately');
  assert.match(css, /scrollbar-color/);
  view.body('rgb(255, 255, 255)'); view.flush();
  assert.equal(view.state(), 'on');
  const firefox = page({ userAgent: FIREFOX });
  firefox.answer({ mode: 'dark', websites: true }); await settle();
  assert.doesNotMatch(firefox.style().textContent, /dialog:modal|scrollbar-color/, "Firefox's root filter already covers the top layer");
  assert.match(firefox.style().textContent, /::backdrop \{ filter: invert\(1\) hue-rotate\(180deg\) !important; \}/, 'so its backdrop is turned back');
  assert.doesNotMatch(css, /::backdrop/, "Chrome's backdrop is outside the root filter");
});

test('pages that are already dark keep their own colours, including ones that turn dark later', async () => {
  const dark = page();
  dark.answer({ mode: 'dark', websites: true }); await settle();
  dark.body('rgb(17, 17, 17)'); dark.flush();
  assert.equal(dark.state(), 'off');
  const later = page();
  later.answer({ mode: 'dark', websites: true }); await settle();
  const body = later.body('rgb(250, 250, 250)'); later.flush();
  assert.equal(later.state(), 'on');
  later.documentElement.setAttribute('style', '--scroll-y: 120px'); body.setAttribute('style', 'overflow: hidden');
  assert.equal(later.queued(), 0, 'inline style updates, which pages make while scrolling, trigger no checks');
  later.colour(body, 'rgb(20, 22, 25)'); body.setAttribute('class', 'theme-dark');
  assert.ok(later.queued() > 0, 'a theme class does');
  later.flush();
  assert.equal(later.state(), 'off', "the page's own dark theme is noticed");
  const media = page();
  media.answer({ mode: 'dark', websites: true }); await settle();
  media.body('rgb(255, 255, 255)', { media: true }); media.flush();
  assert.equal(media.state(), 'on', 'a black video at every sample point does not make the page dark');
});

test('the theme follows Light, Dark and System, including device changes', async () => {
  const view = page({ systemDark: false });
  view.answer({ mode: 'light', websites: true }); await settle(); view.body('rgb(255, 255, 255)'); view.flush();
  assert.equal(view.state(), 'off');
  assert.ok(view.style(), 'the style stays ready while websites are on');
  view.change({ mode: 'system', websites: true }); view.flush();
  assert.equal(view.state(), 'off');
  view.setSystemDark(true); view.flush();
  assert.equal(view.state(), 'on');
  view.setSystemDark(false); view.flush();
  assert.equal(view.state(), 'off');
  view.change({ mode: 'dark', websites: false }); view.flush();
  assert.equal(view.state(), null, 'switching websites off removes the attribute');
  assert.equal(view.style(), null, 'and the style');
});

test('exceptions follow the tab site, including cross-origin frames that ask the background', async () => {
  const top = page({ host: 'news.example.com' });
  top.answer({ mode: 'dark', websites: true, websiteExceptions: ['example.com'] }); await settle(); top.flush();
  assert.equal(top.state(), 'off');
  top.change({ mode: 'dark', websites: true, websiteExceptions: [] }); top.flush();
  assert.equal(top.state(), 'on');
  const crossOrigin = { get location() { throw new Error('SecurityError'); } };
  const frame = page({ host: 'widgets.example.net', frame: crossOrigin, userAgent: FIREFOX });
  frame.answer({ mode: 'dark', websites: true, websiteExceptions: ['example.com'] }); await settle(); frame.flush();
  assert.equal(frame.state(), 'on', 'not excluded by its own host while the tab site is unknown');
  assert.deepEqual(frame.calls.at(-1), ['message', 'WEBSITE_THEME_TOP']);
  frame.reply('shop.example.com'); await settle(); frame.flush();
  assert.equal(frame.state(), 'off', 'the excluded tab site keeps its frames in their own colours');
  const quiet = page({ host: 'widgets.example.net', frame: crossOrigin });
  quiet.answer({ mode: 'dark', websites: true }); await settle();
  assert.ok(!quiet.calls.some(call => call[0] === 'message'), 'no question without exceptions');
  const sameOrigin = page({ host: '', frame: { location: { hostname: 'example.com' } } });
  sameOrigin.answer({ mode: 'dark', websites: true, websiteExceptions: ['example.com'] }); await settle();
  assert.equal(sameOrigin.state(), 'off', 'a same-origin frame reads the top site itself');
});

test('a change that arrives first wins, a removed attribute returns, and non-HTML documents are untouched', async () => {
  const view = page();
  view.change({ mode: 'dark', websites: true });
  view.answer({ mode: 'light', websites: false }); await settle(); view.flush();
  assert.equal(view.state(), 'on', 'the older read is ignored');
  view.documentElement.removeAttribute('data-module-engine-dark'); view.flush();
  assert.equal(view.state(), 'on', 'restored after a page removes it');
  view.style().remove(); view.flush();
  assert.ok(view.style()?.isConnected, 'the style is put back too');
  const svg = page({ html: false });
  assert.deepEqual(svg.calls, [], 'an SVG or XML document is not read at all');
  const failed = page();
  failed.refuse(); await settle(); failed.flush();
  assert.equal(failed.state(), null, 'an unreadable setting changes nothing');
});

test('raised see-through layers, such as cookie notices and dialog backdrops, are looked through', async () => {
  const view = page(), html = view.documentElement;
  view.answer({ mode: 'dark', websites: true }); await settle();
  // A cookie notice shown with the page: a dimming layer over the whole window, a light box in the middle.
  const body = view.body('rgb(255, 255, 255)');
  const notice = view.element(body), box = view.element(notice);
  view.css(notice, { backgroundColor: 'rgba(0, 0, 0, 0.6)', position: 'fixed', zIndex: '10' }); view.box(notice, 800, 600);
  view.colour(box, 'rgb(255, 255, 255)');
  view.document.elementsFromPoint = (x, y) => x === 400 && y === 300 ? [box, notice, body, html] : [notice, body, html];
  view.flush();
  assert.equal(view.state(), 'on', 'a light page behind a cookie notice is darkened');
  // A Bootstrap-style backdrop: an opaque colour made see-through by opacity, opened with a body class.
  view.css(notice, { backgroundColor: 'rgb(0, 0, 0)', opacity: '0.5', zIndex: '1050' });
  body.setAttribute('class', 'modal-open'); view.flush();
  assert.equal(view.state(), 'on', 'opening a dialog does not turn the page back to light');
  // A backdrop below its dialog inside a raised dialog root.
  const dialogRoot = view.element(body), backdrop = view.element(dialogRoot);
  view.css(dialogRoot, { position: 'fixed', zIndex: '1300' }); view.box(dialogRoot, 800, 600);
  view.css(backdrop, { position: 'fixed', backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '-1' }); view.box(backdrop, 800, 600);
  view.document.elementsFromPoint = () => [backdrop, dialogRoot, body, html];
  body.setAttribute('class', 'dialog-open'); view.flush();
  assert.equal(view.state(), 'on', 'a backdrop inside a raised dialog root is looked through');
  // Not raised, or not covering the window: the page's own colours.
  const own = page(), ownHtml = own.documentElement;
  own.answer({ mode: 'dark', websites: true }); await settle();
  const ownBody = own.body(null), tint = own.element(ownBody);
  own.css(tint, { backgroundColor: 'rgba(10, 10, 10, 0.8)', position: 'fixed' }); own.box(tint, 800, 600);
  own.document.elementsFromPoint = () => [tint, ownBody, ownHtml];
  own.flush();
  assert.equal(own.state(), 'off', "a fixed tint with no raised stacking order is the page's own dark background");
  own.css(tint, { zIndex: '5' }); own.box(tint, 800, 300);
  ownBody.setAttribute('class', 'half'); own.flush();
  assert.equal(own.state(), 'off', 'a raised layer that covers only part of the window counts too');
});

test("the page's own background outweighs a dark banner across part of the first screen", async () => {
  const view = page(), html = view.documentElement;
  view.answer({ mode: 'dark', websites: true }); await settle();
  const body = view.body('rgb(255, 255, 255)'), banner = view.element(body);
  view.colour(banner, 'rgb(22, 33, 62)');
  // The banner covers the three upper sample points (y ≤ 300), not the two lower ones.
  view.document.elementsFromPoint = (x, y) => y <= 300 ? [banner, body, html] : [body, html];
  view.flush();
  assert.equal(view.state(), 'on', 'a light page with a dark banner is darkened');
  view.document.elementsFromPoint = () => [banner, body, html];
  body.setAttribute('class', 'full-banner'); view.flush();
  assert.equal(view.state(), 'off', 'content that is dark at every point makes the page dark, whatever its body colour');
  view.colour(body, 'rgb(17, 17, 17)'); view.colour(banner, 'rgb(250, 250, 250)');
  view.document.elementsFromPoint = (x, y) => y <= 300 ? [banner, body, html] : [body, html];
  body.setAttribute('class', 'dark-site'); view.flush();
  assert.equal(view.state(), 'off', 'a dark page with a light banner keeps its own colours');
});

test('after loading, a wrapper spanning the page that turns dark is noticed, with checks paced and small changes ignored', async () => {
  const view = page(), html = view.documentElement;
  view.answer({ mode: 'dark', websites: true }); await settle();
  const body = view.body('rgb(255, 255, 255)'), app = view.element(body), card = view.element(app);
  html.scrollHeight = 1200; view.box(app, 790, 1200); view.box(card, 300, 100);
  let points = 0;
  view.document.elementsFromPoint = () => { points++; return [app, body, html]; };
  view.flush();
  assert.equal(view.state(), 'on');
  let deep = app;
  for (let level = 0; level < 5; level++) deep = view.element(deep);
  deep.setAttribute('class', 'spinning'); view.deliver();
  assert.equal(view.timers(), 0, 'a change five levels inside the page starts no check at all');
  let before = points;
  for (let index = 0; index < 20; index++) { card.setAttribute('class', 'tick-' + index); view.deliver(); }
  assert.equal(view.timers(), 1, 'twenty changes below the body wait for one paced check');
  view.flush();
  assert.equal(points, before, 'class changes on small elements cause no check at all');
  before = points;
  for (let index = 0; index < 10; index++) { app.setAttribute('data-theme', 'step-' + index); view.deliver(); }
  view.flush();
  assert.equal(points - before, 5, 'a burst of changes on a page-wide wrapper is checked once, at five points');
  before = points;
  const items = Array.from({ length: 70 }, () => view.element(body));
  for (const item of items) item.setAttribute('class', 'shown');
  view.deliver(); view.flush();
  assert.equal(points - before, 5, 'more changed wrappers than it measures are checked anyway, once');
  view.colour(app, 'rgb(17, 17, 17)'); app.setAttribute('class', 'dark');
  view.flush();
  assert.equal(view.state(), 'off', "an app root switching to its own dark theme after loading keeps its own colours");
  app.setAttribute('class', 'dark again'); view.deliver();
  assert.equal(view.timers(), 1);
  view.change({ mode: 'dark', websites: false });
  assert.equal(view.timers(), 0, 'switching websites off cancels a waiting check');
  assert.equal(view.state(), null);
});
