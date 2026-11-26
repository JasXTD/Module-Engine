const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../src/blocking/cosmetic.js');
const { parse, resolve, safeSelector, LIMITS } = globalThis.BlockAdsCosmetic;

test('generic hiding respects inherited and global selector exceptions', () => {
  const data = { generic: ['.ad', '.banner'], hide: { 'example.test': ['.local'] }, allow: { 'shop.example.test': ['.ad'], '*': ['.local'] } };
  assert.deepEqual(resolve(data, 'WWW.shop.example.test.').genericSelectors, ['.banner']);
  assert.deepEqual(resolve(data, 'shop.example.test').siteSelectors, []);
  assert.deepEqual(resolve(data, 'notexample.test').genericSelectors, ['.ad', '.banner']);
});
test('negative scopes do not cancel independent rules with the same selector', () => {
  const scoped = [
    { include: ['example.test'], exclude: ['shop.example.test'], selector: '.ad', exception: false },
    { include: [], exclude: ['private.test'], selector: '.generic', exception: false }
  ];
  assert.deepEqual(resolve({ scoped }, 'news.example.test').siteSelectors, ['.ad']);
  assert.deepEqual(resolve({ scoped }, 'shop.example.test').siteSelectors, []);
  assert.deepEqual(resolve({ scoped, hide: { 'shop.example.test': ['.ad'] } }, 'shop.example.test').siteSelectors, ['.ad']);
  assert.deepEqual(resolve({ scoped }, 'a.private.test').genericSelectors, []);
  assert.deepEqual(resolve({ scoped }, 'private.test.other').genericSelectors, ['.generic']);
});
test('generic-only and all-cosmetic exceptions remain distinct', () => {
  const data = { generic: ['.global'], hide: { 'example.test': ['.site'] }, disableGeneric: ['example.test'], disableAll: ['reader.test'] };
  assert.deepEqual(resolve(data, 'example.test').genericSelectors, []);
  assert.deepEqual(resolve(data, 'example.test').siteSelectors, ['.site']);
  assert.equal(resolve(data, 'reader.test').disableAll, true);
  assert.equal(resolve(data, 'notreader.test').disableAll, false);
  assert.deepEqual(resolve({ generic: ['.global'] }, 'other.test', { generic: false }).genericSelectors, []);
});
test('custom filters preserve site scope, IDN names, selector case and exclusions', () => {
  const rules = parse('! comment\nWWW.Example.test,~shop.www.example.test##.AdCard:has(a[href="https://example.test/"])\nbücher.example#@#.AdCard');
  assert.deepEqual(rules[0].include, ['www.example.test']);
  assert.deepEqual(rules[0].exclude, ['shop.www.example.test']);
  assert.deepEqual(rules[1].include, ['xn--bcher-kva.example']);
  assert.equal(rules[1].exception, true);
  assert.equal(resolve({}, 'example.test', { custom: rules }).siteSelectors.length, 0);
  assert.equal(resolve({}, 'www.example.test', { custom: rules }).siteSelectors.length, 1);
  assert.equal(resolve({}, 'shop.www.example.test', { custom: rules }).siteSelectors.length, 0);
});
test('unsafe, unscoped, unsupported and malformed filters fail with a line number', () => {
  for (const line of ['##.ad', '~example.test##.ad', '*.example.test##.ad', 'example.test/path##.ad',
    'example.test##+js(alert)', 'example.test##div:has-text(/Ad/i)', 'example.test##.ad { color:red }',
    'example.test##.ad; body', 'example.test##[broken', 'example.test##.ad/*comment*/', 'example.test##a:style(display:none)',
    'example.test##a[href="unclosed]', 'example.test##.bad\\', '||example.test^']) {
    assert.throws(() => parse(`! comment\n${line}`), /Line 2:/, line);
  }
  assert.throws(() => parse('example.test##.valid', () => false), /cannot parse/);
  assert.throws(() => parse('example.test##' + 'x'.repeat(LIMITS.selector + 1)), /Line 1:/);
  assert.throws(() => parse('x'.repeat(LIMITS.text + 1)), /characters/);
  assert.throws(() => parse(Array(LIMITS.rules + 1).fill('example.test##.ad').join('\n')), /At most/);
  assert.equal(safeSelector('[data-label="(ad)"]:has(> img)'), '[data-label="(ad)"]:has(> img)');
  assert.equal(safeSelector('a[href*="@ads;placement"]'), 'a[href*="@ads;placement"]');
});
test('custom exceptions remain available with community filtering disabled', () => {
  const custom = parse('localhost##.local\nlocalhost#@#.ad-slot');
  const result = resolve({}, 'localhost', { custom });
  assert.deepEqual(result.siteSelectors, ['.local']);
  assert.deepEqual(result.exceptions, ['.ad-slot']);
});
test('frames with the bundled stylesheets receive only the generic selectors those sheets leave out', () => {
  const data = { generic: ['.base', '.excepted-a', '.excepted-b', '.per-frame', '.allowed'], hide: {},
    allow: { 'shop.test': ['.excepted-a'], 'other.test': ['.excepted-b'], '*': ['.allowed'] },
    scoped: [{ include: [], exclude: ['quiet.test'], selector: '.scoped-generic', exception: false }],
    genericStatic: { excepted: ['.excepted-a', '.excepted-b'], exceptedSites: ['other.test', 'shop.test'], perFrame: ['.per-frame'] } };
  const all = ['.base', '.excepted-a', '.excepted-b', '.per-frame', '.scoped-generic'];
  // A frame without the sheets keeps the complete message-path list.
  assert.deepEqual(resolve(data, 'news.test').genericSelectors, all);
  assert.equal(resolve(data, 'news.test').genericStatic, false);
  const news = resolve(data, 'news.test', { staticSheets: true });
  assert.equal(news.genericStatic, true);
  assert.deepEqual(news.genericSelectors, ['.per-frame', '.scoped-generic']);
  // The excepted sheet skips its sites: their remaining excepted selectors come with the state.
  const shop = resolve(data, 'www.shop.test', { staticSheets: true });
  assert.equal(shop.genericStatic, true);
  assert.deepEqual(shop.genericSelectors, ['.per-frame', '.excepted-b', '.scoped-generic']);
  assert.deepEqual(resolve(data, 'quiet.test', { staticSheets: true }).genericSelectors, ['.per-frame']);
});
test('pauses, generichide, elemhide and own exceptions revoke the bundled stylesheets', () => {
  const data = { generic: ['.base', '.other'], hide: {}, allow: {}, disableGeneric: ['quiet.test'], disableAll: ['reader.test'],
    genericStatic: { excepted: [], exceptedSites: [], perFrame: [] } };
  const sheets = { staticSheets: true };
  assert.deepEqual(resolve(data, 'quiet.test', sheets), { ...resolve(data, 'quiet.test', sheets), genericStatic: false, genericSelectors: [] });
  assert.equal(resolve(data, 'reader.test', sheets).genericStatic, false);
  assert.deepEqual(resolve(data, 'reader.test', sheets).genericSelectors, [], 'an elemhide frame hides nothing, so receives nothing');
  assert.equal(resolve(data, 'news.test', { ...sheets, generic: false }).genericStatic, false);
  // A user's exception for a bundled generic selector cannot be expressed in a
  // stylesheet: the frame revokes the sheets and receives the rest by message.
  const custom = parse('news.test#@#.base\nshop.test#@#.unrelated');
  const excepted = resolve(data, 'a.news.test', { ...sheets, custom });
  assert.equal(excepted.genericStatic, false);
  assert.deepEqual(excepted.genericSelectors, ['.other']);
  assert.equal(resolve(data, 'shop.test', { ...sheets, custom }).genericStatic, true);
  assert.equal(resolve(data, 'other.test', { ...sheets, custom }).genericStatic, true);
  // Bundles without (or with malformed) stylesheet data never claim static coverage.
  assert.equal(resolve({ generic: ['.base'] }, 'news.test', sheets).genericStatic, false);
  assert.deepEqual(resolve({ generic: ['.base'] }, 'news.test', sheets).genericSelectors, ['.base']);
  assert.equal(resolve({ ...data, genericStatic: { excepted: [1], exceptedSites: [], perFrame: [] } }, 'news.test', sheets).genericStatic, false);
});

