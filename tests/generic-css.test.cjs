/* Offline compiler from bundled generic selectors to the registered stylesheets. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { compile, scope, groupable } = require('../scripts/compile-generic-css.cjs');
const { GENERIC_OFF_ATTRIBUTE } = globalThis.BlockAdsCosmetic;
const root = path.resolve(__dirname, '..');
const condition = `:not(:where([${GENERIC_OFF_ATTRIBUTE}] *))`;
const DECLARATION = ' { display: none !important; }';

test('the revocation condition reaches every subject, before pseudo-elements and through escapes', () => {
  for (const [input, output] of [
    ['.ad', '.ad:C'], ['div > a[href*="x"]', 'div > a[href*="x"]:C'], ['a::before', 'a:C::before'], ['a ::after', 'a :C::after'],
    [':before', ':C:before'], ['a, b', 'a:C, b:C'], ['a[title="x, y"]', 'a[title="x, y"]:C'], ['a:not(.b, .c)', 'a:not(.b, .c):C'],
    ['#\\31 280_adv', '#\\31 280_adv:C'], ['a#x\\ y', 'a#x\\ y:C'], ['.a\\>', '.a\\>:C'], ['.a\\:after', '.a\\:after:C'], ['a:after-x', 'a:after-x:C']
  ]) assert.equal(scope(input, ':C'), output, input);
});

test('a selector the condition could turn from invalid into a broader valid one is refused', () => {
  // For example `a >` is invalid; `a >:C` would match every child of a link.
  for (const input of ['a,', ',a', 'a,,b', 'a >', 'a +', 'a ~', '.a\\\\>', 'a:', '']) assert.equal(scope(input, ':C'), null, input);
});

test('only selectors that Chrome 121+ and Firefox 128+ both parse share a rule', () => {
  for (const selector of ['.ad', '#ad_1', 'div', '*', 'div.a.b#c', '[data-ad]', 'a[href^="https://x.test/"]', "a[href*='y' i]", '[class$=-ad]',
    'div > .a + .b ~ .c d', '.a:not(.b)', 'div:not(div > p, .x)', 'li:nth-child(2n + 1)', 'p:first-child', 'td:empty', ':root .x',
    '.col6 > a[onclick*="横幅"]']) assert.equal(groupable(selector), true, selector);
  for (const selector of ['a::before', 'a:hover', 'a:has(b)', 'a:is(.b)', '#1ad', '.\\31 a', 'a, b', 'ns|a', '[a=1]', '[a="x" s]',
    'a:nth-child(2 of .x)', 'a:not(:not(:not(.b)))', 'a >', '.--x', 'a:not()', '[a="x\\"y"]']) assert.equal(groupable(selector), false, selector);
});

test('exceptions decide whether a generic selector is in the main sheet, the excepted sheet or the frame state', () => {
  const result = compile({
    generic: ['.base', '.site-excepted', '.rule-excepted', '.global', '.global-rule', '.near-global', 'a >', '.bad\\', '.base', '#\\31 ad'],
    allow: { '*': ['.global'], 'shop.test': ['.site-excepted'] },
    exceptions: [
      { include: ['news.test', 'b.test'], exclude: ['x.news.test'], selector: '.rule-excepted' },
      // A global exception: never hidden anywhere.
      { include: [], exclude: [], selector: '.global-rule' },
      // Applies everywhere except only.test, so it is resolved for each frame.
      { include: [], exclude: ['only.test'], selector: '.near-global' }
    ] });
  assert.deepEqual(result.genericStatic, { excepted: ['.site-excepted', '.rule-excepted'], exceptedSites: ['b.test', 'news.test', 'shop.test'],
    perFrame: ['.near-global', 'a >', '.bad\\'] });
  assert.deepEqual(result.counts, { base: 2, excepted: 2, exceptedSites: 3, perFrame: 3, separateRules: 1 });
  const { base, excepted } = result.stylesheets;
  assert.match(base, /^@charset "UTF-8";\n\/\*/);
  assert.ok(base.includes(`.base${condition}${DECLARATION}`), 'shared rule');
  assert.ok(base.endsWith(`#\\31 ad${condition}${DECLARATION}`), 'an escaped selector gets a rule of its own');
  assert.ok(!/global|excepted|near|a >|bad/.test(base.slice(base.indexOf('*/'))));
  assert.ok(excepted.includes(`.site-excepted${condition},\n.rule-excepted${condition}${DECLARATION}`));
  assert.throws(() => compile({ generic: [], allow: {}, exceptions: [{ include: [], selector: '.x' }] }), /Invalid exception rule/);
});

test('the offline compiler rejects malformed, non-UTF-8 and oversized input without partial output', () => {
  for (const input of ['{', '{}', JSON.stringify({ generic: [], allow: {}, exceptions: [{}] }), Buffer.from([0xff, 0xfe]), Buffer.alloc(8 * 1024 * 1024 + 1, 32)]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/compile-generic-css.cjs')], { input, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Generic stylesheet compilation failed:/);
  }
});

test('the committed stylesheets and bundle metadata equal a rebuild from the committed bundle', () => {
  const data = JSON.parse(fs.readFileSync(path.join(root, 'rules/community-cosmetic.json'), 'utf8'));
  const rules = [...data.scoped, ...data.procedural];
  const result = compile({ generic: data.generic, allow: data.allow, exceptions: rules.filter(rule => rule.exception) });
  const base = fs.readFileSync(path.join(root, 'rules/community-generic.css'), 'utf8');
  const excepted = fs.readFileSync(path.join(root, 'rules/community-generic-excepted.css'), 'utf8');
  assert.equal(base, result.stylesheets.base + '\n', 'rebuild the rules after changing the bundle or the compiler');
  assert.equal(excepted, result.stylesheets.excepted + '\n');
  assert.deepEqual(data.genericStatic, result.genericStatic);
  // No main-sheet selector has a site exception, and every site with one is excluded from the excepted sheet.
  const inState = new Set([...data.genericStatic.excepted, ...data.genericStatic.perFrame]);
  const sites = new Set(data.genericStatic.exceptedSites);
  const exceptions = [...Object.entries(data.allow).filter(([site]) => site !== '*').flatMap(([site, selectors]) => selectors.map(selector => [site, selector])),
    ...rules.filter(rule => rule.exception).flatMap(rule => rule.include.map(site => [site, rule.selector]))];
  const generic = new Set(data.generic);
  for (const [site, selector] of exceptions.filter(([, selector]) => generic.has(selector))) {
    assert.ok(inState.has(selector), `${selector} stays out of the main sheet`);
    if (data.genericStatic.excepted.includes(selector)) assert.ok(sites.has(site), `${site} skips the excepted sheet`);
  }
  // Every rule stays below Blink's per-rule selector limit and one bad selector voids at most 256.
  for (const sheet of [base, excepted]) {
    const body = sheet.slice(sheet.indexOf('*/') + 3);
    for (const rule of body.split(`${DECLARATION}\n`).filter(Boolean)) {
      const selectors = rule.split(',\n');
      assert.ok(selectors.length <= 256 && (selectors.length === 1 || selectors.join('').length <= 8000), `rule starting ${selectors[0]}`);
      assert.ok(selectors.every(selector => selector.endsWith(condition)), 'every selector can be revoked');
    }
  }
  assert.equal(result.counts.base + result.counts.excepted + result.counts.perFrame, data.generic.length - (data.allow['*'] || []).length);
});
