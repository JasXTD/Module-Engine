const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../src/blocking/prompts.js');
const { classify } = globalThis.BlockAdsPrompts;
const source = fs.readFileSync(require.resolve('../src/blocking/notification-guard.js'), 'utf8');

for (const [message, labels, expected] of [
  ['Install HD codec to watch this video', ['Install codec'], 'install'],
  ['Video playback: missing codec. Download required codec.', ['Download now'], 'install'],
  ['Your video player is out of date. Update to continue.', ['Update player'], 'install'],
  ['Add this browser extension to download your file', ['Add extension'], 'install'],
  ['Install this plug-in before you can play the movie', ['Install'], 'install'],
  ['Enable browser add-on to continue', ['Enable add-on'], 'install'],
  ['Turn on notifications to receive news', ['No thanks', 'Allow'], 'notification'],
  ['Get notifications', ['Enable notifications'], 'notification'],
  ['Click “Allow” to prove you are human', ['Allow'], 'notification'],
  ['Click "Allow" to prove you are human', ['Allow'], 'notification'],
  ['Press Allow to download', ['Allow'], 'notification'],
  ['Download the desktop app', ['Download'], null],
  ['Install our browser extension', ['Install extension'], null],
  ['Update your browser to play video', ['Update browser'], null],
  ['Play this video', ['Play'], null],
  ['Select a video codec to export', ['Download movie'], null],
  ['Never install a codec to watch a video', ['Install codec'], null],
  ['Beware: fake extension required to download', ['Install extension'], null],
  ['How to install a codec to play a file', ['Read guide'], null],
  ['Notifications are enabled', ['Done'], null],
  ['Allow microphone access to continue', ['Allow'], null],
  ['Confirm you are human', ['Verify'], null],
  ['Install codec to play video', ['Cancel'], null],
  ['Install codec to play video' + 'x'.repeat(4000), ['Install'], null],
  ['Install codec to play video', ['Install' + 'x'.repeat(160)], null],
  ['Install codec to play video', Array(65).fill('Install'), null],
  [null, ['Install'], null], ['Install codec to play video', null, null]
]) test(`prompt classifier: ${String(message).slice(0, 65)} / ${JSON.stringify(expected)}`, () => {
  assert.deepEqual(classify(message, labels), expected ? [expected] : []);
});

test('a combined prompt matches both protections so either switch can cover it', () => {
  assert.deepEqual(classify('Allow notifications and install this extension to watch', ['Allow', 'Install extension']), ['notification', 'install']);
});

function realm(initial = 'default') {
  let permission = initial;
  const calls = { request: 0, subscribe: 0, events: [] };
  const Notification = { requestPermission() { calls.request++; return Promise.resolve(permission); } };
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => permission });
  class PushManager { subscribe(options) { calls.subscribe++; calls.options = options; calls.receiver = this; return Promise.resolve('subscription'); } }
  class HTMLIFrameElement { get contentWindow() { if (this.denied) throw new DOMException('Cross origin', 'SecurityError'); return this.realm; } get contentDocument() { return this.realm.document; } }
  const document = { querySelectorAll: () => [] };
  const window = { document, Notification, PushManager, HTMLIFrameElement, Promise, DOMException, queueMicrotask,
    addEventListener: (type, fn) => calls.events.push([type, fn]) };
  document.defaultView = window;
  return { window, calls, setPermission: value => { permission = value; }, run: () => vm.runInNewContext(source, { window, console }) };
}

test('notification guard resolves and calls back asynchronously without changing saved permission or calling native requests', async () => {
  const h = realm(); h.run();
  let callback, before = true;
  const result = h.window.Notification.requestPermission(value => { callback = value; assert.equal(before, false); });
  assert.equal(callback, undefined); before = false;
  assert.equal(await result, 'denied'); assert.equal(callback, 'denied');
  assert.equal(h.window.Notification.permission, 'default'); assert.equal(h.calls.request, 0);
  assert.throws(() => h.window.Notification.requestPermission('bad'), /callback/);
  assert.equal(await h.window.Notification.requestPermission(null), 'denied');
  h.setPermission('denied'); assert.equal(await h.window.Notification.requestPermission(), 'denied');
});

test('existing granted permissions preserve push subscription behavior and later revocation blocks it', async () => {
  const h = realm('granted'); h.run();
  assert.equal(await h.window.Notification.requestPermission(), 'granted');
  const manager = new h.window.PushManager(), options = { userVisibleOnly: true };
  assert.equal(await manager.subscribe(options), 'subscription');
  assert.equal(h.calls.options, options); assert.equal(h.calls.receiver, manager);
  h.setPermission('default');
  await assert.rejects(manager.subscribe(options), { name: 'NotAllowedError' });
  assert.equal(h.calls.subscribe, 1);
});

test('push prompt path is blocked when denied and preserves the native permission getter', async () => {
  const h = realm('denied'); h.run();
  // A page-supplied replacement must not trick the guard into invoking native subscribe.
  Object.defineProperty(h.window.Notification, 'permission', { get: () => 'granted' });
  await assert.rejects(new h.window.PushManager().subscribe({}), { name: 'NotAllowedError' });
  assert.equal(h.calls.subscribe, 0);
});

test('same-origin realm getters guard new documents once and leave the exposed object unchanged', async () => {
  const parent = realm(), child = realm(); parent.run();
  const frame = new parent.window.HTMLIFrameElement(); frame.realm = child.window;
  assert.equal(frame.contentWindow, child.window);
  const wrapped = child.window.Notification.requestPermission;
  assert.equal(await wrapped(), 'denied'); assert.equal(child.calls.request, 0);
  assert.equal(frame.contentDocument, child.window.document);
  assert.equal(child.window.Notification.requestPermission, wrapped);
  const next = realm(); frame.realm = next.window;
  assert.equal(await frame.contentWindow.Notification.requestPermission(), 'denied');
  assert.equal(next.calls.request, 0);
  frame.denied = true; assert.throws(() => frame.contentWindow, { name: 'SecurityError' });
});

test('unavailable notification APIs leave unrelated frame functionality working', () => {
  const h = realm(); delete h.window.Notification; delete h.window.PushManager;
  assert.doesNotThrow(h.run);
});

test('the shared overlay engine precedes both policies in the packaged isolated entry', () => {
  const manifest = JSON.parse(fs.readFileSync(require.resolve('../manifest.json'), 'utf8'));
  const scripts = manifest.content_scripts.find(entry => entry.js.includes('src/blocking/content.js')).js;
  assert.ok(scripts.indexOf('src/blocking/overlays.js') < scripts.indexOf('src/blocking/reddit.js'));
  assert.ok(scripts.indexOf('src/blocking/prompts.js') < scripts.indexOf('src/blocking/content.js'));
  assert.equal(manifest.permissions.includes('contentSettings'), false);
});
