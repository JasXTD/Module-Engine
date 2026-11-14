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

test('unwrap refuses wrapper-only timing and keeps native-exact scopes unguarded', () => {
  for (const extra of ['// @top-level-await\n', '// @run-at document-body\n']) assert.throws(() => core.parse(source('// @unwrap\n' + extra)), /unwrap/);
  const metadata = core.parse(source('// @unwrap\n// @exclude-match https://example.test/private/*\n'));
  assert.equal(metadata.unwrap, true); assert.deepEqual(metadata.excludeMatches, ['https://example.test/private/*']);
  const record = { id: '12345678-1234-1234-1234-123456789abc', token: 'f'.repeat(64), source: source('// @unwrap\n// @exclude-match https://example.test/private/*\n', 'var x=1;') };
  assert.equal(core.registration(record).js.length, 1, 'the native registration already enforces this scope');
  assert.ok(!metadata.warnings.some(warning => /checked before the raw script/.test(warning)));
});

test('unwrap guards extended scopes before any raw statement or declaration runs', () => {
  const body = 'globalThis.ran=(globalThis.ran||0)+1;var rawVar=1;let rawLexical=2;const rawConstant=3;function rawFunction(){return rawLexical+rawConstant;}';
  const cases = [
    ['// @include /^https:\\/\\/example\\.test\\/(?!private)/\n', 'include-only', 'https://example.test/page', 'https://example.test/private'],
    ['// @exclude *private*\n', '', 'https://example.test/page', 'https://example.test/private/x'],
    ['// @exclude-match https://example.test/*#private\n', '', 'https://example.test/page#public', 'https://example.test/page#private'],
    ['', 'https://example.tld/*', 'https://example.co.uk/page', 'https://example.invalid-suffix/page'],
    ['', 'https://foo*.example.test/*', 'https://food.example.test/page', 'https://bar.example.test/page'],
    ['', 'http://[::1]:8080/*', 'http://[::1]:8080/page', 'http://[::1]:8081/page']
  ];
  for (const [rules, pattern, yes, no] of cases) for (const world of ['', '// @inject-into page\n']) {
    let text = source('// @unwrap\n' + world + rules, body);
    if (pattern === 'include-only') text = text.replace('// @match https://example.test/*\n', '');
    else if (pattern) text = text.replace('https://example.test/*', pattern);
    assert.ok(core.parse(text).warnings.some(warning => /checked before the raw script/.test(warning)), rules + pattern);
    const record = { id: '12345678-1234-1234-1234-123456789abc', token: 'f'.repeat(64), source: text };
    const registrations = core.registrations(record), sources = registrations.flatMap(item => item.js);
    if (world) {
      // A page listener registered before document-end must not see the skipped error.
      assert.deepEqual(registrations.map(item => [item.runAt, item.world, item.js.length]), [['document_start', 'MAIN', 1], ['document_end', 'MAIN', 1]]);
    } else assert.deepEqual(registrations.map(item => [item.world, item.js.length]), [['USER_SCRIPT', 2]], 'guard, then raw source in one isolated injection');
    assert.ok(!sources.some(item => item.code.includes('f'.repeat(64))), 'raw registrations never contain the capability token');
    assert.ok(!sources[0].code.includes('12345678') && !/__moduleEngineScope_12345678/.test(sources.at(-1).code), 'the guard and its sentinel do not carry the install ID');
    const run = href => {
      const scope = context({ location: { href } }), errors = [];
      for (const item of sources) { try { vm.runInContext(item.code, scope); } catch (error) { errors.push(error); } }
      return { scope, errors };
    };
    const inside = run(yes);
    assert.deepEqual(inside.errors, [], yes); assert.equal(inside.scope.ran, 1);
    assert.equal(inside.scope.rawVar, 1); assert.equal(inside.scope.rawFunction(), 5);
    assert.equal(vm.runInContext('rawLexical + rawConstant', inside.scope), 5, 'top-level lexical declarations stay global');
    const outside = run(no);
    assert.equal(outside.errors.length, 1, no); assert.equal(outside.errors[0].name, 'SyntaxError');
    assert.equal(outside.scope.ran, undefined, 'no statement ran');
    for (const name of ['rawVar', 'rawFunction']) assert.equal(Object.hasOwn(outside.scope, name), false, name + ' was not hoisted');
    assert.throws(() => vm.runInContext('rawLexical', outside.scope), /not defined/, 'no lexical binding was created');
  }
});

test('the unwrap guard hides only its own redeclaration error', () => {
  for (const world of ['', '// @inject-into page\n']) {
    const text = source('// @unwrap\n' + world + '// @exclude *private*\n', 'globalThis.ran=true;');
    const [guard] = core.registrations({ id: '12345678-1234-1234-1234-123456789abc', token: 'f'.repeat(64), source: text })[0].js;
    const name = /const name="(__moduleEngineScope_[0-9a-f]{16})"/.exec(guard.code)[1];
    const listeners = [], timers = [];
    const scope = context({ location: { href: 'https://example.test/private' }, addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
      removeEventListener: (type, listener) => { const index = listeners.findIndex(item => item.listener === listener); if (index >= 0) listeners.splice(index, 1); },
      setTimeout: callback => timers.push(callback) });
    vm.runInContext(guard.code, scope);
    assert.equal(listeners.length, 1); assert.equal(listeners[0].type, 'error'); assert.equal(listeners[0].capture, true);
    assert.equal(timers.length, world ? 0 : 1, 'only a same-injection guard schedules removal');
    const event = message => { const result = { message, prevented: 0, stopped: 0, preventDefault() { this.prevented++; }, stopImmediatePropagation() { this.stopped++; } }; listeners[0]?.listener(result); return result; };
    const other = event('Uncaught TypeError: page failure');
    assert.equal(other.prevented, 0); assert.equal(other.stopped, 0);
    const own = event("Uncaught SyntaxError: Identifier '" + name + "' has already been declared");
    assert.equal(own.prevented, 1); assert.equal(own.stopped, 1);
    assert.equal(listeners.length, 0, 'the listener removes itself after hiding the error');
    assert.equal(Object.getOwnPropertyDescriptor(scope, name)?.configurable, false);
    assert.equal(Object.keys(scope).includes(name), false, 'the sentinel is not enumerable');
  }
  const names = ['A', 'B'].map(name => /__moduleEngineScope_[0-9a-f]{16}/.exec(core.registrations({ id: '12345678-1234-1234-1234-123456789abc', token: 'f'.repeat(64),
    source: source('// @unwrap\n// @exclude *private*\n', '/* ' + name + ' */') })[0].js[0].code)[0]);
  assert.notEqual(names[0], names[1], 'different sources use different sentinels');
});
