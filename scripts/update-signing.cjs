#!/usr/bin/env node
/* Signing for reported-threat updates. Offline: nothing is fetched or sent.

   node scripts/update-signing.cjs create-key [--key <file>] [--replace]
     Creates an ECDSA P-256 key pair. The private key is written outside the
     repository (default: ~/.module-engine/update-signing-key.pem) and must never
     be committed or shared. The public key is added to
     src/shared/update-config.js, which ships with the extension. --replace
     makes a new key and drops the old ones from the config.

   node scripts/update-signing.cjs set-source <url>
     Sets the folder the extension checks, for example
     https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/threats/.
     An empty string ("") turns update checks off for the next build.

   node scripts/update-signing.cjs publish-threats [--key <file>] [--out <dir>]
     Copies rules/threats.json, rules/threat-policy.json and
     rules/threat-evidence.json to the update folder (default: updates/threats),
     signs threat-evidence.json into threat-evidence.sig, then checks the result
     the way the extension will, before it can be pushed. */
'use strict';
const crypto = require('node:crypto'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(root, 'src/shared/update-config.js');
const DEFAULT_KEY = path.join(os.homedir(), '.module-engine', 'update-signing-key.pem');
const THREAT_FILES = ['threats.json', 'threat-policy.json', 'threat-evidence.json'];

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${name} needs a value.`);
  return path.resolve(args[index + 1]);
}
const inside = (file, folder) => { const relative = path.relative(folder, file); return !relative.startsWith('..') && !path.isAbsolute(relative); };

// The update modules, run the way the extension runs them. Uint8Array is shared
// with this realm, as in the extension, because evidence.js checks instanceof.
function loadModules(configText = fs.readFileSync(CONFIG_FILE, 'utf8')) {
  const context = { crypto: globalThis.crypto, Uint8Array, TextDecoder, TextEncoder, URL, AbortController, setTimeout, clearTimeout, atob, console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(configText, context, { filename: 'update-config.js' });
  for (const file of ['src/shared/shared.js', 'src/blocking/evidence.js', 'src/background/threat-updates.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  return context;
}
const readConfig = () => { const { threatSource, keys } = loadModules().ModuleEngineUpdateConfig; return { threatSource, keys: [...keys] }; };

function writeConfig({ threatSource, keys }) {
  const header = fs.readFileSync(CONFIG_FILE, 'utf8').match(/^\/\*[\s\S]*?\*\/\n/)?.[0] || '';
  const lines = keys.map(key => `    Object.freeze(${JSON.stringify({ kid: key.kid, kty: 'EC', crv: 'P-256', x: key.x, y: key.y })})`);
  const text = `${header}globalThis.ModuleEngineUpdateConfig = Object.freeze({
  threatSource: ${JSON.stringify(threatSource)},
  keys: Object.freeze([
${lines.join(',\n')}${lines.length ? '\n' : ''}  ])
});
`;
  // Refuse to write a file the extension could not load.
  if (JSON.stringify(loadModules(text).ModuleEngineUpdateConfig.keys) !== JSON.stringify(keys.map(key => ({ kid: key.kid, kty: 'EC', crv: 'P-256', x: key.x, y: key.y })))) {
    throw new Error('The generated update config did not read back as written.');
  }
  fs.writeFileSync(CONFIG_FILE, text);
}

function createKey(args) {
  const keyFile = option(args, '--key', DEFAULT_KEY);
  if (inside(keyFile, root)) throw new Error('Keep the private key outside the repository, so it can never be committed.');
  if (fs.existsSync(keyFile) && !args.includes('--replace')) throw new Error(`${keyFile} already exists. Pass --replace to make a new key; updates signed with the old key then stop being accepted by builds without it.`);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const jwk = publicKey.export({ format: 'jwk' }), kid = new Date().toISOString().slice(0, 10) + '-' + crypto.randomBytes(3).toString('hex');
  const config = readConfig();
  writeConfig({ ...config, keys: [...(args.includes('--replace') ? [] : config.keys), { kid, x: jwk.x, y: jwk.y }] });
  console.log(`Private key: ${keyFile}\nPublic key ${kid} added to ${path.relative(root, CONFIG_FILE)}. Commit that file; never commit or share the private key, and keep a backup of it.`);
}

function setSource(args) {
  if (args.length !== 1) throw new Error('Pass one address, or "" to turn update checks off.');
  const threatSource = args[0] ? loadModules().ModuleEngineThreatUpdates.sourceUrl(args[0]) : '';
  writeConfig({ ...readConfig(), threatSource });
  console.log(threatSource ? `Builds now check ${threatSource}` : 'Builds no longer check for reported-threat updates.');
}

async function publishThreats(args) {
  const keyFile = option(args, '--key', DEFAULT_KEY), out = option(args, '--out', path.join(root, 'updates', 'threats'));
  if (!fs.existsSync(keyFile)) throw new Error(`No private key at ${keyFile}. Run create-key first, or pass --key.`);
  const privateKey = crypto.createPrivateKey(fs.readFileSync(keyFile));
  fs.mkdirSync(out, { recursive: true });
  for (const file of THREAT_FILES) fs.copyFileSync(path.join(root, 'rules', file), path.join(out, file));
  const evidence = fs.readFileSync(path.join(out, 'threat-evidence.json'));
  const signature = crypto.sign('sha256', evidence, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  fs.writeFileSync(path.join(out, 'threat-evidence.sig'), signature + '\n');
  // Check the folder exactly as the extension will, against the shipped public keys.
  const { ModuleEngineThreatUpdates } = loadModules();
  const read = name => new Uint8Array(fs.readFileSync(path.join(out, name)));
  const files = { rules: read('threats.json'), policy: read('threat-policy.json'), evidence: read('threat-evidence.json'),
    signature: fs.readFileSync(path.join(out, 'threat-evidence.sig'), 'utf8') };
  const result = await ModuleEngineThreatUpdates.check(files);
  console.log(`Signed ${path.relative(root, out) || out}: ${result.catalog.domains.length} hosts, reviewed ${result.policy.reviewedAt.slice(0, 10)}, expires ${result.policy.expiresAt.slice(0, 10)}.`);
  console.log('Push this folder to the Module-Engine repository. Extensions install it only when its review date is newer than the list they use.');
}

(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'create-key') createKey(args);
  else if (command === 'set-source') setSource(args);
  else if (command === 'publish-threats') await publishThreats(args);
  else throw new Error('Use create-key, set-source or publish-threats. See the comment at the top of this file.');
})().catch(error => { console.error(error.message); process.exit(1); });
