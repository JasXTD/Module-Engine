const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../src/blocking/cosmetic.js');
const filters = globalThis.BlockAdsCosmetic;
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('offline compiler rejects malformed, non-UTF8 and excessive input without returning partial rules', () => {
  for (const input of ['{', '{}', '[{}]', JSON.stringify(Array(5001).fill(null)), Buffer.from([0xff, 0xfe]), Buffer.alloc(8 * 1024 * 1024 + 1, 32)]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, '../scripts/compile-procedural.cjs')], { input, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Procedural compilation failed:/);
  }
});

test('a scoped text filter compiles as a procedure rather than invalid CSS', () => {
  const [rule] = filters.parse('example.test##.label:has-text(Sponsored):upward(1)');
  assert.deepEqual(rule.procedure, { css: '.label', ops: [{ type: 'text', value: 'Sponsored' }, { type: 'upward', count: 1 }] });
});
test('nested child and text filters preserve relative child scope and Unicode', () => {
  const plan = filters.compileSelector('.card:-abp-has(> .label:-abp-contains(广告))');
  assert.deepEqual(plan, { css: '.card', ops: [{ type: 'has', plan: { css: ':scope > .label', ops: [{ type: 'text', value: '广告' }] } }] });
});
test('native CSS stays declarative, including procedural-looking strings inside attributes', () => {
  for (const css of ['.card:has(> .label)', '[data-label=":has-text(Ad)"]', '.a:is(.b, .c)']) {
    assert.deepEqual(filters.compileSelector(css), { css, ops: [] });
  }
});

test('explicit procedural separators preserve that choice for native CSS and its exception', () => {
  const custom = filters.parse('example.test#?#.card:has(> .label)\nshop.example.test#@?#.card:has(> .label)');
  assert.deepEqual(custom[0].procedure, { css: '.card:has(> .label)', ops: [] });
  assert.equal(filters.resolve({}, 'example.test', { custom }).proceduralRules.length, 1);
  assert.equal(filters.resolve({}, 'shop.example.test', { custom }).proceduralRules.length, 0);
});
test('literal text supports quoted punctuation and escaped quotes without evaluating a pattern', () => {
  assert.equal(filters.compileSelector('.label:has-text("Ad (paid)")').ops[0].value, 'Ad (paid)');
  assert.equal(filters.compileSelector('.label:has-text("Say \\"Ad\\"")').ops[0].value, 'Say "Ad"');
  assert.throws(() => filters.compileSelector('.label:has-text(/ad+/i)'), /regular expression/i);
});
test('unsupported syntax, ambiguous scope and excessive complexity fail explicitly', () => {
  for (const selector of ['.a:has-text()', '.a:has-text("")', '.a:upward(0)', '.a:upward(11)',
    '.a:has-text(Ad) > img', '.a,.b:has-text(Ad)', '.a:not(:has-text(Ad))',
    '.a:-abp-has(+ .label)', '.a:matches-css(color: red)', '.a:has-text(Ad):remove()',
    '.a:has-text(Ad) {color:red}', '.a:has-text(/(a+)+$/)', '.a:has-text("bad\\n")',
    '.a' + ':has-text(Ad)'.repeat(9), '.a:-abp-has('.repeat(5) + '.label' + ')'.repeat(5)]) {
    assert.throws(() => filters.compileSelector(selector), undefined, selector);
  }
});
test('browser CSS validation checks each subject and ancestor selector', () => {
  const seen = [];
  filters.parse('example.test##.card:has(.label:has-text(Ad)):upward(.section)', css => { seen.push(css); return true; });
  assert.deepEqual(seen, ['.card', '.label', '.section']);
  assert.throws(() => filters.parse('example.test##.label:has-text(Ad):upward(.broken)', css => css !== '.broken'), /Line 1:.*parse/);
});
test('procedural exceptions and site exclusions remain separate from generic CSS', () => {
  const selector = '.label:has-text(Sponsored)';
  const custom = filters.parse(`example.test,~shop.example.test##${selector}\nnews.example.test#@#${selector}`);
  assert.equal(filters.resolve({}, 'example.test', { custom }).proceduralRules.length, 1);
  assert.equal(filters.resolve({}, 'shop.example.test', { custom }).proceduralRules.length, 0);
  assert.equal(filters.resolve({}, 'news.example.test', { custom }).proceduralRules.length, 0);
  assert.equal(filters.resolve({ disableAll: ['example.test'] }, 'example.test', { custom }).proceduralRules.length, 0);
  assert.equal(filters.resolve({ disableGeneric: ['example.test'] }, 'example.test', { custom }).proceduralRules.length, 1);
  assert.deepEqual(filters.resolve({}, 'example.test', { custom }).siteSelectors, []);
});
