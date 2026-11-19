/* Upstream filter-list texts for tests, made from the bundled snapshots: the
   same lists with a later version and a few real changes. Nothing is fetched. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'lists/community-lists.json'), 'utf8'));
const bundledRules = JSON.parse(fs.readFileSync(path.join(root, 'rules/community.json'), 'utf8'));
const snapshot = id => fs.readFileSync(path.join(root, 'lists', catalog.lists.find(list => list.id === id).file), 'utf8');

// A line only EasyList has, so removing it there removes its rule. The other
// lists, uBlock filters among them, may carry the same filter.
const lines = id => new Set(snapshot(id).split('\n').map(line => line.trim()));
const easylist = lines('easylist'), others = catalog.lists.filter(list => list.id !== 'easylist').map(list => lines(list.id));
const onlyInEasyList = line => easylist.has(line) && !others.some(set => set.has(line));
// The first such plain block pattern in the bundled rules, and the first such
// domain in the first domain chunk.
const removedSingle = bundledRules.find(rule => !rule.condition.requestDomains && Object.keys(rule.condition).join() === 'urlFilter' &&
  rule.action.type === 'block' && rule.priority === 1 && onlyInEasyList(rule.condition.urlFilter));
const REMOVED_HOST = bundledRules[0].condition.requestDomains.find(host => onlyInEasyList(`||${host}^`));
const ADDED_HOST = 'fresh-ad-server.example';
// Not /.../, which EasyList syntax reads as a regular expression.
const ADDED_PATTERN = '/fresh-ad-banner.';
const ADDED_SITE_RULE = 'example.com##.fresh-ad-slot';
// A scriptlet filter, which list updates carry with site hiding.
const ADDED_SCRIPTLET_RULE = 'example.com##+js(set-constant, freshListFlag, true)';

// changes: { version, title, drop: true to drop most of the list, remove, add }
function upstream(id, { version, title, shrink = false, changes = true } = {}) {
  let text = snapshot(id);
  if (version) text = text.replace(/^! Version: .*$/m, `! Version: ${version}`);
  if (title) text = text.replace(/^! Title: .*$/m, `! Title: ${title}`);
  if (changes && id === 'easylist') {
    const lines = text.split('\n').filter(line => line.trim() !== removedSingle.condition.urlFilter && line.trim() !== `||${REMOVED_HOST}^`);
    lines.push(`||${ADDED_HOST}^`, ADDED_PATTERN, ADDED_SITE_RULE, ADDED_SCRIPTLET_RULE);
    text = lines.join('\n');
  }
  if (shrink) text = text.split('\n').slice(0, 2000).join('\n');
  return text;
}

module.exports = { catalog, bundledRules, snapshot, upstream, removedSingle, REMOVED_HOST, ADDED_HOST, ADDED_PATTERN, ADDED_SITE_RULE, ADDED_SCRIPTLET_RULE };
