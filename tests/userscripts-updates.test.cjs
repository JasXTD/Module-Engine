const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('../vendor/publicsuffix/suffixes.js'); require('../src/userscripts/userscripts-matching.js'); require('../src/userscripts/userscripts-page.js');
require('../src/userscripts/userscripts-core.js'); require('../src/userscripts/userscripts-network.js'); require('../src/userscripts/userscripts-updates.js');
const core = globalThis.BlockAdsUserScriptCore, network = globalThis.BlockAdsUserScriptNetwork, updates = globalThis.BlockAdsUserScriptUpdates;
const clone = value => structuredClone(value);
const DAY = updates.LIMITS.interval;
const script = (version = '1.0', extra = '', name = 'Updater', body = 'void 0;') => '// ==UserScript==\n// @name ' + name +
  '\n// @namespace tests\n' + (version ? '// @version ' + version + '\n' : '') + '// @match https://example.test/*\n' + extra + '// ==/UserScript==\n' + body;
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const record = (n, source, sourceURL = null, fields = {}) => ({ id: id(n), revision: 1, enabled: false, source, token: 'a'.repeat(64), values: {}, sourceURL, ...fields });
const libraryOf = (scripts, enabled = true) => ({ schemaVersion: 1, revision: 1, enabled, scripts });

async function server(t) {
  const state = { routes: {}, hits: [] };
  const instance = http.createServer(async (request, response) => {
    const route = state.routes[request.url];
    state.hits.push({ url: request.url, cookie: request.headers.cookie || '', referer: request.headers.referer || '' });
    if (!route) { response.writeHead(404); response.end(); return; }
    if (route.gate) await route.gate;
    response.writeHead(route.status || 200, { 'Content-Type': route.type || 'text/javascript; charset=utf-8', ...(route.headers || {}) });
    response.end(route.body);
  });
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); }));
  return { base: 'http://127.0.0.1:' + instance.address().port, state };
}
// Chromium's storage returns object keys in sorted order, not insertion order.
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
function fakeApi(initial = {}) {
  const state = { data: clone(initial), tabUpdates: [], alarms: new Map(), hooks: {}, writes: 0, faults: {} };
  const api = {
    storage: { local: {
      async get(key) { return key in state.data ? { [key]: sorted(clone(state.data[key])) } : {}; },
      async set(patch) {
        if (state.faults.save) { state.faults.save--; throw new Error('Injected save failure'); }
        Object.assign(state.data, clone(patch)); state.writes++;
        if (state.faults.corruptAfterSave) { state.faults.corruptAfterSave--; state.data[updates.KEY] = { schemaVersion: 1, broken: true }; }
      }
    } },
    alarms: { async get(name) { return state.alarms.get(name); }, async create(name, info) { state.alarms.set(name, { name, ...info }); },
      onAlarm: { addListener: callback => { state.hooks.alarm = callback; } } },
    webRequest: { onBeforeRequest: { addListener: (callback, filter) => { state.hooks.request = callback; state.filter = filter; } } },
    tabs: { async update(tabId, properties) { state.tabUpdates.push({ tabId, ...properties }); return { id: tabId }; } },
    runtime: { getURL: path => 'chrome-extension://test/' + path }
  };
  return { api, state };
}
function setup(t, initial, options = {}) {
  let time = options.time ?? Date.UTC(2026, 10, 14);
  const { api, state } = fakeApi(initial);
  const host = updates.create(api, { network, now: () => time });
  return { api, state, host, advance: ms => { time += ms; }, now: () => time };
}
const entry = (h, n) => h.state.data[updates.KEY]?.scripts[id(n)];
const request = (url, extra = {}) => ({ url, type: 'main_frame', method: 'GET', tabId: 4, frameId: 0, ...extra });

