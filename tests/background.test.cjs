const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const clone = value => JSON.parse(JSON.stringify(value));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const ids = manifest.declarative_net_request.rule_resources.map(rule => rule.id);
const policyText = fs.readFileSync(path.join(root, 'rules/threat-policy.json'), 'utf8');

function harness(initial = {}, limit = 5000, now = '2026-10-18T04:00:00Z', session = {}) {
  const listeners = {};
  const state = { session, storage: clone(initial), enabled: manifest.declarative_net_request.rule_resources.filter(rule => rule.enabled).map(rule => rule.id), dynamic: [], scripts: [], badge: '', faults: {} };
  Object.assign(state, { now: Date.parse(now), policyText, alarms: {}, fetches: [],
    cosmeticText: JSON.stringify({ hide: { 'example.com': ['.ad-box', '#banner'], 'news.example': ['.promo'] },
      allow: { 'shop.example.com': ['.ad-box'] } }) });
  class Clock extends Date { static now() { return state.now; } }
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  async function fault(key) {
    await tick();
    if (state.faults[key]) { state.faults[key]--; throw new Error(`Injected ${key} failure`); }
  }
  const api = {
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`, getManifest: () => manifest,
      onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    alarms: {
      onAlarm: event('alarm'),
      async get(name) { await tick(); return state.alarms[name]; },
      async create(name, options) { await fault('alarm'); state.alarms[name] = { scheduledTime: options.when || state.now + 3600000, ...options }; },
      async clear(name) { delete state.alarms[name]; }
    },
    storage: { local: {
      async get(keys) { await tick(); return clone(Object.fromEntries(keys.filter(k => k in state.storage).map(k => [k, state.storage[k]]))); },
      async set(value) { await fault('save'); Object.assign(state.storage, clone(value)); }
    }, session: {
      async get(key) { await tick(); return key in state.session ? clone({ [key]: state.session[key] }) : {}; },
      async set(value) { await fault('session'); Object.assign(state.session, clone(value)); },
      async remove(key) { await tick(); delete state.session[key]; }
    } },
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_RULES: limit,
      onRuleMatchedDebug: event('ruleMatched'),
      async getEnabledRulesets() { await tick(); return clone(state.enabled); },
      async getDynamicRules() {
        await tick();
        const rules = clone(state.dynamic);
        if (state.nullReadback) for (const rule of rules) {
          rule.action.redirect = null;
          rule.condition.urlFilter = null;
          rule.condition.excludedRequestDomains = null;
        }
        return rules;
      },
      async updateEnabledRulesets({ enableRulesetIds, disableRulesetIds }) {
        await fault('static');
        state.enabled = [...new Set([...state.enabled.filter(id => !disableRulesetIds.includes(id)), ...enableRulesetIds])];
      },
      async updateDynamicRules({ removeRuleIds, addRules }) {
        await fault('dynamic');
        if (state.faults.ignoreDynamic) { state.faults.ignoreDynamic--; return; }
        state.dynamic = clone([...state.dynamic.filter(rule => !removeRuleIds.includes(rule.id)), ...addRules]);
        if (state.expireOnDynamic) { state.now = Date.parse('2026-11-30T00:00:00Z'); state.expireOnDynamic = false; }
      },
      async setExtensionActionOptions() {}
    },
    scripting: {
      async getRegisteredContentScripts() {
        await tick();
        // Firefox echoes packaged files as full extension URLs.
        return clone(state.scripts).map(script => state.fullUrlScripts
          ? { ...script, js: script.js.map(file => `chrome-extension://test/${file}`) } : script);
      },
      async registerContentScripts(scripts) {
        await fault('scripts');
        if (scripts.some(script => state.scripts.some(existing => existing.id === script.id))) throw new Error('Duplicate script ID');
        state.scripts.push(...clone(scripts));
      },
      async unregisterContentScripts({ ids }) {
        await fault('scripts');
        state.scripts = state.scripts.filter(script => !ids.includes(script.id));
      }
    },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText({ text }) { state.badge = text; } }
  };
  const context = vm.createContext({ chrome: api, URL, console, Date: Clock, setTimeout: fn => setImmediate(fn), fetch: async url => {
    if (url === 'chrome-extension://test/rules/community-cosmetic.json') {
      state.fetches.push(url);
      await fault('cosmetic');
      return { ok: true, json: async () => JSON.parse(state.cosmeticText) };
    }
    assert.equal(url, 'chrome-extension://test/rules/threat-policy.json', 'only a packaged local file may be read');
    state.fetches.push(url);
    await fault('policy');
    return { ok: true, text: async () => state.policyText };
  } });
  for (const file of ['shared.js', 'background.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const ready = vm.runInContext('operationQueue', context);
  const send = async (message, sender = { id: 'test', url: 'chrome-extension://test/popup.html' }) => { await ready; return new Promise(resolve => {
    const retained = listeners.message(clone(message), sender, response => resolve(clone(response)));
    if (!retained) resolve(undefined);
  }); };
  return { state, send, ready, shared: context.BlockAds, listeners };
}

test('domain canonicalization accepts URLs and IDN while rejecting filter injection', () => {
  const { shared } = harness();
  for (const [input, expected] of [
    ['  https://WWW.Example.COM:8443/path?q=x#part  ', 'example.com'],
    ['bücher.example', 'xn--bcher-kva.example'], ['example.com.', 'example.com'],
    ['127.0.0.1:8080', '127.0.0.1'], ['localhost', 'localhost']
  ]) assert.equal(shared.normalizeDomain(input), expected);
  for (const value of ['', '*example.com', 'example.com^', 'a|b.test', 'user:pass@example.test',
    'https://user@example.test', 'ftp://example.test', 'exa mple.test', '-bad.test', 'bad..test',
    'https://[::1]/', 'a'.repeat(64) + '.test', 'example\\.test']) {
    assert.throws(() => shared.normalizeDomain(value), undefined, value);
  }
  assert.equal(shared.whitelistScope('shop.example.test', ['shop.example.test', 'example.test']), 'example.test');
  assert.equal(shared.whitelistScope('badexample.test', ['example.test']), '');
});

test('first run applies all settings and verifies actual browser rule state', async () => {
  const h = harness();
  const response = await h.send({ type: 'GET_STATE' });
  assert.equal(response.ok, true);
  assert.deepEqual(h.state.enabled.sort(), ids.slice().sort());
  assert.equal(h.state.storage.protectionError, null);
  assert.deepEqual(response.settings.customBlockedDomains, []);
});

test('overlapping independent switches and domain additions are not lost', async () => {
  const h = harness();
  const responses = await Promise.all([
    h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false } } }),
    h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { trackers_ruleset: false } } }),
    h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'one.example' }),
    h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'two.example' })
  ]);
  assert.ok(responses.every(r => r.ok));
  assert.deepEqual(h.state.enabled.sort(), ['community_ruleset', 'threats_ruleset']);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['one.example', 'two.example']);
  assert.equal(h.state.dynamic.length, 2);
});

