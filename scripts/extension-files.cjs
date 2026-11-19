/* Shared runtime inventory for native browser test packages. */
'use strict';
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
// LICENSE travels with every package, as the MIT licence requires. Filter lists
// that change only with releases ship as text, because list updates convert them
// again beside the downloaded lists (src/background/background.js).
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'lists/community-lists.json'), 'utf8'));
const releaseLists = catalog.lists.filter(list => list.updates === 'release').map(list => 'lists/' + list.file);
const entries = ['manifest.json', 'LICENSE', 'src', 'icons', 'rules', 'vendor/acorn/acorn.js', 'vendor/acorn/LICENSE',
  'vendor/publicsuffix/LICENSE', 'vendor/publicsuffix/provenance.json', 'vendor/publicsuffix/suffixes.js', 'docs/MCP.md', ...releaseLists];
function collect(relative) {
  const absolute = path.join(root, relative), stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error('Extension packages cannot follow links: ' + relative);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) throw new Error('Unexpected extension package entry: ' + relative);
  return fs.readdirSync(absolute).filter(name => !name.startsWith('.') &&
    (relative !== 'rules' || name.endsWith('.json') || name.endsWith('.css'))).sort().flatMap(name => collect(relative + '/' + name));
}
const files = Object.freeze(entries.flatMap(collect));
module.exports = { files };
