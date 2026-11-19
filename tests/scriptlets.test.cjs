/* Scriptlet filters: the parser, rule selection and each page scriptlet, run
   from its source text in a simulated page. Browser suites cover the parts that
   need a real document: script elements, DOM sweeps and document-start timing. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('../src/blocking/scriptlets.js');
const S = globalThis.BlockAdsScriptlets;
const call = body => S.parseBody(body);

// A page with just enough of the browser for the scriptlets. Classes are made
// inside the page's own realm, as they are in a browser.
const PAGE = String.raw`
  globalThis.window = globalThis;
  globalThis.log = { timers: [], frames: [], fetches: [], xhrSends: [], opened: [], alerts: [], reloads: 0 };
  class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); this.defaultPrevented = false; this.stopped = false; }
    preventDefault() { this.defaultPrevented = true; } stopImmediatePropagation() { this.stopped = true; } }
  class ProgressEvent extends Event {}
  class EventTarget {
    addEventListener(type, listener, options) { (this.__listeners ||= []).push({ type, listener, options }); }
    removeEventListener() {}
    dispatchEvent(event) {
      for (const { type, listener } of [...(this.__listeners || [])]) {
        if (type !== event.type || event.stopped) continue;
        typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event);
      }
      if (!event.stopped && typeof this['on' + event.type] === 'function') this['on' + event.type](event);
      return !event.defaultPrevented;
    }
  }
  // As in a browser, the window is an EventTarget.
  Object.setPrototypeOf(globalThis, EventTarget.prototype);
  class Element extends EventTarget { constructor(selector = '') { super(); this.selector = selector; } matches(selector) { return this.selector === selector; } }
  class HTMLScriptElement extends Element {}
  class Document extends EventTarget { get currentScript() { return globalThis.__currentScript ?? null; } }
  const jar = new Map();
  Object.defineProperty(Document.prototype, 'cookie', { configurable: true,
    get() { return [...jar].map(([name, value]) => name + '=' + value).join('; '); },
    set(text) { const [pair, ...attributes] = text.split(';').map(part => part.trim()); const index = pair.indexOf('=');
      jar.set(pair.slice(0, index), pair.slice(index + 1)); log.cookieAttributes = attributes; } });
  Object.assign(globalThis, { Event, ProgressEvent, EventTarget, Element, HTMLScriptElement, Document });
  globalThis.document = new Document();
  document.readyState = 'loading';
  document.baseURI = 'https://example.test/page';
  globalThis.setTimeout = function setTimeout(callback, delay) { log.timers.push({ kind: 'timeout', callback, delay }); return log.timers.length; };
  globalThis.setInterval = function setInterval(callback, delay) { log.timers.push({ kind: 'interval', callback, delay }); return log.timers.length; };
  globalThis.requestAnimationFrame = function requestAnimationFrame(callback) { log.frames.push(callback); return log.frames.length; };
  globalThis.Response = class Response extends HostResponse {};
  globalThis.Request = class Request extends HostRequest {};
  globalThis.fetch = function fetch(input, init) { log.fetches.push({ input, init }); return Promise.resolve(new Response('real')); };
  globalThis.XMLHttpRequest = class XMLHttpRequest extends EventTarget {
    open(method, url, async) { this.readyState = 1; this.opened = { method, url, async }; }
    send() { log.xhrSends.push(this.opened); }
    abort() {}
  };
  class Storage { constructor() { this.items = new Map(); } getItem(key) { return this.items.has(key) ? this.items.get(key) : null; }
    setItem(key, value) { this.items.set(key, String(value)); } removeItem(key) { this.items.delete(key); } }
  globalThis.localStorage = new Storage();
  globalThis.sessionStorage = new Storage();
  globalThis.open = function open(...args) { log.opened.push(args); return { closed: false }; };
  globalThis.alert = function alert(message) { log.alerts.push(message); };
  globalThis.location = { hostname: 'example.test', ancestorOrigins: null, reload() { log.reloads++; } };
`;
function page(setup = '') {
  const context = vm.createContext({ HostResponse: Response, HostRequest: Request, URL, console: { info() {}, warn() {} } });
  vm.runInContext(PAGE, context);
  if (setup) vm.runInContext(setup, context);
  return context;
}
// Runs `bodies` (filter bodies such as "+js(set, a, true)") in a fresh page from the runtime's source.
function load(bodies, setup) {
  const context = page(setup);
  vm.runInContext(`(${S.run})(${JSON.stringify(bodies.map(call))})`, context);
  return context;
}
const evaluate = (context, code) => vm.runInContext(code, context);
// Page objects have the page's own prototypes; compare them as JSON.
const json = (context, code) => JSON.parse(evaluate(context, `JSON.stringify(${code})`));

// The page code reaches pages as source text, so a name from this module's scope
// would fail there, silently inside a scriptlet's try. Every name it reads must be
// declared inside it or be one of these page globals.
test('the page functions use only their own names and page globals', () => {
  const acorn = require('../vendor/acorn/acorn.js');
  const globals = new Set(['globalThis', 'location', 'URL', 'JSON', 'Array', 'Boolean', 'Map', 'Set', 'String', 'Infinity', 'undefined']);
  for (const name of ['select', 'run', 'boot']) {
    const ast = acorn.parse('(' + S[name].toString() + ')', { ecmaVersion: 'latest' });
    const declared = new Set(), used = new Set();
    const walk = (node, parent, key) => {
      if (!node || typeof node.type !== 'string') return;
      if (node.type === 'Identifier') {
        const property = parent && (parent.type === 'MemberExpression' && key === 'property' && !parent.computed ||
          parent.type === 'Property' && key === 'key' && !parent.computed && !parent.shorthand);
        if (!property) used.add(node.name);
      }
      if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) {
        if (node.id) declared.add(node.id.name);
        for (const param of node.params) collect(param);
      }
      if (node.type === 'VariableDeclarator') collect(node.id);
      if (node.type === 'CatchClause' && node.param) collect(node.param);
      for (const [child, value] of Object.entries(node)) {
        if (Array.isArray(value)) value.forEach(item => walk(item, node, child));
        else if (value && typeof value.type === 'string') walk(value, node, child);
      }
    };
    const collect = pattern => {
      if (!pattern) return;
      if (pattern.type === 'Identifier') declared.add(pattern.name);
      else if (pattern.type === 'AssignmentPattern') collect(pattern.left);
      else if (pattern.type === 'RestElement') collect(pattern.argument);
      else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(collect);
      else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(item => collect(item.value || item.argument));
    };
    walk(ast, null, null);
    assert.deepEqual([...used].filter(item => !declared.has(item) && !globals.has(item)), [], name);
  }
});

test('arguments split on unescaped commas; quotes keep commas and backslashes stay for regular expressions', () => {
  assert.deepEqual(S.splitArguments('set, a.b , true'), ['set', 'a.b', 'true']);
  assert.deepEqual(S.splitArguments('acs, a, x\\, y'), ['acs', 'a', 'x, y']);
  assert.deepEqual(S.splitArguments("acs, a, 'x, y', \"q\\\"d\", `t`"), ['acs', 'a', 'x, y', 'q"d', 't']);
  assert.deepEqual(S.splitArguments('nostif, /a\\d+\\.js/'), ['nostif', '/a\\d+\\.js/']);
  assert.deepEqual(S.splitArguments("set, a, ''"), ['set', 'a', '']);
  assert.deepEqual(S.splitArguments('set, a,'), ['set', 'a', '']);
  // A quote that more text follows is ordinary text, as is one that never closes.
  assert.deepEqual(S.splitArguments("aopr, 'a'b"), ['aopr', "'a'b"]);
  assert.deepEqual(S.splitArguments("aopr, 'open"), ['aopr', "'open"]);
});

test('names and aliases resolve to one scriptlet, with .js accepted, and +js() names none', () => {
  for (const [body, name] of [['+js(set, a, true)', 'set-constant'], ['+js(set-constant.js, a, true)', 'set-constant'], ['+js(aopr, a)', 'abort-on-property-read'],
    ['+js(acis, a, b)', 'abort-current-script'], ['+js(nostif, ad)', 'no-setTimeout-if'], ['+js(prevent-setInterval, ad)', 'no-setInterval-if'],
    ['+js(aeld, click)', 'addEventListener-defuser'], ['+js(prevent-fetch, ads.js)', 'no-fetch-if'], ['+js(nowoif)', 'no-window-open-if'],
    ['+js(window.open-defuser)', 'no-window-open-if'], ['+js(nano-sib)', 'nano-setInterval-booster'], ['+js(rmnt, script, ad)', 'remove-node-text'],
    ['+js(noeval-silent)', 'noeval'], ['+js(ra, onclick)', 'remove-attr'], ['+js(rc, ad)', 'remove-class']]) {
    assert.equal(call(body).name, name, body);
  }
  assert.deepEqual(call('+js()'), { name: '', args: [] });
  assert.deepEqual(call('+js(  )'), { name: '', args: [] });
  assert.deepEqual(call('+js(set-cookie, consent, "Accept", /, reload, 1)').args, ['consent', 'Accept', '/', 'reload', '1']);
  assert.ok(Object.keys(S.NAMES).length >= 20 && S.NAMES['set-constant'].includes('set'));
});

test('unknown, trusted, malformed and log-only scriptlet filters are refused with a reason', () => {
  for (const [body, reason] of [['+js(alert)', /Unknown or unsupported/], ['+js(trusted-set-constant, a, 1)', /arbitrary values/],
    ['set, a, true', /looks like/], ['+js(set, a, true', /looks like/], ['+js(set, a)', /needs 2 arguments/], ['+js(set, a, maybe)', /not a constant/],
    ['+js(set, a, 40000)', /not a constant/], ['+js(set, a b, true)', /property path/], ['+js(set, a..b, true)', /property path/],
    ['+js(nostif)', /calls are not logged/], ['+js(aeld)', /calls are not logged/], ['+js(norafif)', /calls are not logged/], ['+js(noeval-if)', /needs 1 argument/],
    ['+js(json-prune, a, /log/)', /logging is unsupported/], ['+js(json-prune, a.[-].b)', /JSON path/], ['+js(nostif, /(/)', /not a valid regular expression/],
    ['+js(nostif, /a/x)', /unknown regular-expression flags/], ['+js(nostif, a, soon)', /delay/], ['+js(aeld, click, x, runAt, end)', /does not support the option "runAt"/],
    ['+js(aeld, click, x, elements)', /name, value pairs/], ['+js(no-fetch-if, ads, war:noop.js)', /unsupported/], ['+js(no-fetch-if, ads, , {"status":404})', /unsupported or has an invalid value/],
    ['+js(no-fetch-if, ads, , not-json)', /must be JSON/], ['+js(set-cookie, a b, ok)', /cookie name/], ['+js(set-cookie, c, maybe)', /fixed values/],
    ['+js(set-cookie, c, ok, path)', /should start with \//], ['+js(set-local-storage-item, k, anything)', /fixed values/], ['+js(rmnt, sc ript, x)', /element name/],
    ['+js(ra, on click)', /attribute names/], ['+js(rc, a, div { color: red })', /selector/], ['+js(ra, a, , later)', /Unknown timing/],
    ['+js(set, a, \u0001)', /control characters/], ['+js(' + 'x'.repeat(1000) + ')', /limited to 1000/], ['+js(' + Array(14).fill('a').join(',') + ')', /Unknown/]]) {
    assert.throws(() => call(body), reason, body);
  }
  assert.throws(() => call('+js(set-constant, ' + Array(13).fill('a').join(', ') + ')'), /at most 12 arguments/);
});

test('a host gets the rules for its sites, minus exact exceptions; +js() exceptions turn all off', () => {
  const rule = (body, include, exclude = [], exception = false) => ({ include, exclude, exception, ...call(body) });
  const rules = [rule('+js(set, a, true)', ['example.test'], ['shop.example.test']), rule('+js(set-constant, a, true)', ['other.test']),
    rule('+js(aopr, b)', ['example.test']), rule('+js(set, a, true)', ['example.test']), rule('+js(set, a, true)', ['news.example.test'], [], true)];
  assert.deepEqual(S.select(rules, 'WWW.Example.Test.'), [{ name: 'set-constant', args: ['a', 'true'] }, { name: 'abort-on-property-read', args: ['b'] }]);
  // An alias in the exception still names the same call.
  assert.deepEqual(S.select(rules, 'news.example.test'), [{ name: 'abort-on-property-read', args: ['b'] }]);
  // Each rule keeps its own sites: the copy without the exclusion still applies.
  assert.deepEqual(S.select(rules.slice(0, 3), 'shop.example.test'), [{ name: 'abort-on-property-read', args: ['b'] }]);
  assert.deepEqual(S.select(rules, 'shop.example.test'), [{ name: 'abort-on-property-read', args: ['b'] }, { name: 'set-constant', args: ['a', 'true'] }]);
  assert.deepEqual(S.select(rules, 'notexample.test'), []);
  assert.deepEqual(S.select([...rules, rule('+js()', ['example.test'], [], true)], 'www.example.test'), []);
  assert.deepEqual(S.select([...rules, { include: [], exclude: [], exception: true, name: '', args: [] }], 'other.test'), []);
  // A rule for every site is never taken: lists and custom rules both need a site.
  assert.deepEqual(S.select([{ include: [], exclude: [], exception: false, name: 'set-constant', args: ['a', 'true'] }], 'any.test'), []);
  assert.deepEqual(S.select(rules, ''), []);
});

test('set-constant fixes values now and on objects the page creates later, and never changes a value to another type', () => {
  const context = load(['+js(set, ads.enabled, false)', '+js(set, flag, true)', '+js(set, count, 0)', '+js(set, fn, noopFunc)', '+js(set, yes, trueFunc)',
    '+js(set, list, emptyArr)', '+js(set, empty, \'\')', '+js(set, typed, true)', '+js(set, gone, undefined)'], 'window.typed = "string"; window.flag = false; window.gone = 1;');
  evaluate(context, 'window.ads = { enabled: true, other: 1 }; window.flag = false; window.count = 5;');
  assert.deepEqual(JSON.parse(evaluate(context, 'JSON.stringify({ enabled: ads.enabled, other: ads.other, flag, count, list, empty, typed, gone: typeof gone })')),
    { enabled: false, other: 1, flag: true, count: 0, list: [], empty: '', typed: 'string', gone: 'undefined' });
  assert.equal(evaluate(context, 'typeof fn() === "undefined" && yes() === true'), true);
  // The fixed value cannot be redefined either.
  assert.throws(() => evaluate(context, 'Object.defineProperty(window, "flag", { value: false })'));
});

test('abort-on-property-read and -write throw ReferenceError, which the page\'s error handlers do not see', () => {
  const context = load(['+js(aopr, detector.check)', '+js(aopw, popunder)'], 'window.popunder = "kept";');
  evaluate(context, 'window.detector = { check: 1, other: 2 }');
  const read = evaluate(context, 'try { detector.check; "read" } catch (error) { error }');
  assert.equal(read.name, 'ReferenceError');
  assert.equal(evaluate(context, 'detector.other'), 2);
  assert.equal(evaluate(context, 'popunder'), 'kept');
  assert.throws(() => evaluate(context, 'popunder = "changed"'), { name: 'ReferenceError' });
  // An uncaught abort reaches the window's error listeners as its message.
  const event = evaluate(context, `(() => { const event = new Event('error', { message: 'Uncaught ReferenceError: ' + ${JSON.stringify(read.message)} });
    window.dispatchEvent(event); return event; })()`);
  assert.equal(event.defaultPrevented && event.stopped, true);
  const other = evaluate(context, "(() => { const event = new Event('error', { message: 'TypeError: unrelated' }); window.dispatchEvent(event); return event; })()");
  assert.equal(other.defaultPrevented, false);
});

test('json-prune removes paths from parsed JSON and Response.json, only when required paths exist', async () => {
  const context = load(['+js(json-prune, playerAds adPlacements.[] items.[].promo *.tracking, playerAds)']);
  const parse = text => JSON.parse(evaluate(context, `JSON.stringify(JSON.parse(${JSON.stringify(text)}))`));
  assert.deepEqual(parse('{"playerAds":[1],"adPlacements":[1,2],"items":[{"promo":1,"id":1},{"id":2}],"a":{"tracking":1,"keep":1}}'),
    { adPlacements: [], items: [{ id: 1 }, { id: 2 }], a: { keep: 1 } });
  assert.deepEqual(parse('{"adPlacements":[1],"items":[{"promo":1}]}'), { adPlacements: [1], items: [{ promo: 1 }] }, 'without the required path nothing changes');
  assert.equal(evaluate(context, 'JSON.parse("5")'), 5);
  const json = await evaluate(context, 'new Response(\'{"playerAds":1,"keep":true}\').json()');
  assert.deepEqual(json, { keep: true });
  // A stack pattern limits pruning to matching callers; "!" negates it.
  const stacked = load(['+js(json-prune, ads, , !anything-not-on-the-stack)']);
  assert.equal(evaluate(stacked, 'JSON.stringify(JSON.parse(\'{"ads":1,"k":1}\'))'), '{"k":1}');
  const unmatched = load(['+js(json-prune, ads, , caller-that-never-runs)']);
  assert.equal(evaluate(unmatched, 'JSON.stringify(JSON.parse(\'{"ads":1}\'))'), '{"ads":1}');
});

test('timer scriptlets replace matching callbacks with ones that do nothing, by code and delay', () => {
  const context = load(['+js(nostif, adblock)', '+js(nosiif, /^function check/, 500-)', '+js(norafif, !keep)', '+js(nostif, , !10)']);
  evaluate(context, `setTimeout(function () { window.adblockRan = true; }, 10); setTimeout(function ok() {}, 10);
    setInterval(function checkAds() {}, 1000); setInterval(function checkAds() {}, 100); setInterval(function other() {}, 1000);
    requestAnimationFrame(function keep() {}); requestAnimationFrame(function drop() {}); setTimeout(function later() {}, 20);`);
  const names = json(context, 'log.timers.map(t => t.callback.name)');
  // The timers still start, with a callback that does nothing.
  assert.deepEqual(names, ['noop', 'ok', 'noop', 'checkAds', 'other', 'noop'], 'callbacks are matched by code, delay range and a negated delay');
  assert.equal(evaluate(context, 'log.timers[0].callback(), window.adblockRan'), undefined);
  assert.deepEqual(json(context, 'log.frames.map(callback => callback.name)'), ['keep', 'noop']);
  const boosted = load(['+js(nano-stb, slow, 2000, 0.02)', '+js(nano-sib, , *, 100)']);
  evaluate(boosted, 'setTimeout(function slow() {}, 2000); setTimeout(function slow() {}, 1000); setInterval(function any() {}, 100); setInterval(function any() {}, 7);');
  assert.deepEqual(json(boosted, 'log.timers.map(t => t.delay)'), [40, 1000, 5000, 350], 'boosters change only matching delays, and cap the factor at 50');
});

test('addEventListener-defuser drops matching listeners, optionally only on named targets', () => {
  const context = load(['+js(aeld, /^(click|mousedown)$/, popunder)', '+js(aeld, scroll, , elements, window)']);
  evaluate(context, `
    const element = new Element('a.ad'), seen = [];
    element.addEventListener('click', function openPopunder() { seen.push('popunder'); });
    element.addEventListener('click', function ordinary() { seen.push('ordinary'); });
    element.addEventListener('keydown', function popunderKey() { seen.push('key'); });
    element.addEventListener('scroll', () => seen.push('element scroll'));
    window.addEventListener('scroll', () => seen.push('window scroll'));
    element.dispatchEvent(new Event('click')); element.dispatchEvent(new Event('keydown')); element.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll'));
    globalThis.seen = seen;`);
  assert.deepEqual(json(context, 'seen'), ['ordinary', 'key', 'element scroll']);
});

test('no-fetch-if answers matching requests itself and passes others on', async () => {
  const context = load(['+js(no-fetch-if, ads.js method:POST)', '+js(no-fetch-if, /pagead/, emptyObj, \'{"ok":false,"type":"opaque","statusText":"Not Found"}\')',
    '+js(no-fetch-if, beacon !keep)']);
  const fetchAnd = async code => JSON.parse(await evaluate(context, `(async () => { const response = await ${code};
    return JSON.stringify({ text: await response.text(), ok: response.ok, type: response.type, url: response.url, status: response.statusText }); })()`));
  assert.deepEqual(await fetchAnd("fetch('/ads.js', { method: 'post' })"), { text: '', ok: true, type: 'basic', url: 'https://example.test/ads.js', status: 'OK' });
  assert.deepEqual(await fetchAnd("fetch(new Request('https://cdn.test/pagead/x'))"), { text: '{}', ok: false, type: 'opaque', url: 'https://cdn.test/pagead/x', status: 'Not Found' });
  assert.equal((await fetchAnd("fetch('/ads.js')")).text, 'real', 'a GET does not match method:POST');
  assert.equal((await fetchAnd("fetch('/beacon?keep=1')")).text, 'real', 'a negated part must not match');
  assert.equal((await fetchAnd("fetch('/beacon')")).text, '');
  assert.equal(evaluate(context, 'log.fetches.length'), 2);
});

test('no-xhr-if completes matching requests without sending them', () => {
  const context = load(['+js(no-xhr-if, /ads/ method:GET, emptyArr)']);
  evaluate(context, `globalThis.events = [];
    globalThis.xhr = new XMLHttpRequest(); xhr.onload = () => events.push('onload');
    xhr.addEventListener('readystatechange', () => events.push('state ' + xhr.readyState)); xhr.addEventListener('loadend', () => events.push('loadend'));
    xhr.open('get', '/ads/config'); xhr.send();
    globalThis.other = new XMLHttpRequest(); other.open('GET', '/content'); other.send();
    globalThis.json = new XMLHttpRequest(); json.responseType = 'json'; json.open('GET', '/ads/data', false); json.send();`);
  assert.deepEqual(json(context, 'log.xhrSends.map(item => item.url)'), ['/content']);
  assert.equal(evaluate(context, 'xhr.readyState'), 1, 'the fake answer arrives asynchronously');
  evaluate(context, 'log.timers.forEach(timer => timer.callback())');
  assert.deepEqual(json(context, 'events'), ['state 4', 'onload', 'loadend']);
  assert.deepEqual(json(context, '{ status: xhr.status, text: xhr.responseText, url: xhr.responseURL }'), { status: 200, text: '[]', url: 'https://example.test/ads/config' });
  assert.deepEqual(json(context, 'json.response'), [], 'a synchronous JSON request is answered at once');
});

test('no-window-open-if refuses matching pop-ups as a browser blocker does', () => {
  const context = load(['+js(nowoif, !example.test)']);
  assert.equal(evaluate(context, "window.open('https://ads.test/pop')"), null);
  assert.deepEqual(json(context, "window.open('https://example.test/help', '_blank')"), { closed: false });
  const all = load(['+js(nowoif)']);
  assert.equal(evaluate(all, "open('/anything')"), null);
  assert.equal(evaluate(all, 'log.opened.length'), 0);
});

test('noeval, noeval-if and alert-buster stop only what they name', () => {
  const context = load(['+js(noeval-if, adblock)', '+js(alert-buster)']);
  assert.equal(evaluate(context, "window.eval('1 + 1')"), 2);
  assert.equal(evaluate(context, "window.eval('globalThis.adblock = 1; 3')"), undefined);
  assert.equal(evaluate(context, 'typeof adblock'), 'undefined');
  evaluate(context, "alert('Disable your ad blocker')");
  assert.equal(evaluate(context, 'log.alerts.length'), 0);
  const none = load(['+js(noeval)']);
  assert.equal(evaluate(none, "window.eval('1')"), undefined);
});

test('storage and cookie scriptlets set only fixed values, and reload once only after a change', () => {
  const context = load(['+js(set-local-storage-item, "consent", accepted)', '+js(set-session-storage-item, seen, emptyObj)',
    '+js(set-local-storage-item, stale, $remove$)', '+js(set-cookie, consent, Accept, /, reload, 1)', '+js(set-cookie, __Secure-ok, 1, none)',
    '+js(set-cookie, keep, no, /, dontOverwrite, 1)'], "localStorage.setItem('stale', '1'); document.cookie = 'keep=yes';");
  assert.equal(evaluate(context, "localStorage.getItem('consent')"), 'accepted');
  assert.equal(evaluate(context, "sessionStorage.getItem('seen')"), '{}');
  assert.equal(evaluate(context, "localStorage.getItem('stale')"), null);
  assert.equal(evaluate(context, 'document.cookie'), 'keep=yes; consent=Accept; __Secure-ok=1');
  assert.deepEqual(json(context, 'log.cookieAttributes'), ['Secure'], 'secure-prefixed cookies are Secure; path none adds no path');
  assert.equal(evaluate(context, 'log.reloads'), 1);
  // Already set: no second write and no reload loop.
  evaluate(context, `(${S.run})(${JSON.stringify([call('+js(set-cookie, consent, Accept, /, reload, 1)')])})`);
  assert.equal(evaluate(context, 'log.reloads'), 1);
});

test('one scriptlet that cannot apply leaves the others working', () => {
  const context = load(['+js(set, locked, true)', '+js(aopr, locked)', '+js(set, works, true)'],
    'Object.defineProperty(window, "locked", { value: false, configurable: false });');
  assert.equal(evaluate(context, 'locked'), false);
  assert.equal(evaluate(context, 'works'), true);
  // Calls that do not come from the parser are ignored.
  assert.doesNotThrow(() => evaluate(page(), `(${S.run})([{ name: 'constructor', args: [] }, { name: 'set-constant', args: [1] }, null])`));
});

test('the document-start code picks each frame\'s rules by its own host and skips frames of a paused page', () => {
  const rule = (body, include, exception = false) => ({ include, exclude: [], exception, ...call(body) });
  const rules = [rule('+js(set, topFlag, true)', ['example.test']), rule('+js(set, frameFlag, true)', ['player.test']), rule('+js(set, topFlag, true)', ['quiet.example.test'], true)];
  const code = S.code(rules, ['paused.test']);
  const frame = (hostname, ancestors) => {
    const context = page(`location.hostname = ${JSON.stringify(hostname)}; location.ancestorOrigins = ${JSON.stringify(ancestors)};`);
    evaluate(context, code);
    return json(context, '{ top: globalThis.topFlag ?? null, frame: globalThis.frameFlag ?? null }');
  };
  assert.deepEqual(frame('www.example.test', null), { top: true, frame: null });
  assert.deepEqual(frame('player.test', ['https://www.example.test']), { top: null, frame: true });
  assert.deepEqual(frame('quiet.example.test', null), { top: null, frame: null });
  // location.ancestorOrigins names the top page; a paused top page turns its frames' scriptlets off.
  assert.deepEqual(frame('player.test', ['https://other.test', 'https://www.paused.test']), { top: null, frame: null });
  assert.deepEqual(frame('player.test', ['https://paused.test', 'https://example.test']), { top: null, frame: true }, 'only the top page counts');
  assert.match(code, /^\(function boot\(/);
});
