'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js');
require('../src/userscripts/userscripts-page.js'); require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-actions.js');
const matching = globalThis.BlockAdsMatching, core = globalThis.BlockAdsUserScriptCore;
const metadata = (matches = [], includes = [], excludeMatches = [], excludes = []) => ({ matches, includes, excludeMatches, excludes });
const source = (rules, body = 'globalThis.ran=true;') => '// ==UserScript==\n// @name Matching fixture\n' + rules + '\n// ==/UserScript==\n' + body;
const accepts = (rules, value) => core.allows(core.parse(source(rules)), value);
function wrapper(rules, url) {
  const record = { id: crypto.randomUUID(), token: 'a'.repeat(64), source: source(rules) };
  const context = vm.createContext({ URL, location: { href: url } });
  vm.runInContext(core.registration(record).js[0].code, context, { timeout: 1000 });
  return context.ran === true;
}

test('suffix lookup is reproducible from the pinned, integrity-checked data', () => {
  assert.equal(require('../scripts/build-userscript-suffixes.cjs').build(), fs.readFileSync(require.resolve('../vendor/publicsuffix/suffixes.js'), 'utf8'));
  for (const [host, suffix] of [['example.com', 'com'], ['example.co.uk', 'co.uk'], ['x.a.ck', 'a.ck'], ['www.ck', 'ck'],
    ['a.www.ck', 'ck'], ['www.city.kawasaki.jp', 'kawasaki.jp'], ['x.foo.kawasaki.jp', 'foo.kawasaki.jp'],
    ['x.github.io', 'github.io'], ['x.blogspot.com', 'blogspot.com'], ['x.xn--p1ai', 'xn--p1ai'], ['x.unknown-invalid', '']]) {
    assert.equal(matching.publicSuffix(host), suffix, host);
  }
});

test('extended match patterns normalize schemes, IDNs, IPv6 and default ports', () => {
  for (const [pattern, yes, no] of [
    ['http*://api*.example.test:8080/read*', 'http://api-1.example.test:8080/read?q=1', 'http://api-1.example.test:8081/read'],
    ['*://*example.test/*', 'https://myexample.test/page', 'https://myexample.test.evil.invalid/page'],
    ['https://*.example.test:00443/*', 'https://example.test/page', 'https://example.test:444/page'],
    ['https://bücher.example/*', 'https://xn--bcher-kva.example/page', 'https://books.example/page'],
    ['http://[0:0:0:0:0:0:0:1]:8080/*', 'http://[::1]:8080/page', 'http://[::1]:8081/page'],
    ['http://127.0.0.1:*/*', 'http://127.0.0.1:1234/page', 'https://127.0.0.1:1234/page'],
    ['https://example.test/path?q=1#good*', 'https://example.test/path?q=1#good-two', 'https://example.test/path?q=1#other']
  ]) {
    const rules = '// @match ' + pattern;
    assert.equal(accepts(rules, yes), true, pattern); assert.equal(accepts(rules, no), false, pattern);
    assert.equal(wrapper(rules, yes), true, pattern); assert.equal(wrapper(rules, no), false, pattern);
  }
  assert.deepEqual(core.parse(source('// @match http*://BÜCHER.example:00443/*')).matches, ['*://xn--bcher-kva.example:443/*']);
});

test('existing path/query and include-glob behavior is retained', () => {
  assert.equal(accepts('// @match https://example.test/path', 'https://example.test/path#part'), true);
  assert.equal(accepts('// @match https://example.test/path', 'https://example.test/path?q=1'), false);
  assert.equal(accepts('// @match https://example.test/Path*', 'https://example.test/path'), false);
  assert.equal(accepts('// @include HTTPS://EXAMPLE.TEST/Path?key=*#part', 'https://example.test/pATH?key=yes#part'), true);
  assert.equal(accepts('// @include *?key=*', 'https://example.test/pathXkey=yes'), false, '? stays literal');
  assert.equal(accepts('// @include https://*.example.test/*', 'https://example.test/path'), false, 'glob wildcard requires the dot');
});