test('IDN entries become DNR-compatible and a rejected entry cannot poison later edits', async () => {
  const h = harness();
  assert.equal((await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'bücher.example' })).ok, true);
  const rejected = await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'example.test^' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /not applied/i);
  assert.equal((await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'valid.example' })).ok, true);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['valid.example', 'xn--bcher-kva.example']);
  assert.ok(h.state.dynamic.every(rule => rule.condition.requestDomains && !rule.condition.urlFilter));
});

test('old invalid saved domains are preserved visibly without preventing valid protection', async () => {
  const h = harness({ customBlockedDomains: ['broken^', 'bücher.example', 'good.example'] });
  const response = await h.send({ type: 'GET_STATE' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.quarantinedDomains, ['customBlockedDomains: broken^']);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['good.example', 'xn--bcher-kva.example']);
  assert.equal((await h.send({ type: 'GET_STATE' })).quarantinedDomains.length, 1);
});

test('Firefox null optional fields are equivalent to omitted fields during verification', async () => {
  const h = harness();
  h.state.nullReadback = true;
  const response = await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'working.example' });
  assert.equal(response.ok, true);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['working.example']);
  assert.equal(h.state.dynamic.length, 1);
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
});

test('resuming an inherited site exception removes all matching ancestors, preserving neighbors', async () => {
  const h = harness({ whitelistedDomains: ['example.test', 'shop.example.test', 'neighbor.test'] });
  await h.send({ type: 'GET_STATE' });
  const response = await h.send({ type: 'SET_SITE_PAUSED', domain: 'shop.example.test', paused: false });
  assert.equal(response.ok, true);
  assert.deepEqual(response.settings.whitelistedDomains, ['neighbor.test']);
  assert.equal(h.state.dynamic.length, 2);
});

