/* Offline compiler bridge: one parser for local list builds and the extension. */
'use strict';
const fs = require('node:fs');
require('../cosmetic.js');
try {
  const chunks = [], buffer = Buffer.alloc(65536);
  let size = 0, read;
  while ((read = fs.readSync(0, buffer, 0, buffer.length, null))) {
    size += read;
    if (size > 8 * 1024 * 1024) throw new Error('Procedural input exceeds 8 MiB.');
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  const input = Buffer.concat(chunks, size);
  const candidates = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input));
  if (!Array.isArray(candidates) || candidates.length > 5000) throw new Error('Invalid procedural candidate count.');
  const rules = [], skipped = {};
  for (const rule of candidates) {
    if (!rule || !Array.isArray(rule.include) || !Array.isArray(rule.exclude) || typeof rule.exception !== 'boolean') throw new Error('Invalid procedural candidate.');
    if (!rule.include.length && !rule.exception) {
      skipped['cosmetic: procedural rule needs positive site scope'] = (skipped['cosmetic: procedural rule needs positive site scope'] || 0) + 1;
      continue;
    }
    try { rules.push({ ...rule, procedure: BlockAdsCosmetic.compileSelector(rule.selector) }); }
    catch {
      skipped['cosmetic: unsupported procedural syntax'] = (skipped['cosmetic: unsupported procedural syntax'] || 0) + 1;
    }
  }
  process.stdout.write(JSON.stringify({ rules, skipped }));
} catch (error) {
  process.stderr.write(`Procedural compilation failed: ${error.message}\n`);
  process.exitCode = 1;
}
