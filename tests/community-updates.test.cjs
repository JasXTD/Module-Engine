/* Filter-list updates: list checks, version order, download limits and the
   change from the bundled rules. The change must make the bundled rules behave
   exactly as the converted new lists, rule by rule and domain by domain. */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
require('../src/blocking/cosmetic.js');
require('../src/blocking/community-lists.js');
require('../src/background/community-updates.js');
const { ModuleEngineCommunityUpdates: updates, BlockAdsCommunityLists: lists, BlockAdsCosmetic: cosmetic } = globalThis;
const fixture = require('./community-update-fixture.cjs');
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const protectedDomains = [...json('rules/reviewed-domains.json').domains.filter(item => item.category !== 'unverified').map(item => item.domain),
  ...json('rules/site-ad-hosts-info.json').map(item => item.domain)];
const convert = texts => lists.convert(fixture.catalog.lists.map(list => ({ id: list.id, title: list.title, text: texts[list.id] })),
  { protectedDomains, compileSelector: cosmetic.compileSelector });

// What a set of rules does: one fact per merged domain, one per other rule.
function facts(rules) {
  const result = new Set();
  const key = value => JSON.stringify(value, Object.keys(value).sort());
  for (const rule of rules) {
    const { requestDomains, ...condition } = rule.condition;
    const meaning = JSON.stringify([rule.priority, rule.action.type, Object.keys(condition).sort().map(name => [name, condition[name]])]);
    if (requestDomains) for (const host of requestDomains) result.add(meaning + '|' + host);
    else result.add(meaning);
  }
  void key;
  return result;
}
const applied = (bundled, change) => [...bundled.filter(rule => !change.disable.includes(rule.id)), ...change.add];

test('unchanged lists need no change, and real edits change only what they touch', () => {
  const same = convert({ easylist: fixture.upstream('easylist', { changes: false }), 'easylist-china': fixture.upstream('easylist-china') });
  assert.deepEqual(updates.difference(fixture.bundledRules, same.rules), { disable: [], add: [] });
  const edited = convert({ easylist: fixture.upstream('easylist'), 'easylist-china': fixture.upstream('easylist-china') });
  const change = updates.difference(fixture.bundledRules, edited.rules);
  assert.deepEqual(change.disable, [1, fixture.removedSingle.id], 'the chunk that lost a domain and the dropped pattern');
  assert.equal(change.add.length, 3, 'the chunk without its dropped domain, the new domain, the new pattern');
  assert.deepEqual(change.add.map(rule => rule.id), [1000001, 1000002, 1000003]);
  assert.equal(change.add[0].condition.requestDomains.length, 999);
  assert.ok(!change.add[0].condition.requestDomains.includes(fixture.REMOVED_HOST));
  assert.deepEqual(change.add[1].condition.requestDomains, [fixture.ADDED_HOST]);
  assert.equal(change.add[2].condition.urlFilter, fixture.ADDED_PATTERN);
  assert.deepEqual(facts(applied(fixture.bundledRules, change)), facts(edited.rules), 'bundled rules plus the change behave as the new lists');
  assert.deepEqual(edited.cosmetic.hide['example.com'], ['.fresh-ad-slot']);
});

test('the change stays exact for added, emptied and new domain groups', () => {
  const rule = (id, priority, action, condition) => ({ id, priority, action: { type: action }, condition });
  const bundled = [rule(1, 1, 'block', { requestDomains: ['a.test', 'b.test'] }), rule(2, 1, 'block', { requestDomains: ['c.test'] }),
    rule(3, 2, 'allow', { requestDomains: ['x.test'], domainType: 'thirdParty' }), rule(4, 1, 'block', { urlFilter: '/ad/' })];
  const converted = [rule(1, 1, 'block', { requestDomains: ['a.test', 'b.test', 'c.test', 'd.test'] }),
    rule(2, 3, 'block', { requestDomains: ['z.test'], domainType: 'thirdParty' }), rule(3, 1, 'block', { urlFilter: '/ad/' })];
  const change = updates.difference(bundled, converted, { chunk: 2 });
  assert.deepEqual(change.disable, [3], 'only the group that vanished');
  assert.deepEqual(change.add.map(item => item.condition.requestDomains), [['d.test'], ['z.test']]);
  assert.deepEqual(facts(applied(bundled, change)), facts(converted));
});