for (const failure of ['dynamic', 'static', 'scripts', 'save', 'ignoreDynamic']) {
  test(`${failure} failure is visible and restores previously verified rules and settings`, async () => {
    const h = harness();
    await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'original.example' });
    const before = clone(h.state);
    h.state.faults[failure] = 1;
    const response = await h.send({ type: 'UPDATE_SETTINGS', patch: {
      customBlockedDomains: ['new.example'], rulesets: { ads_ruleset: false }
    } });
    assert.equal(response.ok, false);
    assert.deepEqual(h.state.dynamic, before.dynamic);
    assert.deepEqual(h.state.scripts, before.scripts);
    assert.deepEqual(h.state.enabled.sort(), before.enabled.sort());
    assert.deepEqual(h.state.storage.customBlockedDomains, before.storage.customBlockedDomains);
    assert.deepEqual(h.state.storage.rulesets, before.storage.rulesets);
    assert.equal(h.state.badge, '!');
    assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
    assert.equal(h.state.storage.protectionError, null);
  });
}

test('failure of rollback itself explicitly reports unverified protection', async () => {
  const h = harness();
  await h.send({ type: 'GET_STATE' });
  h.state.faults.static = 1;
  // Allow the new dynamic rules, then fail the rollback that removes them.
  const originalSend = h.state.dynamic;
  h.state.faults.dynamic = 0;
  const pending = h.send({ type: 'UPDATE_SETTINGS', patch: { customBlockedDomains: ['new.example'], rulesets: { ads_ruleset: false } } });
  while (h.state.dynamic === originalSend) await new Promise(resolve => setImmediate(resolve));
  h.state.faults.dynamic = 1;
  const response = await pending;
  assert.equal(response.ok, false);
  assert.match(response.error, /could not be verified/);
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
  assert.deepEqual(h.state.dynamic, []);
});

test('master pause clears network rules, restart reconciliation restores saved selection', async () => {
  const h = harness();
  await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'one.example' });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false, rulesets: { ads_ruleset: false } } });
  assert.deepEqual(h.state.dynamic, []);
  assert.deepEqual(h.state.enabled, []);
  assert.equal(h.state.badge, 'OFF');
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } });
  h.state.enabled = [];
  h.state.dynamic = [];
  await h.listeners.startup();
  assert.deepEqual(h.state.enabled.sort(), ['community_ruleset', 'threats_ruleset', 'trackers_ruleset']);
  assert.equal(h.state.dynamic.length, 1);
});

test('untrusted callers, malformed patches and quota violations cannot change settings', async () => {
  const h = harness({}, 2);
  await h.send({ type: 'GET_STATE' });
  for (const sender of [{ id: 'other', url: 'chrome-extension://test/popup.html' }, { id: 'test', url: 'https://example.test/' }]) {
    assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } }, sender)).ok, false);
  }
  for (const patch of [{ enabled: 'false' }, { rulesets: { typo: false } }, { extra: true }, { customBlockedDomains: 'bad' }]) {
    assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch })).ok, false);
  }
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { customBlockedDomains: ['a.test', 'b.test', 'c.test'] } })).ok, false);
  assert.equal(h.state.storage.enabled, true);
  assert.deepEqual(h.state.dynamic, []);
});

test('cosmetic state respects a cross-origin top-page exception using browser sender metadata', async () => {
  const h = harness({ whitelistedDomains: ['parent.example'] });
  const frame = { id: 'test', url: 'https://child.example/frame', tab: { id: 1, url: 'https://shop.parent.example/' } };
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, frame), { ok: true, enabled: false, ads: false, siteSelectors: [] });
  const other = { ...frame, tab: { id: 1, url: 'https://unrelated.example/' } };
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE', domain: 'parent.example' }, other), { ok: true, enabled: true, ads: true, siteSelectors: [] });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: false } });
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, other), { ok: true, enabled: false, ads: true, siteSelectors: [] });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: true, rulesets: { ads_ruleset: false } } });
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, other), { ok: true, enabled: true, ads: false, siteSelectors: [] });
  assert.equal((await h.send({ type: 'GET_COSMETIC_STATE' }, { ...frame, id: 'external' })).ok, false);
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } }, frame)).ok, false);
});

test('upgrading to the reviewed catalog retires the old malware toggle and preserves valid preferences', async () => {
  const h = harness({ rulesets: { ads_ruleset: false, trackers_ruleset: true, malware_ruleset: true } });
  const result = await h.send({ type: 'GET_STATE' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.rulesets, { ads_ruleset: false, trackers_ruleset: true, threats_ruleset: true, community_ruleset: true });
  assert.deepEqual(h.state.enabled.sort(), ['community_ruleset', 'threats_ruleset', 'trackers_ruleset']);
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { malware_ruleset: true } } })).ok, false);
});

