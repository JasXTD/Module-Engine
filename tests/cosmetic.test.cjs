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
test('the built package retains thousands of generic selectors and site exceptions', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../rules/community-cosmetic.json'), 'utf8'));
  assert.equal(data.schemaVersion, 3);
  assert.ok(data.generic.length > 10000);
  assert.ok(data.scoped.length > 0);
  assert.ok(data.disableGeneric.length > 100);
  assert.equal(new Set(data.generic).size, data.generic.length);
  for (const selector of data.generic) assert.doesNotThrow(() => safeSelector(selector));
});