test('update destinations follow @downloadURL/@updateURL only for scripts linked through a reviewed install', () => {
  const linked = 'https://scripts.test/a.user.js';
  assert.deepEqual(updates.targets(record(1, script(), linked)), { download: linked, version: null, suggested: null, automatic: true, notes: [] });
  const declared = updates.targets(record(1, script('2', '// @downloadURL https://cdn.test/a.user.js\n// @updateURL https://cdn.test/a.meta.js\n'), linked));
  assert.equal(declared.download, 'https://cdn.test/a.user.js'); assert.equal(declared.version, 'https://cdn.test/a.meta.js');
  assert.equal(updates.targets(record(1, script('2', '// @updateURL ' + linked + '\n'), linked)).version, null);
  const unusable = updates.targets(record(1, script('2', '// @downloadURL http://cdn.test/a.user.js\n// @updateURL https://u:p@cdn.test/a.meta.js\n'), linked));
  assert.equal(unusable.download, linked); assert.equal(unusable.version, null); assert.equal(unusable.notes.length, 2);
  // A local script is never checked automatically; its declared URL is only a suggestion to review.
  const local = updates.targets(record(1, script('2', '// @downloadURL https://cdn.test/a.user.js\n')));
  assert.equal(local.download, null); assert.equal(local.suggested, 'https://cdn.test/a.user.js'); assert.equal(local.automatic, false);
  assert.equal(updates.targets(record(1, script(''), linked)).automatic, false);
});

test('metadata versions are read leniently but only from one well-formed leading block', () => {
  assert.equal(updates.metaVersion('// ==UserScript==\r\n// @name A\r\n// @version  2.1.0 \r\n// @antifeature ads\r\n// ==/UserScript==\r\n'), '2.1.0');
  assert.equal(updates.metaVersion('\uFEFF// ==UserScript==\n// @version 3\n// ==/UserScript=='), '3');
  for (const text of [null, '', '// @version 1', 'x\n// ==UserScript==\n// @version 1\n// ==/UserScript==\n',
    '// ==UserScript==\n// @version 1\n// @version 2\n// ==/UserScript==\n', '// ==UserScript==\n// @name A\n// ==/UserScript==\n',
    '// ==UserScript==\n// @version 1\n']) assert.equal(updates.metaVersion(text), null);
});

test('only committed top-level GET navigations to direct userscript URLs are intercepted', () => {
  for (const [url, expected] of [['https://host.test/a.user.js', 'https://host.test/a.user.js'], ['https://host.test/a.user.js?v=2', 'https://host.test/a.user.js?v=2'],
    ['https://host.test/A.USER.JS', 'https://host.test/A.USER.JS'], ['http://localhost:9/a.user.js', 'http://localhost:9/a.user.js'],
    ['https://host.test/a.user.js#frag', 'https://host.test/a.user.js']]) assert.equal(updates.interceptURL(request(url)), expected, url);
  for (const details of [request('http://host.test/a.user.js'), request('https://u:p@host.test/a.user.js'), request('https://host.test/a.user.json'),
    request('https://host.test/a.js'), request('https://host.test/x?file=a.user.js'), request('https://host.test/a.user.js', { method: 'POST' }),
    request('https://host.test/a.user.js', { type: 'sub_frame' }), request('https://host.test/a.user.js', { tabId: -1 }),
    request('https://host.test/a.user.js', { frameId: 3 }), request('https://host.test/a.user.js', { documentLifecycle: 'prerender' }),
    request('https://host.test/a.user.js', { frameType: 'fenced_frame' }), request('not a url'), null]) assert.equal(updates.interceptURL(details), null);
  assert.deepEqual(updates.FILTER.types, ['main_frame']);
  const hash = updates.installHash('https://host.test/a b.user.js?x=1&y=2');
  assert.equal(updates.installFromHash(hash), 'https://host.test/a%20b.user.js?x=1&y=2');
  for (const value of ['', '#install=', '#install=javascript%3Aalert(1)', '#install=http%3A%2F%2Fhost.test%2Fa.user.js', hash + '&x', hash + '#y', null])
    assert.equal(updates.installFromHash(value), null);
});