test('updated and scoped exceptions override exactly the generic selectors a frame received as CSS', () => {
  const data = { generic: ['.base', '.other', '.excepted'], genericStatic: {
    excepted: ['.excepted'], exceptedSites: ['original.test'], perFrame: [] },
    allow: { 'moved.test': ['.excepted'], 'sub.original.test': ['.base'] },
    scoped: [{ exception: true, include: ['news.test'], exclude: ['keep.news.test'], selector: '.base' }] };
  const frame = host => resolve(data, host, { staticSheets: true });
  for (const [host, allowed] of [['sub.moved.test', '.excepted'], ['sub.original.test', '.base'], ['news.test', '.base']]) {
    const state = frame(host);
    assert.equal(state.genericStatic, false, host);
    assert.deepEqual(state.genericSelectors, data.generic.filter(selector => selector !== allowed));
  }
  assert.deepEqual(frame('original.test').genericSelectors, ['.excepted'], 'a removed exception restores the selector');
  assert.equal(frame('keep.news.test').genericStatic, true);
  assert.equal(frame('unrelated.test').genericStatic, true);
});

test('adding and removing global exceptions switches between compiled CSS and per-frame hiding', () => {
  const data = { generic: ['.compiled', '.omitted'], genericStatic: { excepted: [], exceptedSites: [], perFrame: [] },
    bundledGlobalExceptions: ['.omitted'], scoped: [], procedural: [], allow: { '*': ['.compiled'] } };
  const updated = resolve(data, 'any.example', { staticSheets: true });
  assert.equal(updated.genericStatic, false);
  assert.deepEqual(updated.genericSelectors, ['.omitted']);
  const restored = resolve({ ...data, allow: {} }, 'any.example', { staticSheets: true });
  assert.equal(restored.genericStatic, true);
  assert.deepEqual(restored.genericSelectors, ['.omitted']);
});
test('hiding CSS splits long selector lists below the browser per-rule selector limit', () => {
  const { hidingCss } = globalThis.BlockAdsCosmetic;
  const selectors = [...Array.from({ length: 700 }, (_, i) => `.s${i}`), 'x'.repeat(1000), ...Array.from({ length: 400 }, (_, i) => `#long-selector-name-${i}`)];
  const rules = hidingCss(selectors).split(' { display: none !important; }\n');
  assert.equal(rules.pop(), '');
  const groups = rules.map(rule => rule.split(',\n'));
  assert.deepEqual(groups.flat(), selectors, 'every selector is kept, in order');
  for (const group of groups) {
    assert.ok(group.length <= 256 && (group.length === 1 || group.join('').length <= 8000), `rule of ${group.length} selectors`);
  }
  assert.ok(groups.length > 3);
  assert.equal(hidingCss([]), '');
});
test('the built package retains thousands of generic selectors and site exceptions', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../rules/community-cosmetic.json'), 'utf8'));
  assert.equal(data.schemaVersion, 3);
  assert.ok(data.generic.length > 10000);
  assert.ok(data.scoped.length > 0);
  assert.ok(data.disableGeneric.length > 100);
  assert.equal(new Set(data.generic).size, data.generic.length);
  for (const selector of data.generic) assert.doesNotThrow(() => safeSelector(selector));
});

