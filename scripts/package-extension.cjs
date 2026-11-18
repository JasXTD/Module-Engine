#!/usr/bin/env node
/* Release packages for Module Engine. Offline: nothing is fetched, uploaded or
   signed here; signing and store uploads need the publisher's own accounts.

   node scripts/package-extension.cjs build [--out <dir>] [--firefox-update-url <https url>]
     Writes module-engine-<version>-chromium.zip (for the Chrome Web Store and
     Microsoft Edge Add-ons), module-engine-<version>-firefox.zip (to be signed
     by Mozilla) and SHA256SUMS to dist/. Both hold exactly the files the browser
     tests load (scripts/extension-files.cjs). Each manifest drops the other
     browser's keys. With --firefox-update-url, the Firefox package also gets
     browser_specific_settings.gecko.update_url, so a signed copy updates itself
     from that address. The archives are deterministic: the same source gives
     the same bytes.

   node scripts/package-extension.cjs version <x.y.z>
     Sets manifest.json's version, which must be higher than the current one.

   node scripts/package-extension.cjs firefox-update --xpi <signed.xpi> --link <https url> [--manifest <file>]
     Adds a Mozilla-signed package to the Firefox update manifest (default
     updates/firefox/updates.json) with its SHA-256, after checking its ID,
     version, update address and signature files. */