test('intentional global pause survives startup, install/update events, and a new worker', async () => {
  const saved = { enabled: false, rulesets: { ads_ruleset: false, trackers_ruleset: true },
    customBlockedDomains: ['saved.example'], whitelistedDomains: ['paused.example'] };
  for (const event of ['startup', 'installed']) {
    const h = harness(saved);
    await h.listeners[event]();
    assert.equal(h.state.storage.enabled, false);
    assert.deepEqual(h.state.enabled, []);
    assert.deepEqual(h.state.dynamic, []);
    assert.equal(h.state.badge, 'OFF');
    assert.deepEqual(h.state.storage.customBlockedDomains, saved.customBlockedDomains);
    const restarted = harness(h.state.storage);
    assert.equal((await restarted.send({ type: 'GET_STATE' })).settings.enabled, false);
    assert.deepEqual(restarted.state.enabled, []);
  }
});

test('stale active rules are removed when saved intent is paused', async () => {
  const h = harness({ enabled: false });
  h.state.enabled = [...ids];
  h.state.dynamic = [{ id: 1, priority: 50, action: { type: 'block' }, condition: { requestDomains: ['stale.example'], resourceTypes: ['script'] } }];
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
  assert.deepEqual(h.state.enabled, []);
  assert.deepEqual(h.state.dynamic, []);
  assert.equal(h.state.storage.enabled, false);
});

test('worker wake checks packaged evidence and restores missing expiry alarms without a popup', async () => {
  const h = harness();
  await h.ready;
  assert.equal(h.state.storage.threatStatus.available, true);
  assert.equal(h.state.storage.threatStatus.count, 24);
  assert.equal(h.state.alarms['reported-threats-expiry'].scheduledTime, Date.parse('2026-11-30T00:00:00Z'));
  assert.equal(h.state.alarms['reported-threats-check'].periodInMinutes, 60);
  h.state.alarms = {};
  await h.listeners.startup();
  assert.ok(h.state.alarms['reported-threats-expiry']);
  assert.ok(h.state.fetches.length >= 2);
});

test('expiry alarm disables reported threats at the boundary without changing saved preferences or neighbors', async () => {
  const h = harness({ customBlockedDomains: ['custom.example'] }, 5000, '2026-11-29T23:59:59Z');
  await h.ready;
  assert.ok(h.state.enabled.includes('threats_ruleset'));
  h.state.now = Date.parse('2026-11-30T00:00:00Z');
  await h.listeners.alarm({ name: 'reported-threats-expiry' });
  assert.deepEqual(h.state.enabled.sort(), ['ads_ruleset', 'community_ruleset', 'trackers_ruleset']);
  assert.equal(h.state.dynamic.length, 1);
  assert.equal(h.state.storage.rulesets.threats_ruleset, true);
  assert.equal(h.state.storage.threatStatus.available, false);
  assert.equal(h.state.alarms['reported-threats-expiry'], undefined);
});

test('an expired bundle cannot be re-enabled by startup, upgrade or a settings request', async () => {
  const h = harness({}, 5000, '2026-12-01T00:00:00Z');
  h.state.enabled = [...ids];
  await h.ready;
  for (const event of ['startup', 'installed']) await h.listeners[event]();
  const result = await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { threats_ruleset: true } } });
  assert.equal(result.ok, true);
  assert.equal(result.threatStatus.available, false);
  assert.deepEqual(h.state.enabled.sort(), ['ads_ruleset', 'community_ruleset', 'trackers_ruleset']);
});

test('explicit threat-layer pause survives a worker restart and later reconciliation', async () => {
  const h = harness({ rulesets: { threats_ruleset: false } });
  await h.ready;
  assert.equal(h.state.enabled.includes('threats_ruleset'), false);
  const next = harness(h.state.storage);
  await next.ready;
  await next.listeners.alarm({ name: 'reported-threats-check' });
  assert.equal(next.state.enabled.includes('threats_ruleset'), false);
});

