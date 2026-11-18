/* The shared JavaScript converter (src/blocking/community-lists.js) must give
   exactly what the PowerShell build committed from the bundled snapshots:
   rules/community.json byte for byte, the same site hiding data, the same
   generic stylesheets and the same counts. List updates in the extension rely
   on this, because they compare a converted download with the bundled rules. */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
require('../src/blocking/cosmetic.js');
require('../src/blocking/community-lists.js');
const { compile } = require('../scripts/compile-generic-css.cjs');
const { BlockAdsCommunityLists: lists, BlockAdsCosmetic: cosmetic } = globalThis;
const read = file => fs.readFileSync(path.join(root, file));
const json = file => JSON.parse(read(file).toString('utf8'));

const catalog = json('lists/community-lists.json');
const snapshots = catalog.lists.map(entry => {
  const bytes = read('lists/' + entry.file);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.id + ' snapshot matches its catalog hash');
  return { id: entry.id, title: entry.title, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
});
// The build protects the same domains: reviewed catalog entries that are not
// "unverified", plus hosts recorded on named sites. Both files ship packaged.
const protectedDomains = [...json('rules/reviewed-domains.json').domains.filter(item => item.category !== 'unverified').map(item => item.domain),
  ...json('rules/site-ad-hosts-info.json').map(item => item.domain)];
const converted = lists.convert(snapshots, { protectedDomains, compileSelector: cosmetic.compileSelector });

test('network rules match rules/community.json byte for byte', () => {
  const committed = read('rules/community.json').toString('utf8');
  const text = '[\n' + converted.rules.map(rule => JSON.stringify(rule)).join(',\n') + '\n]\n';
  if (text !== committed) {
    const ours = text.split('\n'), theirs = committed.split('\n');
    const line = ours.findIndex((value, index) => value !== theirs[index]);
    assert.fail(`First difference at line ${line + 1}:\n  converter: ${ours[line]?.slice(0, 400)}\n  committed: ${theirs[line]?.slice(0, 400)}`);
  }
  assert.equal(converted.rules.length, 9223);
});

test('site hiding data matches rules/community-cosmetic.json', () => {
  const committed = json('rules/community-cosmetic.json');
  for (const key of ['schemaVersion', 'hide', 'allow', 'generic', 'scoped', 'procedural', 'disableGeneric', 'disableAll']) {
    assert.deepEqual(converted.cosmetic[key], committed[key], key);
  }
});

test('the generic stylesheets compiled from converted data match the committed sheets', () => {
  const committed = json('rules/community-cosmetic.json');
  const exceptions = [...converted.cosmetic.scoped, ...converted.cosmetic.procedural].filter(rule => rule.exception)
    .map(rule => ({ include: rule.include, exclude: rule.exclude, selector: rule.selector }));
  const sheets = compile({ generic: converted.cosmetic.generic, allow: converted.cosmetic.allow, exceptions });
  assert.deepEqual(sheets.genericStatic, committed.genericStatic);
  assert.equal(sheets.stylesheets.base + '\n', read('rules/community-generic.css').toString('utf8'));
  assert.equal(sheets.stylesheets.excepted + '\n', read('rules/community-generic-excepted.css').toString('utf8'));
});

test('counts, skipped filters and list headers match rules/community-info.json', () => {
  const info = json('rules/community-info.json');
  for (const key of ['networkRules', 'groupedDomains', 'cosmeticSites', 'cosmeticSelectors', 'exceptionsLimitedForBlockAdsRules',
    'genericCosmeticSelectors', 'scopedCosmeticRules', 'proceduralCosmeticRules', 'cosmeticSiteExceptions', 'skipped']) {
    assert.deepEqual(converted.info[key], info[key], key);
  }
  assert.deepEqual(converted.info.lists.map(({ id, title, version, lastModified }) => ({ id, title, version, lastModified })),
    info.lists.map(({ id, title, version, lastModified }) => ({ id, title, version, lastModified })));
});

test('groups hold every merged domain once, in the rules they produce', () => {
  const grouped = converted.rules.filter(rule => rule.condition.requestDomains);
  assert.equal(converted.groups.reduce((sum, group) => sum + group.hosts.length, 0), grouped.reduce((sum, rule) => sum + rule.condition.requestDomains.length, 0));
  for (const group of converted.groups) assert.deepEqual(group.hosts, [...new Set(group.hosts)].sort());
});
