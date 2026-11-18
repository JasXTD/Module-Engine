/* Release packaging: deterministic archives that hold exactly the tested files,
   per-browser manifests, version bumps and the Firefox update manifest. The
   script runs only on temporary copies here; the repository's own manifest and
   update files are never written. */
'use strict';
const { test, after } = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const packaging = require('../scripts/package-extension.cjs');
const { files } = require('../scripts/extension-files.cjs');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const UPDATE_URL = 'https://raw.githubusercontent.com/owner/Module-Engine/main/updates/firefox/updates.json';
const script = path.join(root, 'scripts/package-extension.cjs');
const temporary = [];
const temp = prefix => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); temporary.push(dir); return dir; };
after(() => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
const run = (file, ...args) => execFileSync(process.execPath, [file, ...args], { encoding: 'utf8', stdio: 'pipe' });
const fails = (file, ...args) => { try { run(file, ...args); } catch (error) { return error.stderr; } throw new Error('expected a failure: ' + args.join(' ')); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const names = { chromium: `module-engine-${manifest.version}-chromium.zip`, firefox: `module-engine-${manifest.version}-firefox.zip` };

let built = null;
function buildOnce() {
  if (built) return built;
  const out = temp('module-engine-package-');
  run(script, 'build', '--out', out, '--firefox-update-url', UPDATE_URL);
  built = { out, read: name => fs.readFileSync(path.join(out, name)) };
  return built;
}

test('packages hold exactly the files the browser tests load, byte for byte except the manifest', () => {
  const { read } = buildOnce();
  for (const target of ['chromium', 'firefox']) {
    const entries = packaging.unzip(read(names[target]));
    assert.deepEqual([...entries.keys()].sort(), [...files].sort(), target);
    for (const file of files) if (file !== 'manifest.json') assert.ok(entries.get(file)().equals(fs.readFileSync(path.join(root, file))), `${target}: ${file}`);
  }
});

test('each manifest keeps only its browser\'s keys, and the Firefox one names its update address', () => {
  const { read } = buildOnce();
  const chromium = JSON.parse(packaging.unzip(read(names.chromium)).get('manifest.json')());
  const firefox = JSON.parse(packaging.unzip(read(names.firefox)).get('manifest.json')());
  assert.equal(chromium.browser_specific_settings, undefined);
  assert.equal(chromium.background.scripts, undefined);
  assert.equal(chromium.background.service_worker, manifest.background.service_worker);
  assert.equal(chromium.minimum_chrome_version, manifest.minimum_chrome_version);
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.equal(firefox.background.service_worker, undefined);
  assert.deepEqual(firefox.background.scripts, manifest.background.scripts);
  assert.deepEqual(firefox.browser_specific_settings.gecko, { ...manifest.browser_specific_settings.gecko, update_url: UPDATE_URL });
  const { background, browser_specific_settings, minimum_chrome_version, ...shared } = manifest;
  for (const copy of [chromium, firefox]) {
    const { background: b, browser_specific_settings: s, minimum_chrome_version: m, ...rest } = copy;
    assert.deepEqual(rest, shared, 'every other key is unchanged');
  }
  void background; void browser_specific_settings; void minimum_chrome_version;
  assert.throws(() => packaging.manifestFor('firefox', manifest, 'http://example.com/updates.json'), /https/);
});

test('archives are reproducible and SHA256SUMS lists them', () => {
  const first = buildOnce(), again = temp('module-engine-package-');
  run(script, 'build', '--out', again, '--firefox-update-url', UPDATE_URL);
  for (const name of Object.values(names)) assert.ok(first.read(name).equals(fs.readFileSync(path.join(again, name))), name + ' builds identically');
  assert.equal(first.read('SHA256SUMS').toString('utf8'), Object.values(names).map(name => `${sha(first.read(name))}  ${name}`).join('\n') + '\n');
});

test('the archive format round-trips and its checksums are standard CRC-32', () => {
  const entries = [{ name: 'b/two.txt', data: Buffer.from('second') }, { name: 'a.txt', data: Buffer.alloc(0) }, { name: 'manifest.json', data: Buffer.from('{}') }];
  const read = packaging.unzip(packaging.zip(entries));
  assert.deepEqual([...read.keys()], ['a.txt', 'b/two.txt', 'manifest.json'], 'entries are sorted');
  for (const { name, data } of entries) assert.ok(read.get(name)().equals(data), name);
  assert.equal(packaging.crc32(Buffer.from('123456789')), 0xcbf43926);
  for (const name of ['../escape', '/absolute', 'back\\slash', 'ünicode']) assert.throws(() => packaging.zip([{ name, data: Buffer.alloc(1) }]), /Unsupported archive path/, name);
});

test('every file a manifest names must be packaged', () => {
  assert.throws(() => packaging.checkReferences({ background: { service_worker: 'missing.js' }, icons: { 16: 'icons/none.png' } }, ['manifest.json']),
    /not packaged: missing\.js, icons\/none\.png/);
  packaging.checkReferences(packaging.manifestFor('chromium', manifest), files);
  packaging.checkReferences(packaging.manifestFor('firefox', manifest), files);
});

test('version bumps must go up and keep the manifest otherwise unchanged', () => {
  const copy = temp('module-engine-version-');
  fs.mkdirSync(path.join(copy, 'scripts'));
  fs.copyFileSync(script, path.join(copy, 'scripts/package-extension.cjs'));
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(copy, 'manifest.json'));
  const local = path.join(copy, 'scripts/package-extension.cjs'), before = fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8');
  assert.match(fails(local, 'version', manifest.version), /not higher/);
  assert.match(fails(local, 'version', '1.2.x'), /Invalid version/);
  assert.match(fails(local, 'version', '70000.0.0'), /Invalid version/);
  const next = manifest.version.replace(/\d+$/, digits => String(Number(digits) + 1));
  run(local, 'version', next);
  const after = fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8');
  assert.equal(JSON.parse(after).version, next);
  assert.equal(after, before.replace(`"version": "${manifest.version}"`, `"version": "${next}"`), 'only the version changed');
  assert.ok(packaging.compareVersions('1.10.0', '1.9.9') > 0 && packaging.compareVersions('2.0', '2.0.0') === 0);
});

test('the Firefox update manifest requires the publisher hash, signature markers, this ID and an update address', () => {
  const { read } = buildOnce(), dir = temp('module-engine-updates-'), updates = path.join(dir, 'updates.json');
  const firefox = packaging.unzip(read(names.firefox));
  const repack = (changes = {}, signed = true) => {
    const entries = [...firefox.keys()].map(name => ({ name, data: firefox.get(name)() }));
    const packaged = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data);
    Object.assign(packaged, changes.manifest || {});
    if (changes.gecko) packaged.browser_specific_settings.gecko = { ...packaged.browser_specific_settings.gecko, ...changes.gecko };
    entries.find(entry => entry.name === 'manifest.json').data = Buffer.from(JSON.stringify(packaged));
    // Stand-ins for the signature files Mozilla adds; they are not checked cryptographically.
    if (signed) entries.push({ name: 'META-INF/cose.sig', data: Buffer.from('signature') }, { name: 'META-INF/mozilla.rsa', data: Buffer.from('signature') });
    const file = path.join(dir, `pkg-${crypto.randomBytes(4).toString('hex')}.xpi`);
    fs.writeFileSync(file, packaging.zip(entries));
    return file;
  };
  const link = version => `https://github.com/owner/Module-Engine/releases/download/v${version}/module-engine-${version}-firefox.xpi`;
  // These are fixture digests. A release uses the independent signed-file hash from AMO.
  const hash = file => 'sha256:' + sha(fs.readFileSync(file));
  const args = (file, version) => ['firefox-update', '--xpi', file, '--link', link(version), '--manifest', updates];
  const add = (file, version) => run(script, ...args(file, version), '--amo-hash', hash(file));
  const rejected = file => fails(script, ...args(file, '1'), '--amo-hash', hash(file));
  const markers = repack();
  assert.match(fails(script, ...args(markers, '1')), /--amo-hash/);
  assert.match(fails(script, ...args(markers, '1'), '--amo-hash', 'sha256:invalid'), /--amo-hash/);
  assert.match(fails(script, ...args(markers, '1'), '--amo-hash', hash(repack({ manifest: { version: '1.10.0' } }))), /does not match/);
  assert.match(rejected(repack({}, false)), /signature files/);
  assert.match(rejected(repack({ gecko: { id: 'other@example.com' } })), /add-on ID is other@example.com/);
  assert.match(rejected(repack({ gecko: { update_url: undefined } })), /no update_url/);
  assert.match(fails(script, 'firefox-update', '--xpi', repack(), '--link', 'http://example.com/a.xpi', '--manifest', updates), /https/);
  assert.equal(fs.existsSync(updates), false, 'refused packages write nothing');
  const later = repack({ manifest: { version: '1.10.0' } }), current = repack();
  add(later, '1.10.0');
  add(current, manifest.version);
  const beforeRejection = fs.readFileSync(updates);
  assert.match(fails(script, ...args(later, '1.10.0'), '--amo-hash', hash(current)), /does not match/);
  assert.deepEqual(fs.readFileSync(updates), beforeRejection);
  add(current, manifest.version);
  const written = JSON.parse(fs.readFileSync(updates, 'utf8'));
  const id = manifest.browser_specific_settings.gecko.id;
  assert.deepEqual(Object.keys(written), ['addons']);
  assert.deepEqual(written.addons[id].updates.map(entry => entry.version), [manifest.version, '1.10.0'], 'sorted by version, one entry per version');
  assert.deepEqual(written.addons[id].updates[1], { version: '1.10.0', update_link: link('1.10.0'), update_hash: 'sha256:' + sha(fs.readFileSync(later)),
    applications: { gecko: { strict_min_version: manifest.browser_specific_settings.gecko.strict_min_version } } });
});