test('malformed, missing and future evidence disables only the threat layer and exposes a retryable error', async () => {
  const h = harness({ customBlockedDomains: ['custom.example'] });
  await h.ready;
  const baseline = JSON.parse(policyText);
  for (const text of ['{}', '{', 'x'.repeat(4097), JSON.stringify({ ...baseline, extra: true }),
    JSON.stringify({ ...baseline, reviewedAt: '2099-01-01T00:00:00Z' }),
    JSON.stringify({ ...baseline, expiresAt: '2027-01-01T00:00:00Z' }),
    JSON.stringify({ ...baseline, evidenceFrom: '2026-09-31T00:00:00Z' })]) {
    h.state.policyText = text;
    const result = await h.send({ type: 'GET_STATE' });
    assert.equal(result.threatStatus.available, false);
    assert.match(result.threatStatus.error, /inactive/);
    assert.deepEqual(h.state.enabled.sort(), ['ads_ruleset', 'community_ruleset', 'trackers_ruleset']);
    assert.equal(h.state.dynamic.length, 1);
    assert.equal(h.state.badge, '!');
  }
  h.state.policyText = policyText;
  h.state.faults.policy = 1;
  assert.equal((await h.send({ type: 'GET_STATE' })).threatStatus.available, false);
  assert.equal((await h.send({ type: 'GET_STATE' })).threatStatus.available, true);
});

test('failure to schedule expiry prevents threat activation, while a retry recovers', async () => {
  const h = harness();
  await h.ready;
  h.state.alarms = {};
  h.state.faults.alarm = 1;
  const result = await h.send({ type: 'GET_STATE' });
  assert.match(result.threatStatus.error, /alarm failure/);
  assert.equal(h.state.enabled.includes('threats_ruleset'), false);
  assert.equal((await h.send({ type: 'GET_STATE' })).threatStatus.available, true);
});

test('crossing expiry during an edit and storage rollback never restores expired threat rules', async () => {
  const h = harness({ customBlockedDomains: ['original.example'] });
  await h.ready;
  h.state.expireOnDynamic = true;
  h.state.faults.save = 1;
  const result = await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'new.example' });
  assert.equal(result.ok, false);
  assert.equal(h.state.enabled.includes('threats_ruleset'), false);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['original.example']);
  assert.equal(h.state.dynamic.length, 1);
  assert.equal((await h.send({ type: 'GET_STATE' })).threatStatus.available, false);
});

test('YouTube page filter is registered only while the ad layer is active', async () => {
  const h = harness();
  await h.ready;
  assert.equal(h.state.scripts.length, 1);
  const [script] = h.state.scripts;
  assert.deepEqual(script.matches, ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*']);
  assert.deepEqual(script.js, ['youtube.js']);
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal('excludeMatches' in script, false);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false } } });
  assert.deepEqual(h.state.scripts, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: true } } });
  assert.equal(h.state.scripts.length, 1);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
  assert.deepEqual(h.state.scripts, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } });
  h.state.scripts = [];
  await h.listeners.startup();
  assert.equal(h.state.scripts.length, 1, 'startup restores a missing registration');
});

test('pausing YouTube excludes only the paused YouTube scope from the page filter', async () => {
  const h = harness();
  await h.ready;
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'unrelated.example', paused: true });
  assert.equal('excludeMatches' in h.state.scripts[0], false);
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'https://www.youtube.com/watch?v=x', paused: true });
  assert.deepEqual(h.state.scripts[0].excludeMatches, ['*://*.youtube.com/*']);
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: false });
  assert.equal('excludeMatches' in h.state.scripts[0], false);
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'music.youtube.com', paused: true });
  assert.deepEqual(h.state.scripts[0].excludeMatches, ['*://*.music.youtube.com/*']);
});

test('page filter verification accepts full extension URLs in readback', async () => {
  const h = harness();
  h.state.fullUrlScripts = true;
  await h.ready;
  const result = await h.send({ type: 'GET_STATE' });
  assert.equal(result.ok, true);
  assert.equal(h.state.scripts.length, 1);
});

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const youtubeTab = { id: 'test', url: 'https://www.youtube.com/watch?v=x', tab: { id: 7, url: 'https://www.youtube.com/watch?v=x' } };