test('procedural operators after a space or combinator are refused instead of hiding the ancestor', () => {
  const { compileSelector } = globalThis.BlockAdsCosmetic;
  // Each form targets descendants; dropping the combinator would hide the subject itself.
  for (const selector of ['.content :has-text(Sponsored)', '.feed > div:has(> a) :has-text(Promoted)', '.a:has-text(x) :has-text(y)',
    'div :upward(1)', '.card > :has-text(Ad)', 'section div:has(> .x :has-text(y))']) {
    assert.throws(() => compileSelector(selector), /follow their CSS subject directly/, selector);
    assert.throws(() => parse('example.com##' + selector), /Line 1: Procedural operators must follow/, selector);
  }
  assert.deepEqual(compileSelector('.content:has-text(Sponsored)'), { css: '.content', ops: [{ type: 'text', value: 'Sponsored' }] });
  assert.deepEqual(compileSelector('.feed > div:has(> a):has-text(Promoted)').ops.map(op => op.type), ['has', 'text']);
  // An escaped space is part of the subject, not a combinator; the subject is still refused as incomplete.
  assert.throws(() => compileSelector(String.raw`.a\ :has-text(x)`), /Incomplete CSS escape/);
  assert.deepEqual(compileSelector('.a:has-text(x) ').ops, [{ type: 'text', value: 'x' }], 'trailing whitespace is not a combinator');
});

test('custom scriptlet rules parse beside hiding rules, never become selectors and need the scriptlet parser', () => {
  const text = 'example.com##.ad\nexample.com,~shop.example.com##+js(set, adsBlocked, false)\nexample.com#@#+js()\nnews.example.com#@#+js(aopr, detect)';
  // Content scripts load no scriptlet parser; a page that must check scriptlet rules says so.
  assert.throws(() => parse(text), /Line 2: Scriptlet filters cannot be checked here/);
  require('../src/blocking/scriptlets.js');
  const rules = parse(text);
  assert.deepEqual(rules.map(rule => rule.scriptlet || null), [null, { name: 'set-constant', args: ['adsBlocked', 'false'] },
    { name: '', args: [] }, { name: 'abort-on-property-read', args: ['detect'] }]);
  assert.deepEqual(rules[1].exclude, ['shop.example.com']);
  assert.equal(rules[2].exception, true);
  const resolved = resolve({}, 'www.example.com', { custom: rules });
  assert.deepEqual([resolved.siteSelectors, resolved.exceptions, resolved.proceduralRules], [['.ad'], [], []]);
  for (const line of ['example.com##+js()', 'example.com#?#+js(set, a, true)', 'example.com##+js(unknown-scriptlet)', '##+js(set, a, true)', 'example.com##+js(set, a, maybe)']) {
    assert.throws(() => parse('! comment\n' + line), /^Error: Line 2: /, line);
  }
  assert.equal(parse(Array(LIMITS.rules).fill('example.com##+js(nowoif)').join('\n')).length, LIMITS.rules, 'scriptlet rules count toward the same limit');
});
