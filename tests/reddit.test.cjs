const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
require('../reddit.js');
const { isReddit, create } = globalThis.BlockAdsReddit;

test('Reddit repair accepts only Reddit itself and its subdomains', () => {
  for (const host of ['reddit.com', 'www.reddit.com', 'OLD.REDDIT.COM', 'www.reddit.com.']) assert.equal(isReddit(host), true, host);
  for (const host of ['notreddit.com', 'reddit.com.example', '127.0.0.1', 'reddit.co', '', null]) assert.equal(isReddit(host), false, String(host));
});

test('other sites allocate no DOM observer and their repair controls are harmless', () => {
  const document = new Proxy({}, { get() { throw new Error('Other-site DOM must not be inspected'); } });
  const shield = create({ document, hostname: 'reddit.com.example' });
  shield.setEnabled(true); shield.setEnabled(false); shield.clear();
});

test('packaged content scripts include the Reddit repair before the content entry point', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts.find(item => item.js.includes('content.js'));
  assert.equal(scripts.run_at, 'document_start');
  assert.ok(scripts.js.indexOf('reddit.js') >= 0 && scripts.js.indexOf('reddit.js') < scripts.js.indexOf('content.js'));
});
