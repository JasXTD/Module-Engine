const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
globalThis.acorn = require('../vendor/acorn/acorn.js');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js');
require('../src/userscripts/userscripts-page.js'); require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-actions.js'); require('../src/userscripts/userscripts-lint.js');
const core = BlockAdsUserScriptCore;
const source = (metadata, body = '') => '// ==UserScript==\n// @name Execution fixture\n// @match https://example.test/*\n' + metadata + '// ==/UserScript==\n' + body;
const compile = (metadata, body, assets) => core.registration({ id: '12345678-1234-1234-1234-123456789abc', token: 'f'.repeat(64), source: source(metadata, body), assets }).js[0].code;
const context = (extra = {}) => vm.createContext({ URL, TextEncoder, TextDecoder, location: { href: 'https://example.test/page' }, console, ...extra });

test('unsafeWindow follows the selected world and page GM grants use an isolated relay', () => {
  for (const world of ['content', 'page']) {
    const metadata = '// @grant unsafeWindow\n// @inject-into ' + world + '\n';
    const scope = context(); vm.runInContext(compile(metadata, 'unsafeWindow.marker=42;globalThis.same=unsafeWindow===globalThis;'), scope);
    assert.equal(scope.marker, 42); assert.equal(scope.same, true);
    assert.equal(core.parse(source(metadata)).world, world === 'page' ? 'MAIN' : 'USER_SCRIPT');
  }
  const metadata = core.parse(source('// @inject-into page\n// @grant unsafeWindow\n// @grant GM_cookie\n'));
  assert.equal(metadata.world, 'MAIN'); assert.equal(metadata.pageBridge, true);
  assert.equal(core.nativeWorld(metadata), 'USER_SCRIPT');
  assert.ok(metadata.warnings.some(warning => warning.includes('invoke its granted helpers')));
});

test('top-level await preserves synchronous prefixes and reports rejections', async () => {
  const metadata = '// @top-level-await\n// @grant GM_info\n';
  assert.deepEqual(BlockAdsLint.inspect(source(metadata, 'await Promise.resolve(); return;')).diagnostics, []);
  const errors = [], scope = context({ console: { error: (...args) => errors.push(args.join(' ')) } });
  vm.runInContext(compile(metadata, 'globalThis.before=1;await Promise.resolve();globalThis.after=GM_info.script.topLevelAwait;'), scope);
  assert.equal(scope.before, 1); assert.equal(scope.after, undefined);
  await new Promise(setImmediate); assert.equal(scope.after, true);
  vm.runInContext(compile(metadata, 'await Promise.reject(new Error("owned rejection"));'), scope);
  await new Promise(setImmediate); assert.equal(errors.length, 1); assert.match(errors[0], /owned rejection/);
  assert.equal(BlockAdsLint.inspect(source('', 'await Promise.resolve();')).diagnostics[0].kind, 'syntax');
  for (const key of ['top-level-await', 'unwrap']) {
    assert.throws(() => core.parse(source('// @' + key + ' true\n')), /takes no value/);
    assert.throws(() => core.parse(source('// @' + key + '\n// @' + key + '\n')), /only one/);
  }
});

test('cached dependencies share the async body or unwrapped global scope without fetching', async () => {
  const asset = body => ({ kind: 'require', url: 'https://assets.example.test/library.js', mime: 'text/javascript',
    sha256: require('node:crypto').createHash('sha256').update(body).digest('hex'), body: Buffer.from(body).toString('base64') });
  const declaration = '// @require https://assets.example.test/library.js\n';
  const asyncScope = context();
  vm.runInContext(compile('// @top-level-await\n' + declaration,
    'order.push("source");globalThis.orderResult=order.join(",");', [asset('var order=["dependency"];await Promise.resolve();order.push("awaited");')]), asyncScope);
  assert.equal(asyncScope.orderResult, undefined); await new Promise(setImmediate);
  assert.equal(asyncScope.orderResult, 'dependency,awaited,source');
  const rawScope = context();
  vm.runInContext(compile('// @unwrap\n' + declaration, 'var rawDependencyResult=dependencyLexical+1;', [asset('const dependencyLexical=41;')]), rawScope);
  assert.equal(rawScope.rawDependencyResult, 42); assert.equal(vm.runInContext('dependencyLexical', rawScope), 41);
});

test('unwrap preserves global var, functions, lexical declarations and sloppy mode without APIs', () => {
  const metadata = '// @unwrap\n// @inject-into page\n// @grant GM_cookie\n// @grant unsupportedIgnored\n';
  const scope = context();
  const code = compile(metadata, 'var exported=3;let lexical=4;const constant=5;function exportedFunction(){return lexical+constant;}with({value:6}){globalThis.sloppy=value;}');
  vm.runInContext(code, scope);
  assert.equal(scope.exported, 3); assert.equal(scope.exportedFunction(), 9); assert.equal(scope.sloppy, 6);
  assert.equal(vm.runInContext('lexical + constant', scope), 9);
  assert.equal(scope.GM, undefined); assert.equal(scope.GM_cookie, undefined);
  assert.ok(!code.includes('f'.repeat(64))); assert.deepEqual(core.parse(source(metadata)).grants, []);
  assert.deepEqual(BlockAdsLint.inspect(source(metadata, 'with({}){}')).diagnostics, []);
  assert.equal(BlockAdsLint.inspect(source(metadata, 'return;')).diagnostics[0].kind, 'syntax');
});

test('unwrap refuses timing and scopes that require a wrapper instead of widening execution', () => {
  for (const extra of ['// @top-level-await\n', '// @run-at document-body\n', '// @include *example*\n', '// @exclude *private*\n',
    '// @exclude-match https://example.test:443/private/*\n']) assert.throws(() => core.parse(source('// @unwrap\n' + extra)), /unwrap/);
  for (const pattern of ['https://example.tld/*', 'https://foo*.test/*', 'https://[::1]/*', 'https://example.test:443/*', 'https://example.test/*#safe']) {
    assert.throws(() => core.parse(source('// @unwrap\n').replace('https://example.test/*', pattern)), /unwrap/);
  }
  const metadata = core.parse(source('// @unwrap\n// @exclude-match https://example.test/private/*\n'));
  assert.equal(metadata.unwrap, true); assert.deepEqual(metadata.excludeMatches, ['https://example.test/private/*']);
});
