/* Offline generator for the approved, pinned Public Suffix List. No downloads. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { domainToASCII } = require('node:url');
const directory = path.resolve(__dirname, '../vendor/publicsuffix');

function build() {
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'provenance.json'), 'utf8'));
  for (const name of ['public_suffix_list.dat', 'LICENSE']) {
    const bytes = fs.readFileSync(path.join(directory, name)), expected = provenance.files[name];
    if (bytes.length !== expected.bytes || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error('Pinned suffix file failed integrity verification: ' + name);
    }
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(directory, 'public_suffix_list.dat')));
  const rules = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('//')) continue;
    const prefix = line.startsWith('!') ? '!' : line.startsWith('*.') ? '*.' : '';
    const raw = line.slice(prefix.length), host = domainToASCII(raw);
    if (/[/\s:@\\?#%]/.test(raw) || !host || host.length > 253 || host.split('.').some(label =>
      label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
      throw new Error('Invalid suffix data line: ' + line);
    }
    rules.add(prefix + host);
  }
  if (rules.size < 1000 || rules.size > 30000) throw new Error('Unexpected suffix rule count.');
  return '/* Public Suffix List, MPL-2.0 (see LICENSE). Generated offline by scripts/build-userscript-suffixes.cjs. */\n' +
    'globalThis.ModuleEngineSuffixes = Object.freeze(' + JSON.stringify({ revision: provenance.revision, rules: [...rules].sort().join('\n') }) + ');\n';
}
if (require.main === module) {
  const output = build(), destination = path.join(directory, 'suffixes.js');
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(destination, 'utf8') !== output) throw new Error('Generated suffixes.js is stale.');
    console.log('Pinned suffix integrity and generated lookup verified.');
  } else {
    fs.writeFileSync(destination, output);
    console.log('Generated suffixes.js (' + Buffer.byteLength(output) + ' bytes).');
  }
}
module.exports = { build };