test('saved state fails closed, drops damaged cache entries and bounds staged source', () => {
  assert.deepEqual(updates.state(undefined), { schemaVersion: 1, interceptLinks: true, autoCheck: true, scripts: {} });
  for (const raw of [null, {}, { schemaVersion: 2, interceptLinks: true, autoCheck: true, scripts: {} },
    { schemaVersion: 1, interceptLinks: 'yes', autoCheck: true, scripts: {} }, { schemaVersion: 1, interceptLinks: true, autoCheck: true, scripts: [] }])
    assert.throws(() => updates.state(raw), /invalid/);
  const base = 'b'.repeat(64), good = { base, checkedAt: 1, outcome: 'current', version: '1.0' };
  const big = script('2', '', 'Big', '//' + 'x'.repeat(core.LIMITS.source - 200));
  const scripts = { [id(1)]: good, 'not-an-id': good, [id(2)]: { ...good, outcome: 'staged' }, [id(3)]: { ...good, staged: { source: script(), sourceURL: 'https://a.test/a.user.js' } },
    [id(4)]: { ...good, outcome: 'staged', staged: { source: 'no metadata', sourceURL: 'https://a.test/a.user.js' } },
    [id(5)]: { ...good, outcome: 'staged', staged: { source: script(), sourceURL: 'http://a.test/a.user.js' } },
    [id(6)]: { ...good, base: 'short' }, [id(7)]: { ...good, outcome: 'applied' }, [id(8)]: { ...good, message: 'x'.repeat(513) } };
  for (let n = 10; n < 19; n++) scripts[id(n)] = { ...good, outcome: 'staged', staged: { source: big, sourceURL: 'https://a.test/' + n + '.user.js' } };
  const result = updates.state({ schemaVersion: 1, interceptLinks: false, autoCheck: true, scripts });
  assert.deepEqual(result.scripts[id(1)], good);
  for (const n of [2, 3, 4, 5, 6, 7, 8]) assert.equal(result.scripts[id(n)], undefined, 'entry ' + n);
  const staged = Object.values(result.scripts).filter(item => item.staged);
  assert.ok(staged.reduce((sum, item) => sum + core.bytes(item.staged.source), 0) <= updates.LIMITS.staged);
  assert.equal(staged.length, 8); assert.equal(result.interceptLinks, false);
});

test('scheduled checks compare @updateURL versions first, then stage the exact newer bytes for review without changing the library', async t => {
  const { base, state: web } = await server(t);
  const installed = script('1.0', '// @downloadURL ' + base + '/a.user.js\n// @updateURL ' + base + '/a.meta.js\n');
  const library = libraryOf([record(1, installed, base + '/install.user.js', { enabled: true })]);
  const h = setup(t, { userscriptManager: library });
  await h.host.start();
  assert.deepEqual(h.state.alarms.get(updates.ALARM), { name: updates.ALARM, delayInMinutes: 5, periodInMinutes: 60 });
  await h.host.start(); assert.equal(h.state.alarms.size, 1);
  web.routes['/a.meta.js'] = { body: '// ==UserScript==\n// @name Updater\n// @version 1.0\n// @antifeature tracking\n// ==/UserScript==\n' };
  assert.deepEqual(await h.host.runChecks(), { checked: 1, staged: 0, cancelled: false });
  assert.deepEqual(web.hits.map(hit => hit.url), ['/a.meta.js']);
  assert.equal(entry(h, 1).outcome, 'current'); assert.equal(entry(h, 1).version, '1.0');
  // Within a day the unchanged script is not contacted again.
  assert.deepEqual(await h.host.runChecks(), { checked: 0, staged: 0, cancelled: false }); assert.equal(web.hits.length, 1);
  h.advance(DAY);
  const next = script('1.1', '// @downloadURL ' + base + '/a.user.js\n// @updateURL ' + base + '/a.meta.js\n', 'Updater', 'void 1;');
  web.routes['/a.meta.js'].body = '// ==UserScript==\n// @version 1.1\n// ==/UserScript==\n';
  web.routes['/a.user.js'] = { body: next };
  assert.deepEqual(await h.host.runChecks(), { checked: 1, staged: 1, cancelled: false });
  assert.deepEqual(web.hits.map(hit => hit.url), ['/a.meta.js', '/a.meta.js', '/a.user.js']);
  assert.ok(web.hits.every(hit => !hit.cookie && !hit.referer));
  assert.deepEqual(h.state.data.userscriptManager, library, 'checks never write the script library');
  const view = await h.host.view();
  assert.equal(view.scripts[id(1)].outcome, 'staged'); assert.equal(view.scripts[id(1)].available, '1.1');
  assert.equal(view.scripts[id(1)].download, base + '/a.user.js'); assert.equal(view.scripts[id(1)].version, base + '/a.meta.js');
  const { review } = await h.host.stagedReview({ id: id(1), revision: 1 });
  assert.equal(review.source, next); assert.equal(review.sourceURL, base + '/a.user.js'); assert.equal(review.versionChange, 1);
  assert.equal(review.previousSource, installed); assert.equal(review.id, id(1)); assert.equal(web.hits.length, 3, 'review reads the staged bytes');
  await assert.rejects(h.host.stagedReview({ id: id(1), revision: 2 }), /changed/);
  // Toggling the script keeps the staged result; changing its source invalidates it.
  h.state.data.userscriptManager.scripts[0].revision = 2; h.state.data.userscriptManager.scripts[0].enabled = false;
  assert.equal((await h.host.stagedReview({ id: id(1), revision: 2 })).review.source, next);
  h.state.data.userscriptManager.scripts[0].source = installed + '\n// local edit';
  assert.equal((await h.host.view()).scripts[id(1)].outcome, undefined);
  await assert.rejects(h.host.stagedReview({ id: id(1), revision: 2 }), /no longer current/);
});