test('.tld uses longest known public/private suffixes and rejects deceptive or unknown hosts', () => {
  const rules = '// @match https://example.tld/*';
  for (const host of ['example.com', 'example.co.uk', 'example.github.io', 'example.xn--p1ai', 'example.a.ck']) {
    assert.equal(accepts(rules, 'https://' + host + '/path'), true, host);
    assert.equal(wrapper(rules, 'https://' + host + '/path'), true, host);
  }
  for (const host of ['example.com.evil.invalid', 'example.unknown-invalid', 'example.com.attacker.org', 'example.com.github.io', 'example.ck', 'com']) {
    assert.equal(accepts(rules, 'https://' + host + '/path'), false, host);
    assert.equal(wrapper(rules, 'https://' + host + '/path'), false, host);
  }
  assert.equal(accepts('// @match https://www.tld/*', 'https://www.ck/'), true);
  assert.equal(accepts('// @match https://city.tld/*', 'https://city.kawasaki.jp/'), true);
  assert.equal(accepts('// @match https://*.example.tld/*', 'https://sub.example.co.uk/'), true);
  assert.equal(accepts('// @include https://*.example.tld/*', 'https://example.co.uk/'), false);
  assert.equal(accepts('// @include https://*.example.tld:443/*', 'https://sub.example.co.uk/'), true);
  assert.equal(accepts('// @include http*://bücher.tld:*/*', 'https://xn--bcher-kva.com:8080/read'), true);
});

test('regular expression includes and exclusions have union/veto semantics in every wrapper world', () => {
  const rules = '// @match https://other.test/*\n// @include /^https?:\\/\\/(?:www\\.)?example\\.test\\/read(?:\\/[a-z0-9_-]+)?(?:\\?id=\\d{1,3})?$/\n// @exclude /private|#secret/\n// @exclude-match https://other.test:443/deny*';
  for (const world of ['', '\n// @inject-into page']) {
    for (const [url, expected] of [['https://EXAMPLE.test/READ/one?id=12', true], ['http://www.example.test/read', true],
      ['https://other.test/page', true], ['https://other.test/deny', false], ['https://other.test/page#secret', false],
      ['https://example.test/read/private', false], ['https://example.test/read/one?id=1234', false], ['https://example.test.evil.invalid/read', false]]) {
      assert.equal(accepts(rules, url), expected, url); assert.equal(wrapper(rules + world, url), expected, url);
    }
  }
});

test('malformed/unsupported syntax is rejected at metadata validation', () => {
  for (const regex of ['/abc/i', '/(?=a)/', '/(?<=a)/', '/(?<name>a)/', '/(a)\\1/', '/\\p{Letter}/', '/a{129}/', '/[z-a]/', '/[abc/', '/(/', '/a**/', '/\\u{1234}/', '/\\/', '/\\07/']) {
    assert.throws(() => core.parse(source('// @include ' + regex)), /regular expression/i, regex);
  }
  for (const pattern of ['ftp://example.test/*', 'https://user@example.test/*', 'https://example.test:65536/*',
    'https://example.test:x/*', 'http://[bad]/*', 'https://-example.test/*', 'https://' + 'a'.repeat(64) + '.test/*']) {
    assert.throws(() => core.parse(source('// @match ' + pattern)), /match|port/i, pattern);
  }
  assert.throws(() => core.parse(source('// @include https://user@example.tld/*')), /host/);
  assert.throws(() => matching.create().matchPattern('https://example.tld/*'), /unavailable/);
});

test('bounded regular-language evaluator agrees with native regex on small synthetic inputs', () => {
  const patterns = ['^a$', 'a|bc', '(?:ab|a)*c', '(a+)+b', '(a|aa)*b', 'a{0,2}b{1,3}', '(?:a?)*b',
    '[a-c]+', '[^b]*c', '\\w+\\b', '\\Ba', 'a.*c', 'a.?c', 'a+?', '^$', 'a{0}', '(a|)(b|c)', '^a|b$',
    '\\x61\\u0062', '[\\dA-C_-]+', '^https?://example\\.test/(a|b)?$', '(?:(?:a|b){1,2}){0,2}c'];
  let inputs = ['', 'https://example.test/a', 'http://example.test/'];
  let layer = [''];
  for (let n = 0; n < 5; n++) { layer = layer.flatMap(s => ['a','b','c','A','0','_'].map(c => s + c)); inputs.push(...layer); }
  let comparisons = 0;
  for (const pattern of patterns) {
    const native = new RegExp(pattern, 'i'), program = matching.regexProgram(pattern);
    for (const value of inputs) { assert.equal(matching.regexTest(program, value, { work: 1000000 }), native.test(value), pattern + ' on ' + value); comparisons++; }
  }
  assert.ok(comparisons > 200000);
});

