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
// colours, hit testing, colour scheme, frames and extension storage.
function page({ host = 'news.example.com', userAgent = CHROME, frame = null, html = true, systemDark = false } = {}) {
  const calls = [], storageListeners = [], frames = [], observers = new Set(), mediaListeners = [];
  const colours = new Map();
  let resolveGet, rejectGet, messageReply = null;
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
  }
  class HTMLHtmlElement extends Node {}
  const documentElement = html ? new HTMLHtmlElement('HTML') : new Node('svg');
  // Records only what each observation asked for, as MutationObserver does.
  function notify(target, type, name) {
    for (const observer of observers) {
      const options = observer.targets.get(target);
      if (!options || (type === 'childList' ? !options.childList : !(options.attributes || options.attributeFilter) || options.attributeFilter && !options.attributeFilter.includes(name))) continue;
      observer.records.push({ type, target, attributeName: name });
    }
  }
  const document = {
    documentElement, head: null, body: null, readyState: 'loading', listeners: {},
    createElement: tag => new Node(tag.toUpperCase()),
    getElementById(id) { const find = node => node.id === id ? node : node.children.map(find).find(Boolean); return find(documentElement) || null; },
    querySelector: () => null,
    elementFromPoint: () => document.body,
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  };
  const context = {
    document, HTMLHtmlElement, navigator: { userAgent }, innerWidth: 800, innerHeight: 600, console,
    location: { hostname: host },
    getComputedStyle: node => ({ backgroundColor: colours.get(node) || 'rgba(0, 0, 0, 0)', colorScheme: 'normal' }),
    matchMedia: () => media,
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
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
    // Runs queued animation frames, then delivers pending mutations, until both settle.
    flush() {
      for (let round = 0; round < 20; round++) {
        const queued = frames.splice(0);
        queued.forEach(callback => callback());
        for (const observer of [...observers]) if (observer.records.length) observer.callback(observer.records.splice(0));
        if (!frames.length && ![...observers].some(observer => observer.records.length)) return;
      }
    },
    // Parses the body, then finishes loading as a browser would.
    body(colour, { media: isMedia = false } = {}) {
      const body = new Node('BODY'); documentElement.append(body); document.body = body;
      if (colour) colours.set(body, colour);
      if (isMedia) { const image = new Node('IMG'); image.media = true; body.append(image); document.elementFromPoint = () => image; }
      for (const state of ['interactive', 'complete']) { document.readyState = state; (document.listeners.readystatechange || []).forEach(listener => listener()); }
      return body;
    },
    colour: (node, value) => colours.set(node, value),
    // Work waiting for the next frame or mutation delivery.
    queued: () => frames.length + [...observers].reduce((sum, observer) => sum + observer.records.length, 0),
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