test('scheduled checks without @updateURL download the source and stage only strictly newer versions', async t => {
  const { base, state: web } = await server(t);
  const scripts = [record(1, script('1.0'), base + '/one.user.js'), record(2, script('2.0', '', 'Two'), base + '/two.user.js'),
    record(3, script('', '', 'Three'), base + '/three.user.js'), record(4, script('1', '', 'Four'), base + '/four.user.js'),
    record(5, script('1', '', 'Five'), base + '/five.user.js'), record(6, script('1', '', 'Six'), base + '/six.user.js'),
    record(7, script('1', '', 'Seven')), record(8, script('1', '', 'Eight'), base + '/eight.user.js')];
  const h = setup(t, { userscriptManager: libraryOf(scripts) });
  web.routes['/one.user.js'] = { body: script('1.0', '', 'Updater', 'changed();') };
  web.routes['/two.user.js'] = { body: script('1.9', '', 'Two') };
  web.routes['/four.user.js'] = { body: script('2', '', 'Renamed') };
  web.routes['/five.user.js'] = { body: script('', '', 'Five') };
  web.routes['/six.user.js'] = { body: '<html></html>', type: 'text/html' };
  web.routes['/eight.user.js'] = { status: 302, headers: { Location: '/redirected.user.js' }, body: '' };
  const result = await h.host.runChecks();
  assert.equal(result.checked, 7); assert.equal(result.staged, 0);
  assert.equal(entry(h, 1).outcome, 'current', 'same version, changed bytes are left to manual review');
  assert.equal(entry(h, 2).outcome, 'current');
  assert.match(entry(h, 3).message, /@version/); assert.equal(entry(h, 3).outcome, 'skipped');
  assert.match(entry(h, 4).message, /@name or @namespace changed/);
  assert.match(entry(h, 5).message, /cannot be compared/); assert.match(entry(h, 6).message, /HTML/);
  assert.equal(entry(h, 7), undefined, 'a local script is never contacted');
  assert.equal(entry(h, 8).outcome, 'error');
  assert.ok(!web.hits.some(hit => hit.url === '/redirected.user.js'), 'redirects are not followed');
  assert.ok(!web.hits.some(hit => hit.url.startsWith('/three')), 'scripts without @version are not downloaded');
});

test('module, setting and force controls decide whether a run contacts any host', async t => {
  const { base, state: web } = await server(t);
  web.routes['/a.user.js'] = { body: script('1.0') };
  const off = setup(t, { userscriptManager: libraryOf([record(1, script('1.0'), base + '/a.user.js')], false) });
  assert.deepEqual(await off.host.runChecks(), { checked: 0, staged: 0 }); assert.equal(web.hits.length, 0);
  const disabled = setup(t, { userscriptManager: libraryOf([record(1, script('1.0'), base + '/a.user.js')]),
    [updates.KEY]: { schemaVersion: 1, interceptLinks: true, autoCheck: false, scripts: {} } });
  assert.deepEqual(await disabled.host.runChecks(), { checked: 0, staged: 0 }); assert.equal(web.hits.length, 0);
  assert.equal((await disabled.host.runChecks({ force: true })).checked, 1); assert.equal(web.hits.length, 1);
  // Forced checks repeat even when the last result is fresh.
  assert.equal((await disabled.host.runChecks({ force: true })).checked, 1); assert.equal(web.hits.length, 2);
  const corrupt = setup(t, { userscriptManager: libraryOf([record(1, script('1.0'), base + '/a.user.js')]), [updates.KEY]: { broken: true } });
  const view = await corrupt.host.view();
  assert.equal(view.autoCheck, false); assert.equal(view.interceptLinks, false); assert.match(view.error, /invalid/);
  assert.deepEqual(await corrupt.host.runChecks(), { checked: 0, staged: 0 }); assert.equal(web.hits.length, 2);
  await assert.rejects(corrupt.host.runChecks({ force: true }), /invalid/, 'damaged settings are never silently replaced by a check');
  assert.deepEqual(corrupt.state.data[updates.KEY], { broken: true });
  const repaired = await corrupt.host.setSettings({ interceptLinks: true });
  assert.equal(repaired.interceptLinks, true); assert.equal(repaired.autoCheck, false, 'repair keeps the other behavior off'); assert.equal(repaired.error, '');
  await assert.rejects(corrupt.host.setSettings({}), /valid update setting/);
  await assert.rejects(corrupt.host.setSettings({ autoCheck: 'on' }), /valid update setting/);
  await assert.rejects(corrupt.host.setSettings({ enabled: true }), /valid update setting/);
});

