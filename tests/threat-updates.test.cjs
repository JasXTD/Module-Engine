/* Signed reported-threat updates: signature, evidence binding, replay and
   expiry refusal, address rules, bounded downloads, the release config and the
   signing script. Uses throwaway keys generated per run, never the project's
   signing key, and runs the script only on a temporary copy. */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const NOW = Date.parse('2026-11-18T00:00:00Z');

function load(configText) {
  // Share this realm's Uint8Array, as tests/evidence.test.cjs does: in the
  // extension everything runs in one realm, and evidence.js checks instanceof.
  const context = { crypto: globalThis.crypto, Uint8Array, TextDecoder, TextEncoder, URL, AbortController, setTimeout, clearTimeout, atob, console };
  context.globalThis = context;
  vm.createContext(context);
  if (configText) vm.runInContext(configText, context, { filename: 'update-config.js' });
  for (const file of ['src/blocking/evidence.js', 'src/background/threat-updates.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context;
}
const updates = load().ModuleEngineThreatUpdates;
const read = name => new Uint8Array(fs.readFileSync(path.join(root, 'rules', name)));
function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: { kid: 'test', kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}
const sign = (bytes, privateKey) => crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
function signedFiles(privateKey) {
  const files = { rules: read('threats.json'), policy: read('threat-policy.json'), evidence: read('threat-evidence.json') };
  return { ...files, signature: sign(files.evidence, privateKey) };
}
const flip = (bytes, at) => { const copy = Uint8Array.from(bytes); copy[at] ^= 0x01; return copy; };

test('a list signed by a trusted key and reviewed later than the one in use is accepted', async () => {
  const { privateKey, jwk } = keyPair();
  const result = await updates.check(signedFiles(privateKey), { keys: [jwk], now: NOW, currentReviewedAt: '2026-09-01T00:00:00Z' });
  assert.equal(result.newer, true);
  assert.equal(result.rules.length, result.catalog.domains.length);
  const dynamic = updates.dynamicRules(result.rules);
  assert.equal(dynamic[0].id, updates.RULE_ID_BASE + 1, 'installed rules use their own ID range');
  assert.deepEqual(dynamic[0].condition, result.rules[0].condition);
});

test('a list from the same or an earlier review is not installed again', async () => {
  const { privateKey, jwk } = keyPair();
  const files = signedFiles(privateKey);
  for (const current of ['2026-10-18T00:00:00Z', '2026-11-01T00:00:00Z']) {
    const result = await updates.check(files, { keys: [jwk], now: NOW, currentReviewedAt: current });
    assert.equal(result.newer, false, 'replaying an older signed list changes nothing: ' + current);
    assert.equal(result.rules, undefined);
  }
});

test('unsigned, wrongly signed and tampered lists are refused', async () => {
  const trusted = keyPair(), other = keyPair();
  const good = signedFiles(trusted.privateKey);
  const options = { keys: [trusted.jwk], now: NOW };
  await assert.rejects(updates.check(signedFiles(other.privateKey), options), /not signed by a key/, 'another key');
  await assert.rejects(updates.check(good, { ...options, keys: [] }), /not signed by a key/, 'no trusted keys');
  await assert.rejects(updates.check({ ...good, evidence: flip(good.evidence, 40) }, options), /not signed by a key/, 'changed evidence');
  await assert.rejects(updates.check({ ...good, rules: flip(good.rules, 30) }, options), /does not match/, 'changed rules');
  await assert.rejects(updates.check({ ...good, policy: flip(good.policy, 30) }, options), /does not match|Unexpected|JSON/, 'changed policy');
  await assert.rejects(updates.check({ ...good, signature: 'not base64!' }, options), /base64/);
  await assert.rejects(updates.check({ ...good, signature: Buffer.alloc(32).toString('base64') }, options), /wrong length/);
});

test('expired and future-dated lists are refused', async () => {
  const { privateKey, jwk } = keyPair();
  const files = signedFiles(privateKey);
  await assert.rejects(updates.check(files, { keys: [jwk], now: Date.parse('2027-02-28T00:00:00Z') }), /already expired/);
  await assert.rejects(updates.check(files, { keys: [jwk], now: Date.parse('2026-10-17T00:00:00Z') }), /future/);
});

test('update addresses must be https, or http on this computer only', () => {
  assert.equal(updates.sourceUrl('https://raw.githubusercontent.com/owner/Module-Engine/main/updates/threats'),
    'https://raw.githubusercontent.com/owner/Module-Engine/main/updates/threats/', 'a trailing slash is added');
  assert.equal(updates.sourceUrl('http://127.0.0.1:8080/updates/'), 'http://127.0.0.1:8080/updates/');
  for (const bad of ['http://example.com/updates/', 'ftp://example.com/', 'https://user:pass@example.com/', 'https://example.com/?a=1', 'https://example.com/#x', 'updates/threats', '']) {
    assert.throws(() => updates.sourceUrl(bad), /https|address/, bad);
  }
});

test('downloads carry no cookies, referrer or redirects, and stop at the size limit', async () => {
  const seen = [];
  const reply = (body, { status = 200, length } = {}) => ({ ok: status >= 200 && status < 300, status,
    headers: { get: name => name === 'content-length' && length !== undefined ? String(length) : null },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer });
  const fetcher = async (url, options) => { seen.push({ url, options }); return reply('{"ok":true}'); };
  const bytes = await updates.download('https://example.com/u/', 'threats.json', 100, fetcher);
  assert.equal(new TextDecoder().decode(bytes), '{"ok":true}');
  assert.equal(seen[0].url, 'https://example.com/u/threats.json');
  assert.equal(seen[0].options.credentials, 'omit');
  assert.equal(seen[0].options.redirect, 'error');
  assert.equal(seen[0].options.referrerPolicy, 'no-referrer');
  assert.equal(seen[0].options.cache, 'no-store');
  await assert.rejects(updates.download('https://example.com/u/', 'a.json', 5, async () => reply('{"long":true}')), /larger than 5 bytes/, 'measured body');
  await assert.rejects(updates.download('https://example.com/u/', 'a.json', 5, async () => reply('{}', { length: 999 })), /larger than 5 bytes/, 'declared length');
  await assert.rejects(updates.download('https://example.com/u/', 'a.json', 5, async () => reply('', { status: 404 })), /HTTP 404/);
});

test('fetchUpdate reads the signature first and all four files from one folder', async () => {
  const { privateKey } = keyPair();
  const files = signedFiles(privateKey), order = [];
  const bodies = { 'threat-evidence.sig': new TextEncoder().encode(files.signature), 'threats.json': files.rules, 'threat-policy.json': files.policy, 'threat-evidence.json': files.evidence };
  const fetcher = async url => { const name = url.split('/').pop(); order.push(name);
    return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => bodies[name].buffer.slice(bodies[name].byteOffset, bodies[name].byteOffset + bodies[name].byteLength) }; };
  const fetched = await updates.fetchUpdate('https://example.com/updates/threats', fetcher);
  assert.equal(order[0], 'threat-evidence.sig');
  assert.deepEqual([...order].sort(), ['threat-evidence.json', 'threat-evidence.sig', 'threat-policy.json', 'threats.json']);
  assert.deepEqual(fetched.rules, files.rules);
  const roundTrip = updates.restore(updates.store(fetched));
  assert.deepEqual(roundTrip.evidence, files.evidence, 'stored text gives back the verified bytes');
  assert.equal(roundTrip.signature, files.signature);
});

test('verify checks the signature and evidence but leaves dates to the caller', async () => {
  const { privateKey, jwk } = keyPair();
  const files = signedFiles(privateKey);
  const later = Date.parse('2027-06-01T00:00:00Z');
  await assert.rejects(updates.check(files, { keys: [jwk], now: later }), /already expired/);
  const verified = await updates.verify(files, [jwk]);
  assert.equal(verified.policy.expiresAt, '2027-02-28T00:00:00Z', 'an expired installed list still verifies, so it can be shown as expired');
  assert.equal(verified.rules.length, verified.catalog.domains.length);
  await assert.rejects(updates.verify({ ...files, rules: flip(files.rules, 30) }, [jwk]), /does not match/);
});

test('without explicit keys, only the keys in the release config are trusted', async () => {
  const { privateKey, jwk } = keyPair();
  const trusting = load(`globalThis.ModuleEngineUpdateConfig = Object.freeze({ threatSource: '', keys: Object.freeze([${JSON.stringify(jwk)}]) });`);
  assert.equal((await trusting.ModuleEngineThreatUpdates.check(signedFiles(privateKey), { now: NOW })).newer, true);
  const shipped = load(fs.readFileSync(path.join(root, 'src/shared/update-config.js'), 'utf8'));
  await assert.rejects(shipped.ModuleEngineThreatUpdates.check(signedFiles(privateKey), { now: NOW }), /not signed by a key/, 'the shipped config does not trust a throwaway key');
  await assert.rejects(load().ModuleEngineThreatUpdates.check(signedFiles(privateKey), { now: NOW }), /not signed by a key/, 'no config means no trusted keys');
});

test('the shipped release config is frozen, valid and names keys whenever it names a source', async () => {
  const context = load(fs.readFileSync(path.join(root, 'src/shared/update-config.js'), 'utf8'));
  const { threatSource, keys } = context.ModuleEngineUpdateConfig;
  assert.ok(Object.isFrozen(context.ModuleEngineUpdateConfig) && Object.isFrozen(keys) && keys.every(Object.isFrozen));
  assert.equal(typeof threatSource, 'string');
  if (threatSource) assert.equal(context.ModuleEngineThreatUpdates.sourceUrl(threatSource), threatSource, 'the source is already in its checked form');
  assert.ok(!threatSource || keys.length > 0, 'a build that checks for updates trusts at least one key');
  for (const key of keys) {
    assert.deepEqual(Object.keys(key).sort(), ['crv', 'kid', 'kty', 'x', 'y']);
    await crypto.webcrypto.subtle.importKey('jwk', { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  }
  assert.equal(new Set(keys.map(key => key.kid)).size, keys.length, 'key IDs are unique');
});

test('the signing script makes a key outside the repository, sets the source and publishes a folder that verifies', () => {
  // A temporary copy of only the files the script uses; the real config is never written.
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'module-engine-signing-')), keys = fs.mkdtempSync(path.join(os.tmpdir(), 'module-engine-key-'));
  try {
    for (const file of ['scripts/update-signing.cjs', 'src/shared/update-config.js', 'src/blocking/evidence.js', 'src/background/threat-updates.js',
      'rules/threats.json', 'rules/threat-policy.json', 'rules/threat-evidence.json']) {
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(copy, file));
    }
    const script = path.join(copy, 'scripts/update-signing.cjs'), key = path.join(keys, 'signing.pem');
    const run = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: 'pipe' });
    const fails = (...args) => { try { run(...args); } catch (error) { return error.stderr; } throw new Error('expected a failure: ' + args.join(' ')); };
    assert.match(fails('create-key', '--key', path.join(copy, 'inside.pem')), /outside the repository/);
    run('create-key', '--key', key);
    assert.match(fails('create-key', '--key', key), /already exists/, 'an existing key is never overwritten silently');
    assert.match(fails('set-source', 'http://example.com/updates/'), /https/);
    run('set-source', 'https://raw.githubusercontent.com/owner/Module-Engine/main/updates/threats');
    const config = load(fs.readFileSync(path.join(copy, 'src/shared/update-config.js'), 'utf8')).ModuleEngineUpdateConfig;
    assert.equal(config.threatSource, 'https://raw.githubusercontent.com/owner/Module-Engine/main/updates/threats/');
    assert.equal(config.keys.length, 1);
    assert.match(fs.readFileSync(path.join(copy, 'src/shared/update-config.js'), 'utf8'), /^\/\* Signed-update settings/, 'the explanatory header is kept');
    const expired = Date.now() >= Date.parse(JSON.parse(fs.readFileSync(path.join(root, 'rules/threat-policy.json'), 'utf8')).expiresAt);
    if (expired) { assert.match(fails('publish-threats', '--key', key), /already expired/, 'an expired list is never published'); return; }
    // Windows prints the folder with a backslash.
    assert.match(run('publish-threats', '--key', key), /^Signed updates[\\/]threats: \d+ hosts, reviewed \d{4}-\d{2}-\d{2}/);
    const folder = path.join(copy, 'updates/threats');
    assert.deepEqual(fs.readdirSync(folder).sort(), ['threat-evidence.json', 'threat-evidence.sig', 'threat-policy.json', 'threats.json']);
    for (const file of ['threats.json', 'threat-policy.json', 'threat-evidence.json']) assert.ok(fs.readFileSync(path.join(folder, file)).equals(fs.readFileSync(path.join(root, 'rules', file))), file + ' is copied byte for byte');
    const signature = fs.readFileSync(path.join(folder, 'threat-evidence.sig'), 'utf8');
    const publicKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: config.keys[0].x, y: config.keys[0].y }, format: 'jwk' });
    assert.ok(crypto.verify('sha256', fs.readFileSync(path.join(folder, 'threat-evidence.json')), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature.trim(), 'base64')));
    run('create-key', '--key', key, '--replace');
    const replaced = load(fs.readFileSync(path.join(copy, 'src/shared/update-config.js'), 'utf8')).ModuleEngineUpdateConfig;
    assert.equal(replaced.keys.length, 1);
    assert.notEqual(replaced.keys[0].x, config.keys[0].x, '--replace drops the old key');
    assert.equal(replaced.threatSource, config.threatSource, 'changing keys keeps the source');
    run('set-source', '');
    assert.equal(load(fs.readFileSync(path.join(copy, 'src/shared/update-config.js'), 'utf8')).ModuleEngineUpdateConfig.threatSource, '');
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
    fs.rmSync(keys, { recursive: true, force: true });
  }
});