test('nested repeats cannot backtrack exponentially and exhausted exclusions fail closed', () => {
  const hard = 'https://example.test/' + 'a'.repeat(16000) + 'c';
  const evaluate = meta => vm.runInNewContext('matching.allows(meta, url)', { matching, meta, url: hard }, { timeout: 1000 });
  for (const regex of ['/(a+)+b/', '/(a|aa)*b/']) assert.equal(evaluate(metadata([], [regex])), false);
  const emptyAlternatives = '/(?:(?:' + '|'.repeat(600) + '){128})*b/';
  assert.equal(evaluate(metadata([], [emptyAlternatives])), false, 'empty alternatives cannot hide work from the budget');
  const revisits = matching.regexProgram('(?:a?|a?)*b');
  assert.throws(() => matching.regexTest(revisits, 'a'.repeat(100), { work: 16 }), /work limit/);
  const nestedEmpty = '(?:(?:(?:){128}){128}){128}';
  assert.throws(() => vm.runInNewContext('matching.regexProgram(pattern)', { matching, pattern: nestedEmpty }, { timeout: 1000 }), /compilation work limit/);
  assert.throws(() => core.parse(source('// @include /' + nestedEmpty + '/')), /compilation work limit/);
  const expensive = '/(?:a?){128}b/';
  assert.throws(() => matching.regexTest(matching.regexProgram(expensive.slice(1, -1)), hard, { work: 1000000 }), /work limit/);
  assert.equal(evaluate(metadata(['https://*/*'], [], [], [expensive])), false, 'an unchecked exclusion must never grant access');
  assert.equal(accepts('// @include *', 'https://example.test/' + 'x'.repeat(32768)), false);
  assert.equal(accepts('// @include *', 'https://example.test/' + 'é'.repeat(6000)), false, 'canonical URL length is also bounded');
  assert.equal(accepts('// @include *', 'file:///path'), false);
  assert.equal(accepts('// @include *', 'https://example.test/\n'), false);
});

test('native prefilters are supersets of regex and suffix rules without leaking the reserved placeholder', () => {
  const nativeGlob = (glob, url) => new RegExp('^' + glob.split('*').map(p => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('?', '.')).join('.*') + '$').test(url);
  for (const [pattern, url] of [
    ['/^https?:\\/\\/(www\\.)?example\\.test\\/Read/', 'https://www.example.test/rEAD?q=1'],
    ['/^https:\/\/example\\.test\/path#good$/', 'https://example.test/path#good'],
    ['/read/', 'https://example.test/read'], ['https://example.tld:443/read*', 'https://example.co.uk/read'],
    ['http*://bücher.tld:*/*', 'http://xn--bcher-kva.com:8080/read']
  ]) {
    const meta = core.parse(source('// @include ' + pattern)), prefilter = matching.prefilter(meta);
    assert.equal(core.allows(meta, url), true, pattern);
    assert.ok(prefilter.includeGlobs.some(glob => nativeGlob(glob, url.split('#')[0])), pattern);
    assert.equal(core.allows(meta, prefilter.matches[0]), false);
  }
  const prefilter = matching.prefilter(metadata(['https://api*.example.test:443/x#y', 'http://[::1]:1234/*'], [], ['https://example.test:443/private', 'https://example.tld/*']));
  assert.deepEqual(prefilter.matches, ['https://*.example.test/x*', 'http://*/*']);
  assert.deepEqual(prefilter.excludeMatches, []);
});

test('injected suffix data is included only for actual hostname expansion', () => {
  for (const rules of ['// @match https://example.test/file.tld/path', '// @include /example.tld/']) {
    assert.ok(matching.guard(core.parse(source(rules))).length < 30000, 'literal path/regex text does not bundle the suffix list');
  }
  assert.ok(matching.guard(core.parse(source('// @match https://example.tld/*'))).length > 150000);
});