test('alarms only start their own scheduled run, which a second trigger joins', async t => {
  const { base, state: web } = await server(t);
  let release; web.routes['/a.user.js'] = { body: script('1.1'), gate: new Promise(resolve => { release = resolve; }) };
  const h = setup(t, { userscriptManager: libraryOf([record(1, script('1.0'), base + '/a.user.js')]) });
  h.state.hooks.alarm({ name: 'threatCheck' });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(web.hits.length, 0);
  h.state.hooks.alarm({ name: updates.ALARM });
  for (let i = 0; i < 200 && !web.hits.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(web.hits.length, 1); assert.equal((await h.host.view()).checking, true);
  const joined = h.host.runChecks({ force: true });
  release();
  assert.deepEqual(await joined, { checked: 1, staged: 1, cancelled: false });
  assert.equal(web.hits.length, 1); assert.equal((await h.host.view()).checking, false);
});

test('a result is discarded when the script changes or the run is cancelled during its download', async t => {
  const { base, state: web } = await server(t);
  let release; web.routes['/a.user.js'] = { body: script('1.1'), gate: new Promise(resolve => { release = resolve; }) };
  const h = setup(t, { userscriptManager: libraryOf([record(1, script('1.0'), base + '/a.user.js')]) });
  const pending = h.host.runChecks();
  for (let i = 0; i < 200 && !web.hits.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  h.state.data.userscriptManager.scripts[0].source = script('1.0', '', 'Updater', 'edited();');
  release();
  assert.deepEqual(await pending, { checked: 1, staged: 0, cancelled: false });
  assert.equal(entry(h, 1), undefined, 'the stale download was not kept');
  let releaseSecond; web.routes['/a.user.js'].gate = new Promise(resolve => { releaseSecond = resolve; });
  const cancelled = h.host.runChecks();
  for (let i = 0; i < 200 && web.hits.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  h.host.cancel('Userscripts were paused.');
  assert.deepEqual(await cancelled, { checked: 0, staged: 0, cancelled: true });
  releaseSecond(); assert.equal(entry(h, 1), undefined);
  // Turning automatic checks off cancels an active run too.
  let releaseThird; web.routes['/a.user.js'].gate = new Promise(resolve => { releaseThird = resolve; });
  const stopped = h.host.runChecks();
  for (let i = 0; i < 200 && web.hits.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await h.host.setSettings({ autoCheck: false });
  assert.equal((await stopped).cancelled, true); releaseThird(); assert.equal(entry(h, 1), undefined);
});

test('staged downloads share a 1 MiB budget; later updates stay available for a fresh review', async t => {
  const { base, state: web } = await server(t);
  const scripts = [];
  for (let n = 1; n <= 9; n++) {
    const name = 'Script ' + n;
    scripts.push(record(n, script('1.0', '', name), base + '/' + n + '.user.js'));
    web.routes['/' + n + '.user.js'] = { body: script('2.0', '', name, '//' + 'x'.repeat(core.LIMITS.source - 300)) };
  }
  const h = setup(t, { userscriptManager: libraryOf(scripts) });
  assert.deepEqual(await h.host.runChecks(), { checked: 9, staged: 8, cancelled: false });
  assert.equal(entry(h, 9).outcome, 'available'); assert.equal(entry(h, 9).version, '2.0'); assert.equal(entry(h, 9).staged, undefined);
  await assert.rejects(h.host.stagedReview({ id: id(9), revision: 1 }), /no longer current/);
  // Deleting a script frees its staged bytes on the next recorded result.
  h.state.data.userscriptManager.scripts.splice(0, 1); h.advance(DAY);
  await h.host.runChecks();
  assert.equal(entry(h, 1), undefined); assert.equal(entry(h, 9).outcome, 'staged');
});

test('storage failures leave the previous update state in place', async t => {
  const { base, state: web } = await server(t);
  web.routes['/a.user.js'] = { body: script('1.1') };
  const h = setup(t, { userscriptManager: libraryOf([record(1, script('1.0'), base + '/a.user.js')]) });
  h.state.faults.save = 1;
  await assert.rejects(h.host.setSettings({ interceptLinks: false }), /Injected save failure/);
  assert.equal(h.state.data[updates.KEY], undefined);
  h.state.faults.corruptAfterSave = 1;
  await assert.rejects(h.host.setSettings({ interceptLinks: false }), /could not be verified/);
  assert.deepEqual(h.state.data[updates.KEY], updates.state(undefined));
  assert.equal((await h.host.view()).interceptLinks, true);
});

test('link interception opens the review page only while enabled, with rate limits and one-shot passage', async t => {
  const h = setup(t, { userscriptManager: libraryOf([]) });
  assert.deepEqual(h.state.filter, { types: updates.FILTER.types, urls: updates.FILTER.urls });
  const url = 'https://scripts.test/a.user.js';
  assert.equal(await h.host.intercept(request(url)), true);
  assert.deepEqual(h.state.tabUpdates, [{ tabId: 4, url: 'chrome-extension://test/' + updates.MANAGER + updates.installHash(url) }]);
  assert.equal(updates.installFromHash(new URL(h.state.tabUpdates[0].url).hash), url);
  assert.equal(await h.host.intercept(request(url)), false, 'a tab is not replaced twice within two seconds');
  assert.equal(await h.host.intercept(request(url, { tabId: 5 })), true);
  h.advance(updates.LIMITS.tabWindow);
  // The review page asks for passage when the URL is not a direct userscript.
  h.host.allowNavigation(4, url);
  assert.equal(await h.host.intercept(request(url)), false);
  assert.equal(await h.host.intercept(request(url)), true, 'passage is used once');
  h.advance(updates.LIMITS.tabWindow); h.host.allowNavigation(4, url); h.advance(updates.LIMITS.bypass);
  assert.equal(await h.host.intercept(request(url)), true, 'unused passage expires');
  assert.throws(() => h.host.allowNavigation(-1, url), /browser tab/);
  assert.throws(() => h.host.allowNavigation(4, 'http://scripts.test/a.user.js'), /HTTPS/);
  h.advance(updates.LIMITS.interceptWindow);
  let admitted = 0;
  for (let tab = 10; tab < 30; tab++) admitted += await h.host.intercept(request(url, { tabId: tab })) ? 1 : 0;
  assert.equal(admitted, updates.LIMITS.intercepts, 'global interception rate is bounded');
  h.advance(updates.LIMITS.interceptWindow);
  await h.host.setSettings({ interceptLinks: false });
  assert.equal(await h.host.intercept(request(url, { tabId: 40 })), false);
  await h.host.setSettings({ interceptLinks: true });
  h.state.data.userscriptManager.enabled = false;
  assert.equal(await h.host.intercept(request(url, { tabId: 41 })), false, 'paused userscripts never intercept');
  h.state.data.userscriptManager = { broken: true };
  assert.equal(await h.host.intercept(request(url, { tabId: 42 })), false, 'an unreadable library fails closed');
  h.state.data.userscriptManager = libraryOf([]);
  assert.equal(await h.host.intercept(request('https://scripts.test/a.js', { tabId: 43 })), false);
  const before = h.state.tabUpdates.length;
  h.state.hooks.request(request(url, { tabId: 44 }));
  for (let i = 0; i < 200 && h.state.tabUpdates.length === before; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.state.tabUpdates.at(-1).tabId, 44, 'the registered listener routes to interception');
});