test('activity log records blocks with layer, server, path and site, but not site-pause allows', async () => {
  const h = harness({ customBlockedDomains: ['custom.example'], whitelistedDomains: ['paused.example'] });
  await h.ready;
  const allow = h.state.dynamic.find(rule => rule.action.type !== 'block');
  const block = h.state.dynamic.find(rule => rule.action.type === 'block');
  h.listeners.ruleMatched({ rule: { ruleId: 1005, rulesetId: 'ads_ruleset' },
    request: { url: 'https://political-effort.com/a/b.js?token=secret', type: 'script', tabId: 3, initiator: 'https://uukanshu.cc' } });
  // Firefox reports the page as documentUrl rather than initiator.
  h.listeners.ruleMatched({ rule: { ruleId: block.id, rulesetId: '_dynamic' },
    request: { url: 'https://custom.example/x.png', type: 'image', tabId: 3, documentUrl: 'https://news.example/page' } });
  h.listeners.ruleMatched({ rule: { ruleId: allow.id, rulesetId: '_dynamic' }, request: { url: 'https://paused.example/', type: 'main_frame', tabId: 4 } });
  await settle();
  const { entries } = await h.send({ type: 'GET_LOG' });
  const blocked = entries.filter(entry => entry.kind === 'blocked').map(({ time, ...entry }) => entry);
  assert.deepEqual(blocked, [
    { kind: 'blocked', layer: 'Ads', ruleId: 1005, host: 'political-effort.com', path: '/a/b.js', type: 'script', site: 'uukanshu.cc', tabId: 3 },
    { kind: 'blocked', layer: 'Custom block', ruleId: block.id, host: 'custom.example', path: '/x.png', type: 'image', site: 'news.example', tabId: 3 }
  ]);
  assert.ok(!JSON.stringify(entries).includes('secret'), 'query strings are not stored');
  assert.equal(h.state.session.activityLog.length, entries.length, 'log is saved to session storage');
});

test('settings changes and failures are logged as events, and only the newest 1000 entries are kept', async () => {
  const h = harness();
  await h.ready;
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false }, cosmeticFiltering: false } });
  await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'shady.example' });
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'www.news.example', paused: true });
  h.state.faults.dynamic = 1;
  await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'fails.example' });
  await settle();
  let { entries } = await h.send({ type: 'GET_LOG' });
  assert.deepEqual(entries.slice(0, 4).map(entry => entry.message),
    ['Ads layer turned off', 'Cosmetic hiding turned off', 'Custom block added shady.example', 'Paused on news.example']);
  assert.equal(entries[4].kind, 'error');
  assert.match(entries[4].message, /not applied.*Injected dynamic failure/);
  for (let i = 0; i < 1005; i++) {
    h.listeners.ruleMatched({ rule: { ruleId: 1, rulesetId: 'trackers_ruleset' }, request: { url: `https://t.example/${i}.js`, type: 'script', tabId: 1 } });
  }
  await settle();
  entries = (await h.send({ type: 'GET_LOG' })).entries;
  assert.equal(entries.length, 1000);
  assert.equal(entries.at(-1).path, '/1004.js');
  assert.equal(entries[0].path, '/5.js');
});

test('only extension pages read or clear the log; content scripts add only fixed events', async () => {
  const h = harness();
  await h.ready;
  for (const type of ['GET_LOG', 'CLEAR_LOG']) assert.equal((await h.send({ type }, youtubeTab)).ok, false);
  await h.send({ type: 'LOG_EVENT', event: 'youtube-ad-skipped' }, youtubeTab);
  await h.send({ type: 'LOG_EVENT', event: 'free-text', message: 'injected' }, youtubeTab);
  await h.send({ type: 'LOG_EVENT', event: 'toString' }, youtubeTab);
  await h.send({ type: 'LOG_EVENT', event: 'youtube-ad-skipped' }, { ...youtubeTab, id: 'other-extension' });
  await h.send({ type: 'LOG_EVENT', event: 'youtube-ad-skipped' });
  await settle();
  const { entries } = await h.send({ type: 'GET_LOG' });
  assert.deepEqual(entries.map(entry => [entry.message, entry.site]), [['Skipped a YouTube video ad that reached the player', 'www.youtube.com']]);
  assert.deepEqual((await h.send({ type: 'CLEAR_LOG' })).entries, []);
  assert.equal('activityLog' in h.state.session, false);
  assert.deepEqual((await h.send({ type: 'GET_LOG' })).entries, []);
});

test('the log survives a service-worker restart within the browser session', async () => {
  const first = harness();
  await first.ready;
  await first.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'kept.example' });
  await settle();
  const restarted = harness(first.state.storage, 5000, undefined, first.state.session);
  await restarted.ready;
  assert.deepEqual((await restarted.send({ type: 'GET_LOG' })).entries.map(entry => entry.message), ['Custom block added kept.example']);
});

test('a log storage failure never affects protection changes', async () => {
  const h = harness();
  await h.ready;
  h.state.faults.session = 100;
  const result = await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'still.example' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['still.example']);
  assert.equal(h.state.dynamic.length, 1);
});

