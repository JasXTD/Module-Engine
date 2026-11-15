'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
globalThis.acorn = require('../vendor/acorn/acorn.js');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js');
require('../src/userscripts/userscripts-page.js'); require('../src/userscripts/userscripts-core.js');
require('../src/userscripts/userscripts-lint.js');
const core = BlockAdsUserScriptCore;
const source = body => '// ==UserScript==\n// @name Bidi review\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n' + body;

test('raw direction controls produce review warnings and located lint diagnostics without rewriting code', () => {
  for (const code of [0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]) {
    const character = String.fromCodePoint(code), input = source('// ' + character + '\nconst label="' + character + '";');
    assert.ok(core.parse(input).warnings.some(message => /direction control/i.test(message)));
    const warnings = BlockAdsLint.inspect(input).diagnostics;
    assert.equal(warnings.length, 2); assert.ok(warnings.every(item => item.kind === 'bidi' && item.severity === 'warning'));
    assert.equal(input[warnings[0].offset], character); assert.equal(warnings[0].line, 6); assert.equal(warnings[0].column, 4);
    assert.ok(warnings[0].message.includes('U+' + code.toString(16).toUpperCase().padStart(4, '0')));
  }
});

test('direction-control locations use original UTF-16 offsets and JavaScript line endings', () => {
  const input = 'a\r\n😀\u202e\rb\u2066\nc\u2069\u2028d\u200e\u2029e\u061c';
  const result = core.bidiControls(input);
  assert.equal(result.count, 5);
  assert.deepEqual(result.locations.map(({ line, column }) => [line, column]), [[2,3],[3,2],[4,2],[5,2],[6,2]]);
  for (const item of result.locations) assert.equal(core.escapeBidi(input[item.offset]), item.escape);
});

test('ordinary RTL text and already escaped source are not treated as hidden controls', () => {
  const input = source('const greeting = "مرحبا שלום"; const explicit = "\\u202E";');
  assert.deepEqual(BlockAdsLint.inspect(input).diagnostics, []);
  assert.equal(core.bidiControls(input).count, 0); assert.equal(core.escapeBidi(input), input);
  assert.equal(core.escapeBidi('a\u202eb\u2069'), 'a\\u202Eb\\u2069');
});

test('control diagnostics remain bounded while the review escapes every occurrence', () => {
  const input = source('// ' + '\u202e'.repeat(1000)), result = core.bidiControls(input);
  assert.equal(result.count, 1000); assert.equal(result.locations.length, 20);
  assert.equal(BlockAdsLint.inspect(input).diagnostics.length, 20);
  assert.equal((core.escapeBidi(input).match(/\\u202E/g) || []).length, 1000);
});