'use strict';
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const MANIFEST = path.join(root, 'manifest.json');
const DEFAULT_UPDATES = path.join(root, 'updates', 'firefox', 'updates.json');
// 1980-01-01 00:00, the earliest DOS date: a fixed time keeps archives reproducible.
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A plain deflated ZIP: sorted entries, fixed times, no extra fields.
function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const { name, data } of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!/^[\x21-\x7e][\x20-\x7e]*$/.test(name) || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsupported archive path: ${name}`);
    const nameBytes = Buffer.from(name, 'ascii'), compressed = zlib.deflateRawSync(data, { level: 9 }), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0, 8); header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12); header.writeUInt16LE(DOS_DATE, 14); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(data.length, 24); header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  if (offset > 0xffffffff || central.length / 2 > 0xffff) throw new Error('The package is too large for a plain ZIP.');
  return Buffer.concat([...locals, directory, end]);
}

// Reads a ZIP's entries through its central directory, as browsers and stores do.
function unzip(archive) {
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) if (archive.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('Not a ZIP archive.');
  const count = archive.readUInt16LE(end + 10), entries = new Map();
  let at = archive.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) throw new Error('Damaged ZIP directory.');
    const method = archive.readUInt16LE(at + 10), size = archive.readUInt32LE(at + 20), nameLength = archive.readUInt16LE(at + 28);
    const extra = archive.readUInt16LE(at + 30), comment = archive.readUInt16LE(at + 32), local = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    entries.set(name, () => {
      if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error(`Damaged ZIP entry: ${name}`);
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28), body = archive.subarray(start, start + size);
      if (method === 0) return Buffer.from(body);
      if (method === 8) return zlib.inflateRawSync(body);
      throw new Error(`Unsupported ZIP compression in ${name}.`);
    });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

const option = (args, name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return args[index + 1];
};
const httpsUrl = (value, label) => {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be a full https:// address.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`${label} must be an https:// address without a user name, password or fragment.`);
  return url.href;
};
const readManifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const versionParts = version => {
  // Chrome and Firefox accept one to four dot-separated integers up to 65535.
  if (!/^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/.test(version || '') || version.split('.').some(part => Number(part) > 65535)) throw new Error(`Invalid version: ${version}`);
  return version.split('.').map(Number);
};
const compareVersions = (a, b) => {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

// Every file a manifest names must be in the package.
function checkReferences(manifest, files) {
  const present = new Set(files), missing = [];
  const need = file => { if (file && !present.has(file.replace(/^\//, ''))) missing.push(file); };
  need(manifest.background?.service_worker);
  for (const file of manifest.background?.scripts || []) need(file);
  need(manifest.action?.default_popup);
  for (const file of Object.values(manifest.action?.default_icon || {})) need(file);
  for (const file of Object.values(manifest.icons || {})) need(file);
  need(manifest.options_ui?.page);
  for (const script of manifest.content_scripts || []) for (const file of [...(script.js || []), ...(script.css || [])]) need(file);
  for (const resource of manifest.declarative_net_request?.rule_resources || []) need(resource.path);
  // The service worker loads its modules with importScripts, relative to itself.
  const worker = manifest.background?.service_worker;
  if (worker && present.has(worker)) {
    const source = fs.readFileSync(path.join(root, worker), 'utf8'), base = path.posix.dirname(worker);
    for (const call of source.matchAll(/importScripts\(([^)]*)\)/g)) for (const [, file] of call[1].matchAll(/"([^"]+)"/g)) need(path.posix.normalize(path.posix.join(base, file)));
  }
  if (missing.length) throw new Error(`The manifest names files that are not packaged: ${[...new Set(missing)].join(', ')}`);
}

// Store manifests keep only their browser's keys; the runtime reads neither.
function manifestFor(target, manifest, firefoxUpdateUrl) {
  const copy = JSON.parse(JSON.stringify(manifest));
  if (target === 'chromium') {
    delete copy.browser_specific_settings;
    delete copy.background.scripts;
  } else {
    delete copy.minimum_chrome_version;
    delete copy.background.service_worker;
    if (!copy.browser_specific_settings?.gecko?.id) throw new Error('The Firefox package needs browser_specific_settings.gecko.id.');
    if (firefoxUpdateUrl) copy.browser_specific_settings.gecko.update_url = httpsUrl(firefoxUpdateUrl, '--firefox-update-url');
  }
  return copy;
}

function build(args) {
  const out = path.resolve(option(args, '--out') || path.join(root, 'dist'));
  const updateUrl = option(args, '--firefox-update-url');
  const manifest = readManifest();
  versionParts(manifest.version);
  // A fresh require: the inventory reads the working tree each time.
  delete require.cache[require.resolve('./extension-files.cjs')];
  const { files } = require('./extension-files.cjs');
  if (!files.includes('manifest.json')) throw new Error('The inventory has no manifest.json.');
  const results = [];
  for (const target of ['chromium', 'firefox']) {
    const targetManifest = manifestFor(target, manifest, updateUrl);
    checkReferences(targetManifest, files);
    const entries = files.map(file => ({ name: file, data: file === 'manifest.json'
      ? Buffer.from(JSON.stringify(targetManifest, null, 2) + '\n') : fs.readFileSync(path.join(root, file)) }));
    const name = `module-engine-${manifest.version}-${target}.zip`, archive = zip(entries);
    results.push({ name, archive, sha256: crypto.createHash('sha256').update(archive).digest('hex'), files: entries.length });
  }
  fs.mkdirSync(out, { recursive: true });
  for (const { name, archive } of results) fs.writeFileSync(path.join(out, name), archive);
  fs.writeFileSync(path.join(out, 'SHA256SUMS'), results.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n') + '\n');
  for (const { name, files: count, archive } of results) console.log(`${path.join(path.relative(root, out) || out, name)}: ${count} files, ${(archive.length / 1048576).toFixed(1)} MiB`);
  if (!updateUrl) console.log('The Firefox package has no update_url; pass --firefox-update-url so a signed copy can update itself.');
  return results;
}

function setVersion(args) {
  const [version] = args;
  versionParts(version);
  const text = fs.readFileSync(MANIFEST, 'utf8'), current = JSON.parse(text).version;
  if (compareVersions(version, current) <= 0) throw new Error(`${version} is not higher than the current version ${current}.`);
  const updated = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (JSON.parse(updated).version !== version) throw new Error('Could not set the version in manifest.json.');
  fs.writeFileSync(MANIFEST, updated);
  console.log(`manifest.json: ${current} -> ${version}`);
}

function firefoxUpdate(args) {
  const file = option(args, '--xpi'), link = httpsUrl(option(args, '--link') || '', '--link');
  const target = path.resolve(option(args, '--manifest') || DEFAULT_UPDATES);
  if (!file) throw new Error('Pass --xpi with the package Mozilla signed.');
  const archive = fs.readFileSync(file), entries = unzip(archive);
  if (!entries.has('manifest.json')) throw new Error('The package has no manifest.json.');
  // Mozilla's signing adds these; Firefox refuses an unsigned package.
  if (!entries.has('META-INF/mozilla.rsa') && !entries.has('META-INF/cose.sig')) throw new Error('The package is not signed by Mozilla (no META-INF signature). Sign it at addons.mozilla.org first.');
  const packaged = JSON.parse(entries.get('manifest.json')().toString('utf8')), gecko = packaged.browser_specific_settings?.gecko || {};
  const id = readManifest().browser_specific_settings?.gecko?.id;
  if (gecko.id !== id) throw new Error(`The package's add-on ID is ${gecko.id}, not ${id}.`);
  if (!gecko.update_url) throw new Error('The package has no update_url, so installed copies could not find later updates. Build it with --firefox-update-url.');
  versionParts(packaged.version);
  const updates = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : { addons: {} };
  if (!updates.addons || typeof updates.addons !== 'object') throw new Error(`${target} is not a Firefox update manifest.`);
  const list = (updates.addons[id] ??= { updates: [] }).updates ??= [];
  const entry = { version: packaged.version, update_link: link, update_hash: 'sha256:' + crypto.createHash('sha256').update(archive).digest('hex'),
    ...(gecko.strict_min_version ? { applications: { gecko: { strict_min_version: gecko.strict_min_version } } } : {}) };
  const kept = list.filter(item => item.version !== entry.version);
  kept.push(entry);
  kept.sort((a, b) => compareVersions(a.version, b.version));
  updates.addons[id].updates = kept;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(updates, null, 2) + '\n');
  console.log(`${path.relative(root, target) || target}: ${id} ${entry.version} -> ${link}`);
  return entry;
}

module.exports = { zip, unzip, crc32, compareVersions, manifestFor, checkReferences };

if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'build') build(args);
    else if (command === 'version') setVersion(args);
    else if (command === 'firefox-update') firefoxUpdate(args);
    else throw new Error('Use build, version or firefox-update. See the comment at the top of this file.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
