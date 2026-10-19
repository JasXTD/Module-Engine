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

function harness(initial = {}, limit = 5000, now = '2026-10-18T04:00:00Z') {
  const listeners = {};
  const state = { storage: clone(initial), enabled: manifest.declarative_net_request.rule_resources.filter(rule => rule.enabled).map(rule => rule.id), dynamic: [], scripts: [], badge: '', faults: {} };
  Object.assign(state, { now: Date.parse(now), policyText, alarms: {}, fetches: [] });
  class Clock extends Date { static now() { return state.now; } }
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  async function fault(key) {
    await tick();
    if (state.faults[key]) { state.faults[key]--; throw new Error(`Injected ${key} failure`); }
  }
  const api = {
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`,
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
    } },
    declarativeNetRequest: {
      MAX_NUMBER_OF_DYNAMIC_RULES: limit,
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
  const context = vm.createContext({ chrome: api, URL, console, Date: Clock, fetch: async url => {
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
  assert.deepEqual(h.state.enabled, ['threats_ruleset']);
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
  assert.deepEqual(h.state.enabled.sort(), ['threats_ruleset', 'trackers_ruleset']);
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
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, frame), { ok: true, enabled: false, ads: false });
  const other = { ...frame, tab: { id: 1, url: 'https://unrelated.example/' } };
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE', domain: 'parent.example' }, other), { ok: true, enabled: true, ads: true });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: false } });
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, other), { ok: true, enabled: false, ads: true });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: true, rulesets: { ads_ruleset: false } } });
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, other), { ok: true, enabled: true, ads: false });
  assert.equal((await h.send({ type: 'GET_COSMETIC_STATE' }, { ...frame, id: 'external' })).ok, false);
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } }, frame)).ok, false);
});

test('upgrading to the reviewed catalog retires the old malware toggle and preserves valid preferences', async () => {
  const h = harness({ rulesets: { ads_ruleset: false, trackers_ruleset: true, malware_ruleset: true } });
  const result = await h.send({ type: 'GET_STATE' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.settings.rulesets, { ads_ruleset: false, trackers_ruleset: true, threats_ruleset: true });
  assert.deepEqual(h.state.enabled, ['trackers_ruleset', 'threats_ruleset']);
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
  assert.deepEqual(h.state.enabled, ['ads_ruleset', 'trackers_ruleset']);
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
  assert.deepEqual(h.state.enabled, ['ads_ruleset', 'trackers_ruleset']);
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
    assert.deepEqual(h.state.enabled, ['ads_ruleset', 'trackers_ruleset']);
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