test('per-site pop-up blocking registers the page script only for chosen sites, respecting pauses and the master switch', async () => {
  const h = harness();
  await h.ready;
  const popupScript = () => h.state.scripts.find(script => script.id === 'popup-blocker');
  assert.equal(popupScript(), undefined);
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'https://www.uukanshu.cc/book/1.html', blocked: true })).ok, true);
  await h.send({ type: 'SET_SITE_POPUPS', domain: '127.0.0.1', blocked: true });
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'localhost', blocked: true });
  assert.deepEqual(popupScript().matches, ['*://127.0.0.1/*', '*://localhost/*', '*://*.uukanshu.cc/*']);
  assert.deepEqual([popupScript().js, popupScript().world, popupScript().runAt], [['popups.js'], 'MAIN', 'document_start']);
  // The pop-up blocker does not depend on the ad layer.
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false } } });
  assert.deepEqual(h.state.scripts.map(script => script.id), ['popup-blocker']);
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'm.uukanshu.cc', paused: true });
  assert.deepEqual(popupScript().excludeMatches, ['*://*.m.uukanshu.cc/*']);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
  assert.deepEqual(h.state.scripts, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } });
  assert.ok(popupScript());
  // Turning it off from a subdomain removes the parent entry that covered it.
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'read.uukanshu.cc', blocked: false });
  assert.deepEqual(h.state.storage.popupBlockedDomains, ['127.0.0.1', 'localhost']);
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'x.example', blocked: 'yes' })).ok, false);
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'bad^host', blocked: true })).ok, false);
});

test('pop-up block reports are logged only from sites with pop-up blocking', async () => {
  const h = harness({ popupBlockedDomains: ['uukanshu.cc'] });
  await h.ready;
  const tab = url => ({ id: 'test', url, tab: { id: 9, url } });
  await h.send({ type: 'LOG_EVENT', event: 'popup-blocked', host: 'Political-Effort.com' }, tab('https://www.uukanshu.cc/book/1.html'));
  await h.send({ type: 'LOG_EVENT', event: 'popup-blocked', host: 'spoof.example' }, tab('https://other.example/'));
  await h.send({ type: 'LOG_EVENT', event: 'popup-blocked', host: '<b>not a host</b>' }, tab('https://www.uukanshu.cc/'));
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'shady.example', blocked: true });
  await settle();
  const { entries } = await h.send({ type: 'GET_LOG' });
  assert.deepEqual(entries.map(entry => [entry.message, entry.site ?? '']), [
    ['Blocked a pop-up to political-effort.com', 'www.uukanshu.cc'],
    ['Blocked a pop-up', 'www.uukanshu.cc'],
    ['Pop-up blocking turned on for shady.example', '']
  ]);
});

test('community site hiding rules follow the frame host, its parents and exceptions, and the layer switches', async () => {
  const h = harness();
  await h.ready;
  const frame = url => ({ id: 'test', url, tab: { id: 1, url } });
  const state = async url => (await h.send({ type: 'GET_COSMETIC_STATE' }, frame(url))).siteSelectors;
  assert.deepEqual((await state('https://www.example.com/a')).sort(), ['#banner', '.ad-box']);
  assert.deepEqual(await state('https://shop.example.com/'), ['#banner'], 'an exception on a subdomain removes that selector');
  assert.deepEqual(await state('https://news.example/'), ['.promo']);
  assert.deepEqual(await state('https://example.org/'), []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: false } } });
  assert.deepEqual(await state('https://www.example.com/a'), []);
  assert.equal(h.state.enabled.includes('community_ruleset'), false);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: true }, cosmeticFiltering: false } });
  assert.deepEqual(await state('https://www.example.com/a'), [], 'cosmetic switch also governs list hiding rules');
  assert.ok(h.state.enabled.includes('community_ruleset'));
});

test('an unreadable site hiding file disables only list hiding rules, and a later request retries', async () => {
  const h = harness();
  await h.ready;
  const frame = { id: 'test', url: 'https://www.example.com/', tab: { id: 1, url: 'https://www.example.com/' } };
  h.state.faults.cosmetic = 1;
  const failed = await h.send({ type: 'GET_COSMETIC_STATE' }, frame);
  assert.deepEqual([failed.ok, failed.enabled, failed.siteSelectors], [true, true, []]);
  assert.equal((await h.send({ type: 'GET_COSMETIC_STATE' }, frame)).siteSelectors.length, 2);
});

