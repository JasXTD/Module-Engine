/* Signed reported-threat update folders for tests, built from the bundled list
   and signed with a throwaway key; never the project's signing key.

   updateFolder({ privateKey, reviewedOn, hosts }) keeps the first `hosts`
   entries (their rules keep IDs 1..n), sets the review date and recomputes the
   policy and the evidence hashes exactly as the builder defines them. Returns
   the four files by name, as Buffers. */
'use strict';
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const DAY = 86400000;

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, jwk: { kid: 'test-' + crypto.randomBytes(3).toString('hex'), kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

const read = name => JSON.parse(fs.readFileSync(path.join(root, 'rules', name), 'utf8'));
const stamp = time => new Date(time).toISOString().replace('.000Z', 'Z');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sign = (bytes, privateKey) => crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') + '\n';

function updateFolder({ privateKey, reviewedOn, hosts } = {}) {
  const evidence = read('threat-evidence.json'), rules = read('threats.json');
  const count = hosts ?? rules.length;
  const catalog = { ...evidence.catalog, reviewedOn: reviewedOn ?? evidence.catalog.reviewedOn, domains: evidence.catalog.domains.slice(0, count) };
  // Month-only observations count from the first of the month, as in evidence.js.
  const earliest = Math.min(...catalog.domains.map(item => Date.parse(item.observedOn)));
  const policy = { schemaVersion: 1, ruleCount: count, evidenceFrom: stamp(earliest), reviewedAt: catalog.reviewedOn + 'T00:00:00Z',
    expiresAt: stamp(earliest + catalog.maxAgeDays * DAY) };
  const rulesBytes = Buffer.from(JSON.stringify(rules.slice(0, count), null, 2) + '\n');
  const policyBytes = Buffer.from(JSON.stringify(policy) + '\n');
  const evidenceBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, rulesSha256: sha256(rulesBytes), policySha256: sha256(policyBytes), catalog }, null, 2) + '\n');
  return { 'threats.json': rulesBytes, 'threat-policy.json': policyBytes, 'threat-evidence.json': evidenceBytes,
    'threat-evidence.sig': Buffer.from(sign(evidenceBytes, privateKey)) };
}

// A copy with one byte of a file flipped, which the evidence hashes must catch.
function tamper(folder, name, at = 40) {
  const copy = { ...folder, [name]: Buffer.from(folder[name]) };
  copy[name][at] ^= 0x01;
  return copy;
}

module.exports = { keyPair, updateFolder, tamper };
