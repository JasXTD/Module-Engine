const { test } = require('node:test'), assert = require('node:assert/strict');
globalThis.acorn = require('../vendor/acorn/acorn.js');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js'); require('../src/userscripts/userscripts-page.js'); require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-lint.js');
const source = code => '// ==UserScript==\n// @name Offline editor\n// @match https://example.test/*\n// @grant none\n// ==/UserScript==\n' + code;
test('Windows CRLF metadata parses identically and diagnostics retain raw-source offsets', () => {
  const lf = source('const broken = ;'), crlf = lf.replaceAll('\n', '\r\n');
  const windows = BlockAdsUserScriptCore.parse(crlf), unix = BlockAdsUserScriptCore.parse(lf);
  assert.equal(windows.metaStr, unix.metaStr.replaceAll('\n', '\r\n'));
  assert.deepEqual({ ...windows, metaStr: unix.metaStr }, unix);
  const problem = BlockAdsLint.inspect(crlf).diagnostics[0];
  assert.equal(problem.kind, 'syntax'); assert.equal(problem.offset, crlf.lastIndexOf(';')); assert.equal(problem.line, 6);
});
test('lint returns precise locations and treats source as inert text', () => {
  const input = source('const broken = ;\nglobalThis.__lintExecuted = true;');
  const result = BlockAdsLint.inspect(input), problem = result.diagnostics[0];
  assert.equal(problem.kind, 'syntax'); assert.equal(problem.line, 6); assert.equal(problem.column, 16);
  assert.equal(input[problem.offset], ';'); assert.equal(globalThis.__lintExecuted, undefined);
  assert.ok(result.tokens.some(token => token.kind === 'keyword' && input.slice(token.start, token.end) === 'const'));
});
test('lint checks strict wrapper bindings and permits valid function-body syntax', () => {
  assert.deepEqual(BlockAdsLint.inspect(source('return;')).diagnostics, []);
  assert.match(BlockAdsLint.inspect(source('const GM = 1;')).diagnostics[0].message, /already been declared/);
  assert.deepEqual(BlockAdsLint.inspect(source('const GM = 1;').replace('// @grant none', '// @grant none\n// @inject-into page')).diagnostics, []);
  assert.equal(BlockAdsLint.inspect(source('with ({}) {}')).diagnostics[0].kind, 'syntax');
  assert.deepEqual(BlockAdsLint.inspect(source('const pattern = /a+/g; const value = `hello ${1+2}`;')).diagnostics, []);
  const incomplete=source('if (true) {');const last=BlockAdsLint.inspect(incomplete).diagnostics[0];
  assert.equal(last.offset,incomplete.length);assert.equal(last.line,6);assert.match(last.message,/end of script/);
});
test('lint bounds oversized source and token output, and reports metadata separately', () => {
  assert.equal(BlockAdsLint.inspect('a'.repeat(131073)).diagnostics[0].kind, 'limit');
  const dense = BlockAdsLint.inspect(source('0;'.repeat(30000))); assert.ok(dense.tokens.length <= 20000);
  assert.equal(BlockAdsLint.inspect('const value=1;').diagnostics[0].kind, 'metadata');
  const html = source('const markup = "<img src=x onerror=alert(1)>";');
  assert.deepEqual(BlockAdsLint.inspect(html).diagnostics, []);
  assert.ok(BlockAdsLint.inspect(html).tokens.some(token => token.kind === 'string' && html.slice(token.start, token.end).includes('<img')));
});
