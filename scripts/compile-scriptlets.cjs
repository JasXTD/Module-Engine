/* Offline compiler bridge: list scriptlet filters are checked by the same
   parser the extension uses for list updates and a person's own rules. */
'use strict';
const fs = require('node:fs');
require('../src/blocking/scriptlets.js');
require('../src/blocking/community-lists.js');
try {
  const chunks = [], buffer = Buffer.alloc(65536);
  let size = 0, read;
  while ((read = fs.readSync(0, buffer, 0, buffer.length, null))) {
    size += read;
    if (size > 8 * 1024 * 1024) throw new Error('Scriptlet input exceeds 8 MiB.');
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  const candidates = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  process.stdout.write(JSON.stringify(BlockAdsCommunityLists.compileScriptlets(candidates, BlockAdsScriptlets.parseBody)));
} catch (error) {
  process.stderr.write(`Scriptlet compilation failed: ${error.message}\n`);
  process.exitCode = 1;
}
