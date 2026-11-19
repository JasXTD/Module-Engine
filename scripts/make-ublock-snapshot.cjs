/* Makes the bundled uBlock filters snapshot from a local copy of the filters
   folder of uBlockOrigin/uAssets at one commit. Offline: nothing is fetched,
   and list lines are data that are copied, never run.

   uBlock filters is filters.txt plus the files its `!#include` lines name.
   uBlock Origin fetches those itself; Module Engine's converter reads one text
   per list, so each included file is copied in after its `!#include` line,
   between `! >>>>>>>> name` and `! <<<<<<<< name` comments. The publisher
   replaces `%timestamp%` in `! Last modified:` when it publishes; this uses the
   commit's time instead. Nothing else changes.

   node scripts/make-ublock-snapshot.cjs <filters folder> <commit> <commit time, UTC ISO> <output file> */
'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');

const [folder, commit, committed, output] = process.argv.slice(2);
const MAX_BYTES = 8 * 1024 * 1024;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fail(message) { throw new Error(message); }

// One list file as strict UTF-8 lines.
function readList(name) {
  const file = path.join(folder, name);
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) fail(`${name} is larger than 8 MiB.`);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { fail(`${name} is not valid UTF-8.`); }
  if (text.startsWith('﻿')) fail(`${name} starts with a byte-order mark.`);
  return text.replace(/\n$/, '').split(/\r?\n/);
}

try {
  if (!folder || !output || !/^[0-9a-f]{40}$/.test(commit || '') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(committed || '')) {
    fail('Usage: node scripts/make-ublock-snapshot.cjs <filters folder> <40-hex commit> <commit time like 2026-11-19T02:49:22Z> <output file>');
  }
  const time = new Date(committed);
  if (!Number.isFinite(time.getTime()) || time.getTime() > Date.now() + 5 * 60000) fail('The commit time is invalid or in the future.');
  const stamp = `${String(time.getUTCDate()).padStart(2, '0')} ${MONTHS[time.getUTCMonth()]} ${time.getUTCFullYear()} ` +
    `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')} UTC`;
  const stamped = line => /^! Last modified: %timestamp%$/.test(line) ? `! Last modified: ${stamp}` : line;
  const main = readList('filters.txt');
  if (main[0] !== '! Title: uBlock filters') fail('filters.txt is not uBlock filters.');
  const out = [], included = [];
  for (const line of main) {
    const include = /^!#include\s+(\S+)\s*$/.exec(line.trim());
    if (!include) { out.push(stamped(line)); continue; }
    // Plain file names next to filters.txt only, each once.
    const name = include[1];
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.txt$/.test(name) || included.includes(name)) fail(`Unsupported include: ${name}`);
    const lines = readList(name);
    if (lines.some(item => /^!#include\b/.test(item.trim()))) fail(`${name} includes further files.`);
    included.push(name);
    out.push(line, `! >>>>>>>> ${name}`, ...lines.map(stamped), `! <<<<<<<< ${name}`);
  }
  const bytes = Buffer.from(out.join('\n') + '\n', 'utf8');
  if (bytes.length > MAX_BYTES) fail('The snapshot is larger than 8 MiB.');
  fs.writeFileSync(output, bytes);
  process.stdout.write(JSON.stringify({ commit, lastModified: stamp, included, lines: out.length, bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(`Snapshot failed: ${error.message}\n`);
  process.exitCode = 1;
}
