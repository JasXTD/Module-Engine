const { test } = require('node:test'), assert = require('node:assert/strict');
require('../vendor/publicsuffix/suffixes.js');
require('../src/userscripts/userscripts-matching.js');
require('../src/userscripts/userscripts-page.js');
require('../src/userscripts/userscripts-core.js');
require('../src/shared/appearance-settings.js');
require('../src/shared/backup.js');
const backup = ModuleEngineBackup, core = BlockAdsUserScriptCore;
const source = '// ==UserScript==\n// @name Example\n// @namespace backup-test\n// @match https://example.test/*\n// ==/UserScript==\nthrow new Error("never run on import");';
const fixture = () => ({ format: backup.FORMAT, version: 1, createdAt: '2026-11-20T01:02:03.000Z', extensionVersion: '1.9.0', data: {
  settings: { rulesets: { ads_ruleset: true, trackers_ruleset: false, threats_ruleset: false, community_ruleset: true } },
  appearance: { ...ModuleEngineAppearance.DEFAULT, websiteExceptions: [] }, updates: { interceptLinks: true, autoCheck: false, autoApply: false },
  userscripts: { enabled: true, scripts: [{ source, values: { greeting: '你好', nested: [true, null, { number: 42 }] },
    assets: null, tags: ['local'], sourceURL: null, enabled: true }] }
} });
const options = { settingKeys: ['rulesets'], validateSettings: value => value };
const parse = file => backup.parse(typeof file === 'string' ? file : JSON.stringify(file), options);

test('portable backups round-trip values, source, tags and saved intent without execution credentials', async () => {
  const data = fixture().data, text = backup.serialize(data, '1.9.0');
  assert.deepEqual(parse(text).data, data);
  const restored = backup.restoredLibrary(data.userscripts, 17), again = backup.restoredLibrary(data.userscripts, 18);
  assert.equal(restored.revision, 17); assert.equal(restored.enabled, false);
  assert.equal(restored.scripts[0].enabled, false); assert.equal(restored.scripts[0].autoPageApproved, false);
  assert.equal(restored.scripts[0].source, source);
  assert.deepEqual(restored.scripts[0].values, data.userscripts.scripts[0].values);
  assert.notEqual(restored.scripts[0].id, again.scripts[0].id);
  assert.notEqual(restored.scripts[0].token, again.scripts[0].token);
  const portable = backup.portableLibrary(restored);
  for (const key of ['id', 'token', 'revision', 'autoPageApproved', 'reviewedRequires']) assert.ok(!Object.hasOwn(portable.scripts[0], key));
  assert.equal(await backup.digest({ a: 1, b: { c: 3, a: 2 } }), await backup.digest({ b: { a: 2, c: 3 }, a: 1 }));
});

test('malformed, oversized, unsupported and unknown backup fields are rejected', () => {
  assert.throws(() => parse('not JSON'), /not valid JSON/);
  assert.throws(() => parse(' '.repeat(backup.MAX_BYTES + 1)), /8 MiB/);
  const changes = [file => { file.version = 2; }, file => { file.format = 'other'; }, file => { file.createdAt = 'invalid'; },
    file => { file.data.protectionError = 'injected'; }, file => { file.data.settings.rulesets.foreign = true; },
    file => { file.data.appearance.websites = 'true'; }, file => { file.data.appearance.websiteExceptions = ['not a host']; },
    file => { file.data.updates.autoApply = 1; }, file => { delete file.data.userscripts; },
    file => { file.data.userscripts.scripts[0].token = 'a'.repeat(64); }, file => { file.data.userscripts.scripts[0].enabled = 'yes'; },
    file => { file.data.userscripts.scripts[0].source = 'window.bad=true'; },
    file => { file.data.userscripts.scripts[0].values = { big: 'x'.repeat(core.LIMITS.values) }; },
    file => { file.data.userscripts.scripts.push({ ...file.data.userscripts.scripts[0] }); },
    file => { file.data.userscripts.scripts[0].sourceURL = 'https://user:password@example.test/script.user.js'; }];
  for (const change of changes) { const file = fixture(); change(file); assert.throws(() => parse(file)); }
  assert.deepEqual(parse('\uFEFF' + JSON.stringify(fixture())).data, fixture().data);
});

test('JSON object keys stay data, never object prototypes', () => {
  const file = fixture();
  file.data.userscripts.scripts[0].values = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}');
  const values = parse(file).data.userscripts.scripts[0].values;
  assert.equal({}.polluted, undefined); assert.ok(Object.hasOwn(values, '__proto__'));
  assert.equal(values.constructor, 'value');
  assert.throws(() => parse(JSON.stringify(fixture()).replace('"data":', '"__proto__":{},"data":')), /header/);
});

test('a valid library of deeply nested GM values fits the portable file budget', () => {
  const file = fixture(); let nested = 'item';
  for (let depth = 0; depth < 17; depth++) nested = [nested];
  file.data.userscripts.scripts = Array.from({ length: core.LIMITS.scripts }, (_, index) => ({ ...file.data.userscripts.scripts[0],
    source: source.replace('@name Example', '@name Example ' + index), values: { rows: Array.from({ length: 500 }, () => nested) } }));
  assert.doesNotThrow(() => backup.restoredLibrary(file.data.userscripts));
  assert.ok(core.bytes(JSON.stringify(file, null, 2)) > backup.MAX_BYTES, 'indentation alone would exceed the file budget');
  const text = backup.serialize(file.data, '1.9.0');
  assert.ok(core.bytes(text) < backup.MAX_BYTES);
  const restored = parse(text).data.userscripts;
  assert.equal(restored.scripts.length, core.LIMITS.scripts);
  assert.deepEqual(restored.scripts[31].values.rows[499], nested);
});
