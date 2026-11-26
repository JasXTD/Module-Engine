/* The cosmetic content script's handling of the registered generic stylesheets:
   request flags, revocation and re-requests, whatever order the browser runs the
   companion script in. Browser suites cover rendering; this covers the ordering. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const ATTRIBUTE = 'data-me-generic-off';

function load({ readyState = 'loading' } = {}) {
  const attributes = new Map(), nodes = [], listeners = {}, requests = [];
  const element = () => ({ id: '', textContent: '', isConnected: false,
    remove() { this.isConnected = false; nodes.splice(nodes.indexOf(this), 1); } });
  const document = {
    readyState, head: null,
    documentElement: {
      hasAttribute: name => attributes.has(name), setAttribute: (name, value) => attributes.set(name, String(value)),
      removeAttribute: name => attributes.delete(name), appendChild: node => { node.isConnected = true; nodes.push(node); }
    },
    getElementById: id => nodes.find(node => node.id === id) || null,
    createElement: element,
    // Stands in for the browser's selector parser: "!" marks an invalid selector.
    createDocumentFragment: () => ({ querySelector(selector) { if (selector.includes('!')) throw new SyntaxError(selector); return null; } }),
    addEventListener: (type, listener) => { listeners[type] = listener; }
  };
  const shield = () => ({ setRules() {}, setEnabled() {}, clear() {} });
  const chrome = { runtime: { id: 'test', sendMessage: message => new Promise((resolve, reject) => requests.push({ message, resolve, reject })) },
    storage: { onChanged: { addListener: listener => { listeners.storage = listener; } } } };
  const context = vm.createContext({ chrome, document, location: { hostname: 'news.test' }, console: { warn() {}, error() {} },
    setTimeout, clearTimeout, BlockAdsProcedural: { create: shield }, BlockAdsReddit: { policyFor: () => ({}) },
    BlockAdsButtons: { create: shield }, BlockAdsOverlays: { create: shield }, BlockAdsPrompts: { notification: {}, install: {} } });
  context.window = context;
  context.addEventListener = (type, listener) => { listeners['window-' + type] = listener; };
  context.removeEventListener = () => {};
  for (const file of ['src/blocking/cosmetic.js', 'src/blocking/content.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {
    requests, attributes, listeners,
    revoked: () => attributes.has(ATTRIBUTE),
    style: () => nodes.find(node => node.id === 'blockads-cosmetic-shield')?.textContent || '',
    // The registered companion script, run by the browser after the manifest scripts.
    companion: () => vm.runInContext(fs.readFileSync(path.join(root, 'src/blocking/generic-static.js'), 'utf8'), context),
    async reply(state, index = requests.length - 1) {
      requests[index].resolve({ ok: true, enabled: true, genericStatic: true, staticAssumed: true, siteSelectors: [], genericSelectors: [], exceptions: [], proceduralRules: [], ...state });
      await settle();
    },
    async fail(index = requests.length - 1) { requests[index].reject(new Error('Receiving end does not exist.')); await settle(); },
    async loaded() { document.readyState = 'interactive'; listeners.DOMContentLoaded(); await settle(); },
    async changed() { listeners.storage({ genericCosmeticFiltering: {} }, 'local'); await settle(); }
  };
}

test('the first request leaves stylesheet presence open, and later ones report it', async () => {
  const page = load();
  assert.equal(page.requests.length, 1);
  assert.equal(page.requests[0].message.staticGeneric, null);
  page.companion();
  await page.reply({});
  assert.equal(page.revoked(), false);
  // DOMContentLoaded asks again: the document-start request may have seen stale tab details.
  await page.loaded();
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].message.staticGeneric, true);
  await page.reply({});
  await page.changed();
  assert.equal(page.requests[2].message.staticGeneric, true);
  // A page without the stylesheets reports false once document-start scripts have run.
  const plain = load();
  await plain.reply({ genericStatic: false, staticAssumed: false, genericSelectors: ['.generic'] });
  await plain.loaded();
  assert.equal(plain.requests.length, 2);
  assert.equal(plain.requests[1].message.staticGeneric, false);
});

test('a companion that runs after the reply still applies a revocation', async () => {
  // Firefox runs registered scripts a task later; a paused tab's frame is told to revoke first.
  const page = load();
  await page.reply({ enabled: false, genericStatic: false, staticAssumed: null });
  assert.equal(page.revoked(), false, 'nothing to revoke until the stylesheets are known');
  page.companion();
  assert.equal(page.revoked(), true);
  assert.equal(page.requests.length, 1);
  await page.changed();
  await page.reply({ enabled: true, genericStatic: true, staticAssumed: true });
  assert.equal(page.revoked(), false, 'a later reply reinstates the stylesheets');
});

test('a reply judged for the wrong presence is asked again once', async () => {
  // Judged present, but no companion ran: the selectors arrive after DOMContentLoaded.
  const missing = load();
  await missing.reply({ genericStatic: true, staticAssumed: true, genericSelectors: [] });
  await missing.loaded();
  assert.equal(missing.requests.length, 2);
  assert.equal(missing.requests[1].message.staticGeneric, false);
  await missing.reply({ genericStatic: false, staticAssumed: false, genericSelectors: ['.generic'] });
  assert.match(missing.style(), /\.generic \{ display: none !important; \}/);
  assert.equal(missing.requests.length, 2);
  // Judged absent, but the stylesheets arrived: one smaller request, even if DOMContentLoaded follows.
  const present = load();
  await present.reply({ genericStatic: false, staticAssumed: false, genericSelectors: ['.generic'] });
  present.companion();
  await present.loaded();
  assert.equal(present.requests.length, 2);
  assert.equal(present.requests[1].message.staticGeneric, true);
  assert.equal(present.revoked(), true, 'until the new reply, the sheets defer to the complete list');
  await present.reply({ genericStatic: true, staticAssumed: true, genericSelectors: [] });
  assert.equal(present.revoked(), false);
  assert.equal(present.requests.length, 2);
});

test('the DOMContentLoaded request also retries a failed document-start request', async () => {
  const page = load();
  await page.fail();
  await page.loaded();
  assert.equal(page.requests.length, 2);
  assert.equal(page.requests[1].message.staticGeneric, false);
});

test('stylesheets that appear after DOMContentLoaded are reported with one request', async () => {
  // Firefox can inject newly registered scripts into a page that has already loaded.
  const page = load();
  await page.reply({ genericStatic: false, staticAssumed: false, genericSelectors: ['.generic'] });
  await page.loaded();
  await page.reply({ genericStatic: false, staticAssumed: false, genericSelectors: ['.generic'] });
  page.companion();
  assert.equal(page.requests.length, 3);
  assert.equal(page.requests[2].message.staticGeneric, true);
  page.companion();
  assert.equal(page.requests.length, 3, 'a second signal before the reply does not ask again');
  await page.reply({ genericStatic: true, staticAssumed: true, genericSelectors: [] });
  assert.equal(page.revoked(), false);
  assert.equal(page.requests.length, 3);
});

test('switches and exceptions revoke and reinstate present stylesheets; fallback rules stay within limits', async () => {
  const page = load();
  page.companion();
  await page.reply({});
  await page.changed();
  // A custom exception for a bundled selector: revoke and hide the rest from the state.
  const fallback = Array.from({ length: 300 }, (_, i) => `.generic-${i}`).concat(['.invalid!']);
  await page.reply({ genericStatic: false, staticAssumed: true, genericSelectors: fallback });
  assert.equal(page.revoked(), true);
  const rules = page.style().split(' { display: none !important; }').length - 1;
  assert.ok(rules >= 2, 'long generic lists are split across rules');
  assert.ok(page.style().includes('.generic-299') && !page.style().includes('.invalid!'));
  await page.changed();
  await page.reply({ genericStatic: true, staticAssumed: true, genericSelectors: [] });
  assert.equal(page.revoked(), false);
  assert.ok(!page.style().includes('.generic-0'));
});

test('a content script injected into an already-loaded page treats an absent companion as absent', async () => {
  const page = load({ readyState: 'complete' });
  assert.equal(page.requests[0].message.staticGeneric, false);
});

test('an open page replaces its CSS on a community list revision and ignores routine status checks', async () => {
  const page = load({ readyState: 'complete' });
  const reply = selector => page.reply({ genericStatic: false, staticAssumed: false, siteSelectors: [selector] });
  const revision = (before, after) => page.listeners.storage({
    communityStatus: { oldValue: { id: before }, newValue: { id: after } }
  }, 'local');
  await reply('.bundled');
  revision(null, 'update-one');
  assert.equal(page.requests.length, 2);
  await reply('.updated');
  assert.ok(page.style().includes('.updated') && !page.style().includes('.bundled'));
  revision('update-one', 'update-one');
  assert.equal(page.requests.length, 2);
  revision('update-one', null);
  assert.equal(page.requests.length, 3);
  await reply('.bundled');
  assert.ok(page.style().includes('.bundled') && !page.style().includes('.updated'));
  revision(null, 'rejected-update');
  revision('rejected-update', null);
  await reply('.bundled');
  await page.reply({ genericStatic: false, staticAssumed: false, siteSelectors: ['.stale'] }, page.requests.length - 2);
  assert.ok(page.style().includes('.bundled') && !page.style().includes('.stale'), 'a late update reply cannot undo rollback');
});

test('a document asks for its scriptlets in its first answered request only, and again only after a failure', async () => {
  const page = load();
  assert.equal(page.requests[0].message.installScriptlets, true);
  // DOMContentLoaded asks while the first request is still unanswered: no second start.
  await page.loaded();
  assert.equal(page.requests[1].message.installScriptlets, undefined);
  await page.fail(0);
  await page.reply({}, 1);
  await page.changed();
  assert.equal(page.requests[2].message.installScriptlets, true, 'the failed request is retried');
  await page.reply({});
  await page.changed();
  await page.reply({});
  // Restoring the page from the back-forward cache keeps the scriptlets it already runs.
  const before = page.requests.length;
  page.listeners['window-pageshow']({ isTrusted: true });
  assert.ok(page.requests.length > before);
  assert.ok(page.requests.slice(3).every(request => request.message.installScriptlets === undefined));
});