test('a downloaded list must be the expected, numbered Adblock Plus list', () => {
  const text = fixture.upstream('easylist', { version: '202611171200' });
  assert.deepEqual(updates.checkList(text, { title: 'EasyList' }), { title: 'EasyList', version: '202611171200', expires: '4 days (update frequency)' });
  assert.throws(() => updates.checkList('<html>login</html>', { title: 'EasyList' }), /did not download as a filter list/);
  assert.throws(() => updates.checkList(fixture.upstream('easylist', { title: 'Other list' }), { title: 'EasyList' }), /titled "Other list"/);
  assert.throws(() => updates.checkList(text.replace(/^! Version: .*$/m, '! Version: latest'), { title: 'EasyList' }), /no version/);
});

test('a set is newer only when no list is older and one list changed', () => {
  const inUse = [{ id: 'easylist', version: '202610191756' }, { id: 'easylist-china', version: '202610191803' }];
  const set = (a, b) => [{ id: 'easylist', title: 'EasyList', version: a }, { id: 'easylist-china', title: 'EasyList China', version: b }];
  assert.equal(updates.compareVersions(inUse, set('202610191756', '202610191803')), false);
  assert.equal(updates.compareVersions(inUse, set('202611171200', '202610191803')), true);
  assert.throws(() => updates.compareVersions(inUse, set('202611171200', '202610010000')), /EasyList China \(202610010000\) is older/);
});

test('lists ask for their check interval, kept between one and fourteen days', () => {
  const day = 86400000;
  assert.equal(updates.checkInterval('4 days (update frequency)'), 4 * day);
  assert.equal(updates.checkInterval('1 hours'), day);
  assert.equal(updates.checkInterval('30 days'), 14 * day);
  assert.equal(updates.checkInterval(undefined), 4 * day);
});

test('a conversion that lost most of the bundled rules is refused', () => {
  const bundledInfo = json('rules/community-info.json');
  const shrunk = convert({ easylist: fixture.upstream('easylist', { shrink: true }), 'easylist-china': fixture.upstream('easylist-china', { shrink: true }) });
  assert.throws(() => updates.checkSize(shrunk.info, bundledInfo), /under half of the bundled/);
  updates.checkSize(convert({ easylist: fixture.upstream('easylist'), 'easylist-china': fixture.upstream('easylist-china') }).info, bundledInfo);
});

test('downloads carry no cookies or referrer, stay within limits and follow only HTTPS redirects', async () => {
  const seen = [];
  const reply = (body, extra = {}) => ({ ok: true, status: 200, redirected: false, url: 'https://lists.example/easylist.txt',
    headers: { get: name => name === 'content-length' && extra.length !== undefined ? String(extra.length) : null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer, ...extra });
  const { text } = await updates.download('https://lists.example/easylist.txt', async (url, options) => { seen.push({ url, options }); return reply('[Adblock Plus 2.0]\n'); });
  assert.equal(text, '[Adblock Plus 2.0]\n');
  assert.deepEqual([seen[0].options.credentials, seen[0].options.referrerPolicy, seen[0].options.cache, seen[0].options.redirect], ['omit', 'no-referrer', 'no-store', 'follow']);
  await assert.rejects(updates.download('https://lists.example/a.txt', async () => reply('x', { length: updates.MAX_BYTES + 1 })), /larger than 8 MiB/);
  await assert.rejects(updates.download('https://lists.example/a.txt', async () => reply('x', { ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(updates.download('https://lists.example/a.txt', async () => reply('x', { redirected: true, url: 'http://lists.example/a.txt' })), /without HTTPS/);
  await assert.rejects(updates.download('https://lists.example/a.txt', async () => ({ ...reply(''), arrayBuffer: async () => new Uint8Array([0xff, 0xfe]).buffer })), /not valid UTF-8/);
  for (const bad of ['http://lists.example/a.txt', 'https://user:pw@lists.example/a.txt', 'https://lists.example/a.txt#x', 'lists.example']) {
    assert.throws(() => updates.sourceUrl(bad), /https|address|URL/, bad);
  }
  assert.equal(updates.sourceUrl('http://127.0.0.1:9000/easylist.txt'), 'http://127.0.0.1:9000/easylist.txt');
});