test('always-allowed domains become allow rules that outrank list blocks but not reported threats or custom blocks', async () => {
  const h = harness();
  await h.ready;
  assert.equal((await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'https://translate.googleapis.com/translate_a/element.js' })).ok, true);
  const allow = h.state.dynamic.find(rule => rule.action.type === 'allow');
  assert.deepEqual(allow.condition.requestDomains, ['translate.googleapis.com']);
  assert.equal(allow.condition.resourceTypes.length, 12);
  // Above every list rule (1-3, including community $important), below reported threats (5) and custom blocks (50).
  assert.equal(allow.priority, 4);
  const threatPriority = JSON.parse(fs.readFileSync(path.join(root, 'rules/threats.json'), 'utf8'))[0].priority;
  assert.ok(allow.priority < threatPriority);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
  assert.deepEqual(h.state.dynamic, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } });
  assert.equal(h.state.dynamic.length, 1);
  await h.send({ type: 'REMOVE_ALLOWED_DOMAIN', domain: 'translate.googleapis.com' });
  assert.deepEqual(h.state.dynamic, []);
  await settle();
  const { entries, allowedDomains } = await h.send({ type: 'GET_LOG' });
  assert.deepEqual(allowedDomains, []);
  assert.deepEqual(entries.map(entry => entry.message).filter(message => /allowed/.test(message)),
    ['Always allowed translate.googleapis.com', 'No longer always allowed translate.googleapis.com']);
});

test('the same domain cannot be both custom-blocked and always allowed', async () => {
  const h = harness();
  await h.ready;
  await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'both.example' });
  const rejected = await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'www.both.example' });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /both\.example is in both/);
  assert.deepEqual(h.state.storage.allowedDomains ?? [], []);
  await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'other.example' });
  assert.equal((await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'other.example' })).ok, false);
  assert.deepEqual(h.state.storage.customBlockedDomains, ['both.example']);
  assert.deepEqual((await h.send({ type: 'GET_LOG' })).allowedDomains, ['other.example']);
  assert.equal((await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'bad^host' })).ok, false);
});

test('lists-page removals are exact, unlike Resume which also removes covering parents', async () => {
  const h = harness({ whitelistedDomains: ['example.com', 'shop.example.com', 'other.example'],
    popupBlockedDomains: ['uukanshu.cc', 'm.uukanshu.cc'] });
  await h.ready;
  await h.send({ type: 'REMOVE_PAUSED_SITE', domain: 'shop.example.com' });
  assert.deepEqual(h.state.storage.whitelistedDomains, ['example.com', 'other.example']);
  await h.send({ type: 'REMOVE_POPUP_SITE', domain: 'm.uukanshu.cc' });
  assert.deepEqual(h.state.storage.popupBlockedDomains, ['uukanshu.cc']);
  // The popup's Resume on a subdomain still removes the parent that covers it.
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'news.example.com', paused: false });
  assert.deepEqual(h.state.storage.whitelistedDomains, ['other.example']);
  assert.equal((await h.send({ type: 'REMOVE_POPUP_SITE', domain: 'bad^host' })).ok, false);
  assert.equal((await h.send({ type: 'REMOVE_PAUSED_SITE', domain: 'x.example' }, youtubeTab)).ok, false, 'only extension pages may edit lists');
});

test('allowing a domain covered by a custom-blocked parent is refused, but allowing a parent of a blocked child is fine', async () => {
  const h = harness({ customBlockedDomains: ['blocked-parent.example', 'ads.allowed-parent.example'] });
  await h.ready;
  const covered = await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'cdn.blocked-parent.example' });
  assert.equal(covered.ok, false);
  assert.match(covered.error, /covered by the custom block on blocked-parent\.example/);
  assert.equal((await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'allowed-parent.example' })).ok, true);
  // Reported threats (5) still outrank the allow list (4).
  const threatPriority = JSON.parse(fs.readFileSync(path.join(root, 'rules/threats.json'), 'utf8'))[0].priority;
  const community = JSON.parse(fs.readFileSync(path.join(root, 'rules/community.json'), 'utf8'));
  assert.ok(Math.max(...community.map(rule => rule.priority)) < 4 && threatPriority === 5);
});

test('the activity log stays readable when settings cannot be loaded', async () => {
  const h = harness();
  await h.ready;
  h.state.storage.allowedDomains = ['same.example'];
  h.state.storage.customBlockedDomains = ['same.example'];
  const response = await h.send({ type: 'GET_LOG' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.allowedDomains, []);
});
