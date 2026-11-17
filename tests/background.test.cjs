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

function harness(initial = {}, limit = 5000, now = '2026-10-18T04:00:00Z', session = {}, options = {}) {
  const listeners = {};
  const state = { session, storage: clone(initial), enabled: manifest.declarative_net_request.rule_resources.filter(rule => rule.enabled).map(rule => rule.id), dynamic: [], scripts: [], executions: [], removedTabs: [], badge: '', faults: {} };
  Object.assign(state, { now: Date.parse(now), policyText, alarms: {}, fetches: [], tabs: { 1: { id:1, url:'https://www.example.com/page' } },
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
    tabs: {
      onCreated: event('tabCreated'), onUpdated: event('tabUpdated'), onRemoved: event('tabRemoved'),
      async get(id) { await fault('tabRead'); if (!state.tabs[id]) throw new Error('Missing tab'); return clone(state.tabs[id]); },
      async update(id, patch) { await tick(); Object.assign(state.tabs[id], patch); return clone(state.tabs[id]); },
      async remove(id) { await fault('tabRemove'); state.removedTabs.push(id); delete state.tabs[id]; listeners.tabRemoved?.(id); }
    },
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`, getManifest: () => manifest,
      onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    alarms: {
      onAlarm: event('alarm'),
      async get(name) { await tick(); return state.alarms[name]; },
      async create(name, options) { await fault('alarm'); state.alarms[name] = { scheduledTime: options.when || state.now + 3600000, ...options }; },
      async clear(name) { delete state.alarms[name]; }
    },
    storage: { onChanged: event('storageChanged'), local: {
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
      async getEnabledRulesets() { await fault('enabledRead'); return clone(state.enabled); },
      async getSessionRules() { await fault('sessionRulesRead'); return clone(state.sessionRules || []); },
      async getDisabledRuleIds({ rulesetId }) { await fault('disabledRead'); return clone(state.disabledRules?.[rulesetId] || []); },
      async getDynamicRules() {
        await fault('dynamicRead');
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
        if (state.expireOnDynamic) { state.now = Date.parse('2027-02-28T00:00:00Z'); state.expireOnDynamic = false; }
      },
      async setExtensionActionOptions() {}
    },
    webRequest: { onResponseStarted: event('response'), onBeforeRequest: event('beforeRequest'), onErrorOccurred: event('requestError') },
    scripting: {
      async executeScript(options) {
        await fault('executeScript');
        state.executions.push(clone(options));
        if (options.files?.includes('src/blocking/picker.js')) return [{ frameId:0, result:true }];
        return [];
      },
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
      async updateContentScripts(scripts) {
        await fault('scripts');
        if (scripts.some(script => !state.scripts.some(existing => existing.id === script.id))) throw new Error('Missing script ID');
        state.scripts = state.scripts.map(existing => {
          const result = { ...existing, ...clone(scripts.find(script => script.id === existing.id) || {}) };
          if (!result.excludeMatches?.length) delete result.excludeMatches;
          return result;
        });
      },
      async unregisterContentScripts({ ids }) {
        await fault('scripts');
        state.scripts = state.scripts.filter(script => !ids.includes(script.id));
      }
    },
    action: { async setBadgeBackgroundColor() {}, async setBadgeText({ text }) { state.badge = text; } }
  };
  if (options.noRuleFeedback) delete api.declarativeNetRequest.onRuleMatchedDebug;
  if (options.firefox) {
    api.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    delete api.declarativeNetRequest.onRuleMatchedDebug;
    api.declarativeNetRequest.testMatchOutcome = () => { throw new Error('Firefox feedback is disabled'); };
  }
  const context = vm.createContext({ chrome: api, URL, TextEncoder, crypto:require('node:crypto').webcrypto, console, Date: Clock, setTimeout: fn => setImmediate(fn), clearTimeout: clearImmediate, fetch: async url => {
    if (url === 'chrome-extension://test/rules/community-cosmetic.json') {
      state.fetches.push(url);
      await fault('cosmetic');
      return { ok: true, json: async () => JSON.parse(state.cosmeticText) };
    }
    const ruleset = manifest.declarative_net_request.rule_resources.find(item => url === 'chrome-extension://test/' + item.path);
    if (ruleset) {
      await fault('ruleFile');
      return { ok: true, json: async () => clone(options.rulesets?.[ruleset.id] || JSON.parse(fs.readFileSync(path.join(root, ruleset.path), 'utf8'))) };
    }
    assert.equal(url, 'chrome-extension://test/rules/threat-policy.json', 'only a packaged local file may be read');
    state.fetches.push(url);
    await fault('policy');
    return { ok: true, text: async () => state.policyText };
  } });
  for (const file of manifest.background.scripts) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const ready = vm.runInContext('operationQueue', context);
  const send = async (message, sender = { id: 'test', url: 'chrome-extension://test/src/ui/popup/popup.html' }) => { await ready; return new Promise(resolve => {
    const retained = listeners.message(clone(message), sender, response => resolve(clone(response)));
    if (!retained) resolve(undefined);
  }); };
  return { state, send, ready, shared: context.BlockAds, listeners, api };
}

test('modules preserve ad blocking and saved settings when userscript access is missing', async () => {
  const h = harness({customBlockedDomains:['keep.example'],customCosmeticFilters:'example.test##.kept'});
  await h.ready;
  const before = clone({enabled:h.state.enabled,dynamic:h.state.dynamic,scripts:h.state.scripts});
  const modules = await h.send({type:'MODULES_GET'});
  assert.equal(modules.modules[0].active,true);
  assert.equal(modules.modules[1].enabled,false);
  assert.equal((await h.send({type:'MODULE_SET',id:'userscripts',enabled:true})).ok,false);
  assert.deepEqual({enabled:h.state.enabled,dynamic:h.state.dynamic,scripts:h.state.scripts},before);
  assert.equal(h.state.storage.customCosmeticFilters,'example.test##.kept');
  assert.equal((await h.send({type:'GET_STATE'})).ok,true);
});
test('every module and script management command requires an extension page', async () => {
  const h=harness();
  for(const type of ['MODULES_GET','MODULE_SET','US_LIST','US_SAVE','US_ENABLE','US_DELETE','US_MENU_LIST','US_MENU_RUN','US_PREPARE_ASSETS','US_CANCEL_ASSETS','US_ASSET_READ','US_FETCH_SOURCE','US_CHECK_UPDATE','US_CANCEL_SOURCE','US_APPLY_SOURCE']) {
    for(const sender of [{id:'test',url:'https://example.test/',tab:{id:1}},{id:'other',url:'chrome-extension://test/src/ui/manager/manager.html'}]) {
      assert.equal((await h.send({type,id:'blocking',enabled:false},sender)).ok,false);
    }
  }
  assert.equal(h.state.storage.enabled,true);
});
test('ad module pause does not change the userscript library', async () => {
  const h=harness();
  const source='// ==UserScript==\n// @name Local\n// @match https://example.test/*\n// ==/UserScript==\nvoid 0;';
  const saved=await h.send({type:'US_SAVE',source});
  assert.equal(saved.ok,true);
  const library=clone(h.state.storage.userscriptManager);
  assert.equal((await h.send({type:'MODULE_SET',id:'blocking',enabled:false})).ok,true);
  assert.deepEqual(h.state.storage.userscriptManager,library);
  assert.deepEqual(h.state.enabled,[]);
  assert.equal((await h.send({type:'MODULE_SET',id:'blocking',enabled:true})).ok,true);
  assert.deepEqual(h.state.storage.userscriptManager,library);
});

test('network filter defaults migrate without changing existing rules or preferences', async () => {
  const h=harness({enabled:false,customBlockedDomains:['kept.example'],customCosmeticFilters:'example.test##.kept'});
  const response=await h.send({type:'GET_STATE'});
  assert.equal(response.ok,true);
  assert.equal(response.settings.customNetworkFilters,'');
  assert.equal(response.settings.enabled,false);
  assert.equal(response.settings.customCosmeticFilters,'example.test##.kept');
  assert.deepEqual(response.settings.customBlockedDomains,['kept.example']);
  assert.deepEqual(h.state.dynamic,[]);
});
test('custom network saves serialize with other editors and refuse a stale base', async () => {
  const h=harness();
  const text='||www.cdn.example.test/promoted/*$script,domain=news.example.test';
  const results=await Promise.all([
    h.send({type:'SAVE_NETWORK_FILTERS',previous:'',text}),
    h.send({type:'SAVE_NETWORK_FILTERS',previous:'',text:'||other.example.test^'}),
    h.send({type:'SAVE_COSMETIC_FILTERS',previous:'',text:'news.example.test##.card'})
  ]);
  assert.deepEqual(results.map(value=>value.ok),[true,false,true]);
  assert.match(results[1].error,/another window/);
  assert.equal(h.state.storage.customNetworkFilters,text);
  assert.equal(h.state.storage.customCosmeticFilters,'news.example.test##.card');
  assert.equal(h.state.dynamic.length,1);
  assert.deepEqual(h.state.dynamic[0].condition.initiatorDomains,['news.example.test']);
});
test('network filters keep extension-only authority and reject invalid saves atomically', async () => {
  const h=harness();
  const command={type:'SAVE_NETWORK_FILTERS',previous:'',text:'||example.test^'};
  for(const sender of [{id:'test',url:'https://example.test/',tab:{id:1}}, {id:'other',url:'chrome-extension://test/src/ui/lists/lists.html'}]) {
    assert.equal((await h.send(command,sender)).ok,false);
  }
  assert.equal((await h.send({type:'UPDATE_SETTINGS',patch:{customNetworkFilters:command.text}})).ok,false);
  for(const text of [null,'||valid.example.test^\n||bad.example.test^$redirect=noopjs','||example.test^$script,~script']) {
    assert.equal((await h.send({...command,text})).ok,false);
    assert.equal(h.state.storage.customNetworkFilters,'');
    assert.deepEqual(h.state.dynamic,[]);
  }
});
for(const fault of ['dynamic','save','ignoreDynamic']) test('network filter '+fault+' failure restores the prior filters and permits retry', async () => {
  const old='||old.example.test^',next='||new.example.test/path*$image';
  const h=harness({customNetworkFilters:old,customBlockedDomains:['kept.example']});
  await h.ready;
  const previous=clone(h.state.dynamic);
  h.state.faults[fault]=1;
  const response=await h.send({type:'SAVE_NETWORK_FILTERS',previous:old,text:next});
  assert.equal(response.ok,false);
  assert.equal(h.state.storage.customNetworkFilters,old);
  assert.deepEqual(h.state.dynamic,previous);
  assert.equal((await h.send({type:'SAVE_NETWORK_FILTERS',previous:old,text:next})).ok,true);
  assert.equal(h.state.storage.customNetworkFilters,next);
});
test('network rules share the browser quota with domain rules and preserve the last verified state', async () => {
  const h=harness({customBlockedDomains:['kept.example'],customNetworkFilters:'||one.example.test^'},2);
  await h.ready;
  const previous=clone(h.state.dynamic);
  const response=await h.send({type:'SAVE_NETWORK_FILTERS',previous:'||one.example.test^',text:'||one.example.test^\n||two.example.test^'});
  assert.equal(response.ok,false); assert.match(response.error,/limit 2/);
  assert.deepEqual(h.state.dynamic,previous);
  assert.equal(h.state.storage.customNetworkFilters,'||one.example.test^');
});
test('network rules survive restart, respect master pause and stay independent of cosmetic and list switches', async () => {
  const text='||example.test/a*$script\n@@||example.test/allowed.js$script';
  const first=harness({customBlockedDomains:['kept.example'],customNetworkFilters:text});
  await first.ready;
  const expected=clone(first.state.dynamic);
  const h=harness(clone(first.state.storage)); await h.ready;
  assert.deepEqual(h.state.dynamic,expected);
  assert.equal((await h.send({type:'UPDATE_SETTINGS',patch:{enabled:false}})).ok,true);
  assert.deepEqual(h.state.dynamic,[]);
  assert.equal(h.state.storage.customNetworkFilters,text);
  assert.equal((await h.send({type:'UPDATE_SETTINGS',patch:{enabled:true,cosmeticFiltering:false,rulesets:Object.fromEntries(ids.map(id=>[id,false]))}})).ok,true);
  assert.deepEqual(h.state.dynamic,expected);
  assert.equal((await h.send({type:'SAVE_NETWORK_FILTERS',previous:text,text:''})).ok,true);
  assert.equal(h.state.dynamic.length,1);
  assert.deepEqual(h.state.dynamic[0].condition.requestDomains,['kept.example']);
});

const pickerSender = () => ({id:'test',url:'https://www.example.com/page',frameId:0,documentId:'document-one',tab:{id:1,url:'https://www.example.com/page'}});
async function openPicker(h) {
  assert.equal((await h.send({type:'START_PICKER',tabId:1})).ok,true);
  const session = await h.send({type:'GET_PICKER_SESSION'},pickerSender());
  assert.equal(session.ok,true);
  return session;
}
test('only the extension interface can start a picker on a supported active page', async () => {
  const h = harness();
  assert.equal((await h.send({type:'GET_PICKER_SESSION'},pickerSender())).ok,false);
  assert.equal((await h.send({type:'START_PICKER',tabId:1},pickerSender())).ok,false);
  for (const tabId of [null,-1,'1',2]) assert.equal((await h.send({type:'START_PICKER',tabId})).ok,false);
  h.state.tabs[1].url = 'file:///local.html';
  assert.equal((await h.send({type:'START_PICKER',tabId:1})).ok,false);
  assert.equal(h.state.executions.length,0);
});
test('picker sessions bind exact host, top frame, document, URL and short-lived authority', async () => {
  const h = harness(), session = await openPicker(h), sender = pickerSender();
  assert.equal(session.domain,'www.example.com');
  assert.deepEqual(h.state.executions.at(-1),{target:{tabId:1,frameIds:[0]},files:['src/blocking/cosmetic.js','src/blocking/picker-core.js','src/blocking/picker.js']});
  for (const altered of [{...sender,frameId:2},{...sender,documentId:'other'},{...sender,url:'https://other.example/'},{...sender,id:'other'}]) {
    assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'},altered)).ok,false);
  }
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:'wrong',selector:'.picked'},sender)).ok,false);
  for (const selector of ['.x\nother.example##body','.x {display:none}',':has-text(Ad)','.x[']) {
    assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector},sender)).ok,false);
  }
  h.state.tabs[1].url += '?changed';
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'},sender)).ok,false);
  h.state.tabs[1].url = sender.url;
  h.state.now += 600001;
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'},sender)).ok,false);
  assert.deepEqual(h.state.session.elementPickerSessions,{});
  assert.equal(h.state.storage.customCosmeticFilters,'');
});
test('picker append preserves concurrent editor changes and has exact site scope and idempotent retries', async () => {
  const h = harness({customCosmeticFilters:'example.net##.old'}), session=await openPicker(h), sender=pickerSender();
  const [edit,pick] = await Promise.all([
    h.send({type:'SAVE_COSMETIC_FILTERS',previous:'example.net##.old',text:'example.net##.old\nexample.net##.new'}),
    h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked',domain:'other.example'},sender)
  ]);
  assert.equal(edit.ok,true); assert.equal(pick.ok,true);
  assert.equal(h.state.storage.customCosmeticFilters,'example.net##.old\nexample.net##.new\nwww.example.com##.picked');
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'},sender)).alreadySaved,true);
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.different'},sender)).ok,false);
  const next=await openPicker(h);
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:next.token,selector:'.picked'},sender)).alreadySaved,true);
  assert.equal(h.state.storage.customCosmeticFilters.split('\n').length,3);
});
test('picker authority survives a worker restart but closing it prevents a later save', async () => {
  const first=harness(), session=await openPicker(first);
  const restarted=harness(clone(first.state.storage),5000,'2026-10-18T04:00:00Z',clone(first.state.session));
  assert.equal((await restarted.send({type:'GET_PICKER_SESSION'},pickerSender())).token,session.token);
  restarted.state.tabs[1].url = 'https://www.example.com/next-page';
  assert.equal((await restarted.send({type:'CLOSE_PICKER',token:session.token},pickerSender())).ok,true);
  assert.equal((await restarted.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'},pickerSender())).ok,false);
});
test('picker session storage stays bounded and retains recently reopened tabs', async () => {
  const h=harness();
  for (let id=1;id<=21;id++) {
    h.state.tabs[id]={id,url:'https://www.example.com/page'};h.state.now++;
    assert.equal((await h.send({type:'START_PICKER',tabId:id})).ok,true);
  }
  assert.equal(Object.keys(h.state.session.elementPickerSessions).length,20);
  assert.equal(h.state.session.elementPickerSessions[1],undefined);
  h.state.now++;await h.send({type:'START_PICKER',tabId:2});
  h.state.tabs[22]={id:22,url:'https://www.example.com/page'};h.state.now++;
  await h.send({type:'START_PICKER',tabId:22});
  assert.ok(h.state.session.elementPickerSessions[2]);
  assert.equal(h.state.session.elementPickerSessions[3],undefined);
});
test('failed injection, capability writes and settings saves leave custom filters intact', async () => {
  const h=harness();
  h.state.faults.executeScript=1;
  assert.equal((await h.send({type:'START_PICKER',tabId:1})).ok,false);
  assert.deepEqual(h.state.session.elementPickerSessions,{});
  const session=await openPicker(h), request={type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'};
  h.state.faults.session=1;
  assert.equal((await h.send(request,pickerSender())).ok,false);
  assert.equal(h.state.storage.customCosmeticFilters,'');
  h.state.faults.save=1;
  assert.equal((await h.send(request,pickerSender())).ok,false);
  assert.equal(h.state.storage.customCosmeticFilters,'');
  assert.equal((await h.send(request,pickerSender())).ok,true);
});
test('picker refuses paused hiding, exact exceptions and overflowing custom-rule limits', async () => {
  for (const initial of [{enabled:false},{cosmeticFiltering:false},{whitelistedDomains:['example.com']},{cosmeticPausedDomains:['example.com']}]) {
    assert.equal((await harness(initial).send({type:'START_PICKER',tabId:1})).ok,false);
  }
  const h=harness({customCosmeticFilters:'www.example.com#@#.picked'}), session=await openPicker(h);
  assert.equal((await h.send({type:'SAVE_PICKER_FILTER',token:session.token,selector:'.picked'},pickerSender())).ok,false);
  assert.equal(h.state.storage.customCosmeticFilters,'www.example.com#@#.picked');
  const full=Array.from({length:500},(_,i)=>'other.example##.rule'+i).join('\n');
  const capped=harness({customCosmeticFilters:full}), next=await openPicker(capped);
  assert.equal((await capped.send({type:'SAVE_PICKER_FILTER',token:next.token,selector:'.picked'},pickerSender())).ok,false);
  assert.equal(capped.state.storage.customCosmeticFilters,full);
});

test('advanced hiding is independent, validated and rolled back when saving fails', async () => {
  const h = harness({ customCosmeticFilters: 'example.com##.label:has-text(Sponsored):upward(1)' });
  const frame = { id: 'test', url: 'https://example.com/page', frameId: 0, tab: { id: 1, url: 'https://example.com/page' } };
  const initial = await h.send({ type: 'GET_COSMETIC_STATE' }, frame);
  assert.equal(initial.procedural, true);
  assert.equal(initial.proceduralRules.length, 1);
  const network = clone({ enabled: h.state.enabled, dynamic: h.state.dynamic, scripts: h.state.scripts });
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { proceduralFiltering: false } })).ok, true);
  const paused = await h.send({ type: 'GET_COSMETIC_STATE' }, frame);
  assert.equal(paused.procedural, false);
  assert.equal(paused.enabled, true);
  assert.deepEqual(clone({ enabled: h.state.enabled, dynamic: h.state.dynamic, scripts: h.state.scripts }), network);
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { proceduralFiltering: 'yes' } })).ok, false);
  h.state.faults.save = 1;
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { proceduralFiltering: true } })).ok, false);
  assert.equal((await h.send({ type: 'GET_COSMETIC_STATE' }, frame)).procedural, false);
});

test('cosmetic-only pauses restore embedded content without disabling network or video-ad protection', async () => {
  const h = harness();
  await h.send({ type: 'GET_STATE' });
  const networkBefore = clone({ enabled: h.state.enabled, dynamic: h.state.dynamic, scripts: h.state.scripts });
  const response = await h.send({ type: 'SET_SITE_COSMETICS', domain: 'parent.example', paused: true });
  assert.equal(response.ok, true);
  const frame = { id: 'test', url: 'https://child.example/frame', tab: { id: 1, url: 'https://shop.parent.example/' } };
  const cosmetic = await h.send({ type: 'GET_COSMETIC_STATE' }, frame);
  assert.equal(cosmetic.enabled, false);
  assert.equal(cosmetic.ads, true);
  assert.deepEqual({ enabled: h.state.enabled, dynamic: h.state.dynamic, scripts: h.state.scripts }, networkBefore);
  assert.equal((await h.send({ type: 'GET_COSMETIC_STATE' }, { ...frame, tab: { id: 1, url: 'https://other.example/' } })).enabled, true);
  await h.send({ type: 'SET_SITE_COSMETICS', domain: 'shop.parent.example', paused: false });
  assert.deepEqual(h.state.storage.cosmeticPausedDomains, []);
});

test('custom cosmetic saves are transactional and conflicting editors cannot overwrite one another', async () => {
  const h = harness();
  const first = 'example.com##.first';
  const responses = await Promise.all([
    h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: '', text: first }),
    h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: '', text: 'example.com##.second' })
  ]);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].ok, false);
  assert.match(responses[1].error, /another window/);
  assert.equal(h.state.storage.customCosmeticFilters, first);
  h.state.faults.save = 1;
  assert.equal((await h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: first, text: 'example.com##.third' })).ok, false);
  assert.equal(h.state.storage.customCosmeticFilters, first);
  assert.equal((await h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: first, text: '' })).ok, true);
});

test('custom rules reject content-script writers, injection and unrestricted setting patches', async () => {
  const h = harness();
  await h.send({ type: 'GET_STATE' });
  const sender = { id: 'test', url: 'https://example.com/', tab: { id: 1, url: 'https://example.com/' } };
  assert.equal((await h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: '', text: 'example.com##.ad' }, sender)).ok, false);
  assert.equal((await h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: '', text: 'example.com##.ad {color:red}' })).ok, false);
  assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { customCosmeticFilters: 'example.com##.ad' } })).ok, false);
  assert.equal(h.state.storage.customCosmeticFilters, '');
  assert.equal(h.state.enabled.includes('threats_ruleset'), true);
});

test('generic and custom cosmetics honor switches, list exceptions and browser-supplied frame hosts', async () => {
  const h = harness();
  h.state.cosmeticText = JSON.stringify({ hide: { 'example.com': ['.site'] }, allow: {}, generic: ['.generic'], disableGeneric: ['quiet.example.com'], disableAll: ['reader.example.com'] });
  await h.send({ type: 'SAVE_COSMETIC_FILTERS', previous: '', text: 'example.com##.custom\nexample.com#@#.generic' });
  const get = host => h.send({ type: 'GET_COSMETIC_STATE', domain: 'spoof.example' }, { id: 'test', url: `https://${host}/`, tab: { id: 1, url: 'https://top.example/' } });
  assert.deepEqual((await get('example.com')).siteSelectors, ['.site', '.custom']);
  assert.deepEqual((await get('example.com')).genericSelectors, []);
  assert.deepEqual((await get('other.example')).genericSelectors, ['.generic']);
  assert.equal((await get('quiet.example.com')).disableGeneric, true);
  assert.equal((await get('reader.example.com')).enabled, false);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { genericCosmeticFiltering: false } });
  assert.deepEqual((await get('other.example')).genericSelectors, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { community_ruleset: false } } });
  assert.deepEqual((await get('example.com')).siteSelectors, ['.custom']);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
  assert.equal((await get('example.com')).enabled, false);
});

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
    assert.deepEqual(h.state.scripts.toSorted((a, b) => a.id.localeCompare(b.id)), before.scripts.toSorted((a, b) => a.id.localeCompare(b.id)));
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
  for (const sender of [{ id: 'other', url: 'chrome-extension://test/src/ui/popup/popup.html' }, { id: 'test', url: 'https://example.test/' }]) {
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
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, frame), { ok: true, enabled: false, ads: false, siteSelectors: [], genericSelectors: [], exceptions: [], procedural: true, proceduralRules: [], flag: false, notificationPrompts: false, installPrompts: false, deceptiveButtons: false });
  const other = { ...frame, tab: { id: 1, url: 'https://unrelated.example/' } };
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE', domain: 'parent.example' }, other), { ok: true, enabled: true, ads: true, siteSelectors: [], genericSelectors: [], exceptions: [], procedural: true, proceduralRules: [], disableAll: false, disableGeneric: false, flag: true, notificationPrompts: true, installPrompts: true, deceptiveButtons: true });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: false } });
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, other), { ok: true, enabled: false, ads: true, siteSelectors: [], genericSelectors: [], exceptions: [], procedural: true, proceduralRules: [], flag: true, notificationPrompts: true, installPrompts: true, deceptiveButtons: true });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { cosmeticFiltering: true, rulesets: { ads_ruleset: false } } });
  assert.deepEqual(await h.send({ type: 'GET_COSMETIC_STATE' }, other), { ok: true, enabled: true, ads: false, siteSelectors: [], genericSelectors: [], exceptions: [], procedural: true, proceduralRules: [], disableAll: false, disableGeneric: false, flag: true, notificationPrompts: true, installPrompts: true, deceptiveButtons: true });
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
  assert.equal(h.state.alarms['reported-threats-expiry'].scheduledTime, Date.parse('2027-02-28T00:00:00Z'));
  assert.equal(h.state.alarms['reported-threats-check'].periodInMinutes, 60);
  h.state.alarms = {};
  await h.listeners.startup();
  assert.ok(h.state.alarms['reported-threats-expiry']);
  assert.ok(h.state.fetches.length >= 2);
});

test('expiry alarm disables reported threats at the boundary without changing saved preferences or neighbors', async () => {
  const h = harness({ customBlockedDomains: ['custom.example'] }, 5000, '2027-02-27T23:59:59Z');
  await h.ready;
  assert.ok(h.state.enabled.includes('threats_ruleset'));
  h.state.now = Date.parse('2027-02-28T00:00:00Z');
  await h.listeners.alarm({ name: 'reported-threats-expiry' });
  assert.deepEqual(h.state.enabled.sort(), ['ads_ruleset', 'community_ruleset', 'trackers_ruleset']);
  assert.equal(h.state.dynamic.length, 1);
  assert.equal(h.state.storage.rulesets.threats_ruleset, true);
  assert.equal(h.state.storage.threatStatus.available, false);
  assert.equal(h.state.alarms['reported-threats-expiry'], undefined);
});

test('an expired bundle cannot be re-enabled by startup, upgrade or a settings request', async () => {
  const h = harness({}, 5000, '2027-03-01T00:00:00Z');
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
    // One second beyond the 180-day evidence window.
    JSON.stringify({ ...baseline, expiresAt: '2027-02-28T00:00:01Z' }),
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

test('prompt protection migrates on without changing ad preferences and registers only the top document', async () => {
  const h = harness({ rulesets: { ads_ruleset: false }, cosmeticFiltering: false });
  const result = await h.send({ type: 'GET_STATE' });
  assert.equal(result.ok, true);
  assert.equal(result.settings.notificationPromptBlocking, true);
  assert.equal(result.settings.deceptivePromptBlocking, true);
  assert.equal(result.settings.rulesets.ads_ruleset, false);
  assert.equal(result.settings.cosmeticFiltering, false);
  assert.deepEqual(result.settings.promptAllowedDomains, []);
  const guard = h.state.scripts.find(script => script.id === 'notification-guard');
  assert.deepEqual(guard.matches, ['http://*/*', 'https://*/*']);
  assert.deepEqual(guard.js, ['src/blocking/notification-guard.js']);
  assert.equal(guard.world, 'MAIN'); assert.equal(guard.runAt, 'document_start');
  assert.equal(guard.allFrames, false, 'cross-origin top-page exceptions cannot be read by a frame registration');
  const frame = { id: 'test', url: 'https://child.example/', tab: { id: 1, url: 'https://top.example/' } };
  const page = await h.send({ type: 'GET_COSMETIC_STATE' }, frame);
  assert.equal(page.notificationPrompts, true); assert.equal(page.installPrompts, true); assert.equal(page.enabled, false);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { notificationPromptBlocking: false } });
  assert.equal(h.state.scripts.some(script => script.id === 'notification-guard'), false);
  assert.equal((await h.send({ type: 'GET_COSMETIC_STATE' }, frame)).installPrompts, true);
});

test('prompt exceptions inherit parent scopes, remove exact list entries, and preserve network filtering', async () => {
  const h = harness({ promptAllowedDomains: ['parent.example', 'shop.parent.example', 'neighbor.example'], customBlockedDomains: ['blocked.example'] });
  await h.ready;
  const network = clone(h.state.dynamic);
  const guard = () => h.state.scripts.find(script => script.id === 'notification-guard');
  assert.ok(guard().excludeMatches.includes('*://*.parent.example/*'));
  const frame = { id: 'test', url: 'https://child.example/', tab: { id: 1, url: 'https://shop.parent.example/' } };
  let state = await h.send({ type: 'GET_COSMETIC_STATE' }, frame);
  assert.equal(state.notificationPrompts, false); assert.equal(state.installPrompts, false); assert.equal(state.ads, true);
  state = await h.send({ type: 'GET_COSMETIC_STATE', domain: 'parent.example' }, { ...frame, tab: { id: 1, url: 'https://other.example/' } });
  assert.equal(state.notificationPrompts, true, 'page-supplied hostname cannot create an exception');
  await h.send({ type: 'REMOVE_PROMPT_SITE', domain: 'shop.parent.example' });
  assert.deepEqual(h.state.storage.promptAllowedDomains, ['neighbor.example', 'parent.example']);
  await h.send({ type: 'SET_SITE_PROMPTS', domain: 'shop.parent.example', allowed: false });
  assert.deepEqual(h.state.storage.promptAllowedDomains, ['neighbor.example']);
  await h.send({ type: 'SET_SITE_PROMPTS', domain: 'https://www.trusted.example/path', allowed: true });
  assert.ok(guard().excludeMatches.includes('*://*.trusted.example/*'));
  assert.deepEqual(h.state.dynamic, network);
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'top.example', paused: true });
  assert.ok(guard().excludeMatches.includes('*://*.top.example/*'));
  const paused = await h.send({ type: 'GET_COSMETIC_STATE' }, { ...frame, tab: { id: 1, url: 'https://top.example/' } });
  assert.equal(paused.notificationPrompts, false); assert.equal(paused.installPrompts, false);
});

test('button protection migrates on, follows trusted native frame/top exceptions, and remains independent of cosmetics and ads', async () => {
  const h = harness({cosmeticFiltering:false,notificationPromptBlocking:false,deceptivePromptBlocking:false});
  await h.ready;
  const frame={id:'test',url:'https://child.example/',tab:{id:1,url:'https://shop.parent.example/'}};
  const state=() => h.send({type:'GET_COSMETIC_STATE'},frame);
  assert.equal((await h.send({type:'GET_STATE'})).settings.deceptiveButtonBlocking,true);
  assert.equal((await state()).deceptiveButtons,true);
  const network=clone(h.state.dynamic), rules=clone(h.state.enabled);
  await h.send({type:'UPDATE_SETTINGS',patch:{deceptiveButtonBlocking:false}});
  assert.equal((await state()).deceptiveButtons,false);
  assert.deepEqual(h.state.dynamic,network);assert.deepEqual(h.state.enabled,rules);
  await h.send({type:'UPDATE_SETTINGS',patch:{deceptiveButtonBlocking:true,promptAllowedDomains:['parent.example']}});
  assert.equal((await state()).deceptiveButtons,false);assert.equal((await state()).ads,true);
  await h.send({type:'UPDATE_SETTINGS',patch:{promptAllowedDomains:['child.example']}});
  assert.equal((await state()).deceptiveButtons,false);
  await h.send({type:'UPDATE_SETTINGS',patch:{promptAllowedDomains:[]}});
  assert.equal((await h.send({type:'GET_COSMETIC_STATE',domain:'parent.example'},frame)).deceptiveButtons,true);
  assert.equal((await h.send({type:'UPDATE_SETTINGS',patch:{deceptiveButtonBlocking:false}},frame)).ok,false);
  assert.equal((await h.send({type:'UPDATE_SETTINGS',patch:{deceptiveButtonBlocking:'yes'}})).ok,false);
  h.state.faults.save=1;
  assert.equal((await h.send({type:'UPDATE_SETTINGS',patch:{deceptiveButtonBlocking:false}})).ok,false);
  assert.equal((await state()).deceptiveButtons,true);
  await h.send({type:'UPDATE_SETTINGS',patch:{enabled:false}});
  assert.equal((await state()).deceptiveButtons,false);
});

test('only extension pages can change prompt protection and invalid values fail visibly', async () => {
  const h = harness(); await h.ready;
  const frame = { id: 'test', url: 'https://page.example/', tab: { id: 1 } };
  for (const message of [
    { type: 'SET_SITE_PROMPTS', domain: 'page.example', allowed: true },
    { type: 'REMOVE_PROMPT_SITE', domain: 'page.example' },
    { type: 'UPDATE_SETTINGS', patch: { notificationPromptBlocking: false, deceptivePromptBlocking: false } }
  ]) assert.equal((await h.send(message, frame)).ok, false);
  for (const message of [
    { type: 'SET_SITE_PROMPTS', domain: 'page.example', allowed: 'yes' },
    { type: 'SET_SITE_PROMPTS', domain: '*.example', allowed: true },
    { type: 'UPDATE_SETTINGS', patch: { notificationPromptBlocking: 1 } },
    { type: 'UPDATE_SETTINGS', patch: { deceptivePromptBlocking: null } }
  ]) assert.equal((await h.send(message)).ok, false);
  assert.deepEqual(h.state.storage.promptAllowedDomains, []);
  assert.equal(h.state.storage.notificationPromptBlocking, true);
  assert.equal(h.state.storage.deceptivePromptBlocking, true);
});

for (const fault of ['scripts', 'save']) test(`prompt ${fault} update failure restores notification registration and ads`, async () => {
  const h = harness({ customBlockedDomains: ['kept.example'] }); await h.ready;
  const before = clone(h.state);
  h.state.faults[fault] = 1;
  const result = await h.send({ type: 'SET_SITE_PROMPTS', domain: 'new.example', allowed: true });
  assert.equal(result.ok, false);
  assert.deepEqual(h.state.scripts, before.scripts);
  assert.deepEqual(h.state.dynamic, before.dynamic);
  assert.deepEqual(h.state.enabled, before.enabled);
  assert.deepEqual(h.state.storage.promptAllowedDomains, []);
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
});

test('YouTube page filter is registered only while the ad layer is active', async () => {
  const h = harness();
  await h.ready;
  assert.equal(h.state.scripts.length, 2);
  const [script] = h.state.scripts;
  assert.deepEqual(script.matches, ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*']);
  assert.deepEqual(script.js, ['src/blocking/youtube.js']);
  assert.equal(script.world, 'MAIN');
  assert.equal(script.runAt, 'document_start');
  assert.equal('excludeMatches' in script, false);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false } } });
  assert.deepEqual(h.state.scripts.map(script => script.id), ['notification-guard']);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: true } } });
  assert.equal(h.state.scripts.length, 2);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
  assert.deepEqual(h.state.scripts, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } });
  h.state.scripts = [];
  await h.listeners.startup();
  assert.equal(h.state.scripts.length, 2, 'startup restores a missing registration');
});

test('unrelated page-script changes never unregister the YouTube filter, including rollback', async () => {
  const h = harness(); await h.ready;
  const writes = [];
  for (const method of ['registerContentScripts', 'updateContentScripts', 'unregisterContentScripts']) {
    const original = h.api.scripting[method];
    h.api.scripting[method] = async args => {
      writes.push({ method, args: clone(args) });
      assert.ok(h.state.scripts.some(script => script.id === 'youtube-ads'), 'filter present before every asynchronous write');
      const result = await original(args);
      assert.ok(h.state.scripts.some(script => script.id === 'youtube-ads'), 'filter present after every asynchronous write');
      return result;
    };
  }
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'owned.example', blocked: true })).ok, true);
  assert.equal((await h.send({ type: 'SET_SITE_PROMPTS', domain: 'owned.example', allowed: true })).ok, true);
  h.state.faults.save = 1;
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'second.example', blocked: true })).ok, false);
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'owned.example', blocked: false })).ok, true);
  assert.ok(writes.length >= 5);
  assert.ok(writes.every(write => !JSON.stringify(write.args).includes('youtube-ads')), 'unchanged registration is never written');
});

test('YouTube pause updates in place, clears exclusions on resume and rolls back failed saves', async () => {
  const h = harness(); await h.ready;
  const writes = [];
  const update = h.api.scripting.updateContentScripts;
  h.api.scripting.updateContentScripts = async scripts => { writes.push(clone(scripts)); return update(scripts); };
  h.api.scripting.unregisterContentScripts = async () => { throw Error('Must update in place'); };
  assert.equal((await h.send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: true })).ok, true);
  assert.equal((await h.send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: false })).ok, true);
  assert.deepEqual(writes.at(-1).find(script => script.id === 'youtube-ads').excludeMatches, [], 'empty array explicitly clears native exclusions');
  h.state.faults.save = 1;
  assert.equal((await h.send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: true })).ok, false);
  assert.ok(!h.state.scripts.find(script => script.id === 'youtube-ads').excludeMatches?.length);
  h.state.faults.scripts = 1;
  assert.equal((await h.send({ type: 'SET_SITE_PAUSED', domain: 'youtube.com', paused: true })).ok, false);
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
});

test('startup replaces root-level script registrations while preserving saved settings and userscript data', async () => {
  const h = harness();
  await h.ready;
  assert.equal((await h.send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'ads.example.test' })).ok, true);
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'media.example.test', blocked: true })).ok, true);
  const saved = await h.send({ type: 'US_SAVE', source: '// ==UserScript==\n// @name Kept during relocation\n// @match https://example.test/*\n// @grant GM.getValue\n// ==/UserScript==\nvoid 0;' });
  assert.equal(saved.ok, true);
  h.state.storage.userscriptManager.scripts[0].values = { kept: 'owned fixture' };
  const before = clone({ storage: h.state.storage, scripts: h.state.scripts, enabled: h.state.enabled, dynamic: h.state.dynamic });
  h.state.scripts = h.state.scripts.map(script => ({ ...script, js: script.js.map(file => path.posix.basename(file)) }));
  h.state.fullUrlScripts = true;
  await h.listeners.startup();
  assert.deepEqual(h.state.scripts, before.scripts, 'all native paths are replaced, retaining their IDs, scope and timing');
  assert.deepEqual(h.state.storage, before.storage, 'preferences, saved scripts and GM values remain intact');
  assert.deepEqual(h.state.enabled, before.enabled);
  assert.deepEqual(h.state.dynamic, before.dynamic);
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
  assert.equal(h.state.scripts.length, 2);
});

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

function popupNavigation(h, tabId = 20, changes = {}, requestChanges = {}) {
  const tab = { id: tabId, openerTabId: 1, url: 'about:blank', status: 'loading', pinned: false, ...changes };
  h.state.tabs[tabId] = tab;
  h.listeners.tabCreated?.(clone(tab));
  const request = { tabId, frameId: 0, type: 'main_frame', requestId: String(tabId), url: 'https://blocked.example/ad', ...requestChanges };
  h.listeners.beforeRequest?.(request);
  const rule = { rulesetId: '_dynamic', ruleId: h.state.dynamic.find(item => item.action.type === 'block')?.id };
  return { tab, request, match: () => h.listeners.ruleMatched?.({ rule, request }),
    fail: () => h.listeners.requestError?.({ ...request, error: 'net::ERR_BLOCKED_BY_CLIENT' }) };
}

for (const order of ['match-first', 'error-first']) test('blocked popup cleanup correlates native events: ' + order, async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popup = popupNavigation(h);
  if (order === 'match-first') { popup.match(); await settle(); popup.fail(); }
  else { popup.fail(); await settle(); popup.match(); }
  await settle();
  assert.deepEqual(h.state.removedTabs, [20]);
  assert.ok(h.state.tabs[1], 'the opener stays open');
  popup.match(); popup.fail(); await settle();
  assert.deepEqual(h.state.removedTabs, [20], 'duplicate events cannot close twice');
  const logs = (await h.send({ type: 'GET_LOG' })).entries;
  assert.equal(logs.filter(item => item.message?.startsWith('Closed a new pop-up')).length, 1);
});

for (const scenario of ['no-opener', 'pinned', 'expired', 'existing-tab', 'loaded-page', 'subresource',
  'next-navigation', 'changed-url', 'changed-pending-url', 'changed-opener', 'missing-match', 'missing-error', 'network-error', 'removed-tab']) {
  test('blocked popup cleanup preserves ' + scenario, async () => {
    const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
    const popup = popupNavigation(h, 20, scenario === 'no-opener' ? { openerTabId: undefined } : scenario === 'pinned' ? { pinned: true } : {});
    if (scenario === 'expired') h.state.now += 10001;
    if (scenario === 'existing-tab') h.listeners.tabRemoved(20);
    if (scenario === 'loaded-page') h.listeners.response({ ...popup.request, statusCode: 200 });
    if (scenario === 'subresource') { popup.request.type = 'script'; popup.request.frameId = 1; }
    if (scenario === 'next-navigation') h.listeners.beforeRequest({ ...popup.request, requestId: 'new-navigation' });
    if (scenario === 'changed-url') {
      popup.tab.url = 'https://ordinary.example/'; h.listeners.tabUpdated(20, { url: popup.tab.url }, clone(popup.tab));
    }
    if (scenario === 'changed-pending-url') popup.tab.pendingUrl = 'https://ordinary.example/';
    if (scenario === 'changed-opener') popup.tab.openerTabId = 3;
    if (scenario === 'removed-tab') { delete h.state.tabs[20]; h.listeners.tabRemoved(20); }
    if (scenario !== 'missing-match') popup.match();
    if (scenario === 'network-error') h.listeners.requestError({ ...popup.request, error: 'net::ERR_CONNECTION_REFUSED' });
    else if (scenario !== 'missing-error') popup.fail();
    await settle();
    assert.deepEqual(h.state.removedTabs, []);
  });
}

test('blocked popup cleanup verifies static block actions and rejects allow actions', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'], allowedDomains: ['allowed.example'] }); await h.ready;
  const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules/community.json'), 'utf8'));
  const staticBlock = rules.find(rule => rule.action.type === 'block'), staticAllow = rules.find(rule => rule.action.type === 'allow');
  assert.ok(staticBlock && staticAllow);
  for (const [tabId, rule] of [[20, { rulesetId: 'community_ruleset', ruleId: staticAllow.id }],
    [21, { rulesetId: '_dynamic', ruleId: h.state.dynamic.find(item => item.action.type === 'allow').id }],
    [22, { rulesetId: 'community_ruleset', ruleId: staticBlock.id }]]) {
    const popup = popupNavigation(h, tabId); popup.fail();
    h.listeners.ruleMatched({ rule, request: popup.request }); await settle();
  }
  assert.deepEqual(h.state.removedTabs, [22]);
});

test('blocked popup cleanup preserves a tab repurposed during its final read', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popup = popupNavigation(h), originalGet = h.api.tabs.get;
  h.api.tabs.get = async id => {
    const tab = await originalGet(id);
    if (id === 20) h.listeners.beforeRequest({ ...popup.request, requestId: 'new-navigation', url: 'https://ordinary.example/' });
    return tab;
  };
  popup.match(); popup.fail(); await settle();
  assert.deepEqual(h.state.removedTabs, []);
});

test('blocked popup cleanup invalidates pending evidence when network rules change', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popup = popupNavigation(h);
  popup.match(); await settle();
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } });
  popup.fail(); await settle();
  assert.deepEqual(h.state.removedTabs, []);
});

test('blocked popup cleanup supports an initial redirect without closing a loaded document', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popup = popupNavigation(h);
  h.listeners.response({ ...popup.request, statusCode: 302 });
  popup.request.url = 'https://blocked.example/redirected';
  h.listeners.beforeRequest(popup.request);
  popup.match(); popup.fail(); await settle();
  assert.deepEqual(h.state.removedTabs, [20]);
});

for (const fault of ['tabRead', 'tabRemove', 'ruleFile']) test('blocked popup cleanup fails safely on ' + fault + ' and recovers for later tabs', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  h.state.faults[fault] = 1;
  const first = popupNavigation(h);
  if (fault === 'ruleFile') h.listeners.ruleMatched({ rule: { rulesetId: 'community_ruleset', ruleId: 36 }, request: first.request });
  else first.match();
  first.fail(); await settle();
  assert.deepEqual(h.state.removedTabs, []);
  const second = popupNavigation(h, 21); second.match(); second.fail(); await settle();
  assert.deepEqual(h.state.removedTabs, [21]);
  assert.equal((await h.send({ type: 'GET_STATE' })).ok, true);
});

test('blocked popup cleanup bounds candidates and preserves tabs without native rule feedback', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popups = Array.from({ length: 65 }, (_, index) => popupNavigation(h, 20 + index));
  popups[0].match(); popups[0].fail(); popups[64].match(); popups[64].fail(); await settle();
  assert.deepEqual(h.state.removedTabs, [84]);
  const unsupported = harness({ customBlockedDomains: ['blocked.example'] }, 5000, '2026-10-18T04:00:00Z', {}, { noRuleFeedback: true });
  await unsupported.ready;
  assert.equal(unsupported.listeners.tabCreated, undefined);
  assert.equal((await unsupported.send({ type: 'GET_STATE' })).ok, true);
});

test('page messages cannot authorize blocked popup cleanup', async () => {
  const h = harness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  popupNavigation(h);
  await h.send({ type: 'CLOSE_BLOCKED_TAB', tabId: 20 }, { id: 'test', url: 'https://page.example/', tab: { id: 20 }, frameId: 0 });
  await settle();
  assert.deepEqual(h.state.removedTabs, []);
});

const firefoxHarness = (initial = {}, options = {}) => harness(initial, 5000, '2026-11-05T04:00:00Z', {}, { firefox: true, ...options });
const firefoxAbort = (h, popup) => h.listeners.requestError?.({ ...popup.request, method: 'GET', error: 'NS_ERROR_ABORT' });

test('Firefox closes a confirmed custom-domain block with debugging feedback unavailable', async () => {
  const h = firefoxHarness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popup = popupNavigation(h); firefoxAbort(h, popup); await settle();
  assert.deepEqual(h.state.removedTabs, [20]);
  assert.ok(h.state.tabs[1]);
});

test('Firefox confirms the bundled parent-domain main-frame block without visiting it', async () => {
  const h = firefoxHarness(); await h.ready;
  const popup = popupNavigation(h, 20, {}, { url: 'https://s.pemsrv.com/offline-fixture' });
  firefoxAbort(h, popup); await settle();
  assert.deepEqual(h.state.removedTabs, [20]);
});

for (const scenario of ['no-block', 'paused', 'site-exception', 'pinned', 'no-opener', 'loaded', 'new-navigation', 'expired', 'network-error']) {
  test('Firefox preserves aborted popup: ' + scenario, async () => {
    const h = firefoxHarness({ customBlockedDomains: scenario === 'no-block' ? [] : ['blocked.example'],
      enabled: scenario !== 'paused', whitelistedDomains: scenario === 'site-exception' ? ['blocked.example'] : [] }); await h.ready;
    const popup = popupNavigation(h, 20, scenario === 'pinned' ? { pinned: true } : scenario === 'no-opener' ? { openerTabId: undefined } : {});
    if (scenario === 'loaded') h.listeners.response({ ...popup.request, statusCode: 200 });
    if (scenario === 'new-navigation') h.listeners.beforeRequest?.({ ...popup.request, requestId: 'another' });
    if (scenario === 'expired') h.state.now += 10001;
    if (scenario === 'network-error') h.listeners.requestError?.({ ...popup.request, error: 'NS_ERROR_NET_RESET' });
    else firefoxAbort(h, popup);
    await settle(); assert.deepEqual(h.state.removedTabs, []);
  });
}

const fixtureRule = (id, type, priority, condition) => ({ id, priority, action: { type }, condition: { resourceTypes: ['main_frame'], ...condition } });
const fixtureRulesets = rules => Object.fromEntries(ids.map(id => [id, id === 'community_ruleset' ? rules : []]));
for (const [name, condition, url, closes] of [
  ['domain and subdomain', { requestDomains: ['BLOCKED.EXAMPLE'] }, 'https://sub.blocked.example/a', true],
  ['hostname boundary', { requestDomains: ['blocked.example'] }, 'https://notblocked.example/a', false],
  ['excluded destination', { requestDomains: ['example'], excludedRequestDomains: ['blocked.example'] }, 'https://blocked.example/a', false],
  ['domain anchor with path wildcard', { urlFilter: '||blocked.example/a*b^' }, 'https://sub.blocked.example/a12b?q=1', true],
  ['domain anchor cannot match a path', { urlFilter: '||blocked.example^' }, 'https://ordinary.example/blocked.example/', false],
  ['domain anchor cannot match a suffix lookalike', { urlFilter: '||blocked.example^' }, 'https://blocked.example.evil/a', false],
  ['domain anchor with port', { urlFilter: '||blocked.example^' }, 'https://blocked.example:8443/a', true],
  ['literal URL anchor', { urlFilter: '|https://blocked.example/ad|' }, 'https://blocked.example/ad', true],
  ['end anchor rejects suffix', { urlFilter: '|https://blocked.example/ad|' }, 'https://blocked.example/ads', false],
  ['unanchored separator', { urlFilter: '^tracking=1^' }, 'https://blocked.example/?tracking=1&x=2', true],
  ['separator at end', { urlFilter: 'ad^' }, 'https://blocked.example/ad', true],
  ['only the final separator may match URL end', { urlFilter: '/ad^^' }, 'https://blocked.example/ad', false],
  ['two separators with a consumed delimiter', { urlFilter: '/ad^^' }, 'https://blocked.example/ad?', true],
  ['separator excludes underscore', { urlFilter: 'ad^' }, 'https://blocked.example/ad_unit', false],
  ['separator excludes percent', { urlFilter: 'ad^' }, 'https://blocked.example/ad%20', false],
  ['case-insensitive default', { urlFilter: '/AD|' }, 'https://blocked.example/ad', true],
  ['case-sensitive match', { urlFilter: '/AD|', isUrlFilterCaseSensitive: true }, 'https://blocked.example/AD', true],
  ['case-sensitive rejection', { urlFilter: '/AD|', isUrlFilterCaseSensitive: true }, 'https://blocked.example/ad', false],
  ['POST-only rule', { requestMethods: ['post'] }, 'https://blocked.example/ad', false],
  ['excluded GET rule', { excludedRequestMethods: ['get'] }, 'https://blocked.example/ad', false],
  ['omitted resource types', { resourceTypes: undefined, requestDomains: ['blocked.example'] }, 'https://blocked.example/ad', false],
  ['subresource rule', { resourceTypes: ['image'], requestDomains: ['blocked.example'] }, 'https://blocked.example/ad', false],
  ['unknown party condition', { domainType: 'thirdParty', requestDomains: ['blocked.example'] }, 'https://blocked.example/ad', false],
  ['unknown initiator condition', { initiatorDomains: ['source.example'], requestDomains: ['blocked.example'] }, 'https://blocked.example/ad', false],
  ['unknown regex condition', { regexFilter: 'blocked\\.example' }, 'https://blocked.example/ad', false],
  ['future condition', { futureCondition: true, requestDomains: ['blocked.example'] }, 'https://blocked.example/ad', false],
  ['credentials', { requestDomains: ['blocked.example'] }, 'https://user:pass@blocked.example/ad', false],
  ['root dot', { requestDomains: ['blocked.example'] }, 'https://blocked.example./ad', false],
  ['bounded pattern work', { urlFilter: 'a*'.repeat(1000) }, 'https://blocked.example/' + 'a'.repeat(7000), false]
]) test('Firefox rule proof: ' + name, async () => {
  const h = firefoxHarness({}, { rulesets: fixtureRulesets([fixtureRule(1, 'block', 1, condition)]) }); await h.ready;
  const popup = popupNavigation(h, 20, {}, { url });
  firefoxAbort(h, popup); await settle();
  assert.deepEqual(h.state.removedTabs, closes ? [20] : []);
});

for (const [name, type, priority, condition, closes, blockPriority = 1] of [
  ['matching allow wins tie', 'allow', 1, { requestDomains: ['blocked.example'] }, false],
  ['higher allowAllRequests', 'allowAllRequests', 2, { requestDomains: ['blocked.example'] }, false],
  ['unrelated allow', 'allow', 2, { requestDomains: ['ordinary.example'] }, true],
  ['nonmatching URL allow', 'allow', 2, { urlFilter: '||ordinary.example/*' }, true],
  ['possibly matching regex allow', 'allow', 2, { regexFilter: 'blocked\\.example' }, false],
  ['possibly matching party allow', 'allow', 2, { domainType: 'thirdParty' }, false],
  ['possibly matching initiator allow', 'allow', 2, { initiatorDomains: ['source.example'] }, false],
  ['excluded-only resource scope can allow navigation', 'allow', 2, { resourceTypes: undefined, excludedResourceTypes: ['image'] }, false],
  ['future condition on allow', 'allow', 2, { futureCondition: true }, false],
  ['lower-priority unknown allow', 'allow', 1, { regexFilter: 'unknown' }, true, 2],
  ['possible redirect', 'redirect', 2, {}, false],
  ['header modification does not override a block', 'modifyHeaders', 2, {}, true]
]) test('Firefox rule precedence: ' + name, async () => {
  const h = firefoxHarness({}, { rulesets: fixtureRulesets([
    fixtureRule(1, 'block', blockPriority, { requestDomains: ['blocked.example'] }), fixtureRule(2, type, priority, condition)
  ]) }); await h.ready;
  const popup = popupNavigation(h); firefoxAbort(h, popup); await settle();
  assert.deepEqual(h.state.removedTabs, closes ? [20] : []);
});

for (const scenario of ['disabled-rule', 'disabled-ruleset', 'session-allow', 'missing-before-request', 'rules-changed', 'repurposed-during-read']) {
  test('Firefox checks native rule state and asynchronous invalidation: ' + scenario, async () => {
    const h = firefoxHarness({}, { rulesets: fixtureRulesets([fixtureRule(1, 'block', 1, { requestDomains: ['blocked.example'] })]) }); await h.ready;
    if (scenario === 'disabled-rule') h.state.disabledRules = { community_ruleset: [1] };
    if (scenario === 'disabled-ruleset') h.state.enabled = [];
    if (scenario === 'session-allow') h.state.sessionRules = [fixtureRule(2, 'allow', 2, { tabIds: [20] })];
    const before = h.listeners.beforeRequest;
    if (scenario === 'missing-before-request') delete h.listeners.beforeRequest;
    const popup = popupNavigation(h); h.listeners.beforeRequest = before;
    let release;
    if (scenario === 'rules-changed') {
      const get = h.api.declarativeNetRequest.getSessionRules;
      h.api.declarativeNetRequest.getSessionRules = async () => {
        const result = await get(); await new Promise(resolve => { release = resolve; }); return result;
      };
    }
    if (scenario === 'repurposed-during-read') {
      const get = h.api.declarativeNetRequest.getDynamicRules;
      h.api.declarativeNetRequest.getDynamicRules = async () => {
        const result = await get(); before({ ...popup.request, requestId: 'replacement' }); return result;
      };
    }
    firefoxAbort(h, popup);
    if (scenario === 'rules-changed') {
      await settle(); assert.equal(typeof release, 'function');
      assert.equal((await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } })).ok, true);
      release();
    }
    await settle(); assert.deepEqual(h.state.removedTabs, []);
  });
}

for (const fault of ['enabledRead', 'dynamicRead', 'sessionRulesRead', 'disabledRead', 'ruleFile']) {
  test('Firefox preserves the tab when cleanup cannot read ' + fault + ', then recovers', async () => {
    const h = firefoxHarness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
    h.state.faults[fault] = 1;
    const first = popupNavigation(h); firefoxAbort(h, first); await settle();
    assert.deepEqual(h.state.removedTabs, []);
    const second = popupNavigation(h, 21); firefoxAbort(h, second); await settle();
    assert.deepEqual(h.state.removedTabs, [21]);
  });
}

for (const action of ['allow', 'allowAllRequests']) test('Firefox preserves a redirect chain with an earlier ' + action, async () => {
  const h = firefoxHarness({}, { rulesets: fixtureRulesets([
    fixtureRule(1, 'block', 1, { requestDomains: ['blocked.example'] }),
    fixtureRule(2, action, 2, { requestDomains: ['initial.example'], requestMethods: ['post'] })
  ]) }); await h.ready;
  const popup = popupNavigation(h, 20, {}, { url: 'https://initial.example/start', method: 'POST' });
  h.listeners.response({ ...popup.request, statusCode: 303 });
  popup.request.url = 'https://blocked.example/ad'; h.listeners.beforeRequest(popup.request);
  firefoxAbort(h, popup); await settle();
  assert.deepEqual(h.state.removedTabs, []);
});

test('Firefox bounds redirect history while preserving the network block', async () => {
  const h = firefoxHarness({ customBlockedDomains: ['blocked.example'] }); await h.ready;
  const popup = popupNavigation(h);
  for (let i = 0; i < 9; i++) { popup.request.url = 'https://blocked.example/hop-' + i; h.listeners.beforeRequest(popup.request); }
  firefoxAbort(h, popup); await settle(); assert.deepEqual(h.state.removedTabs, []);
  assert.ok(h.state.dynamic.some(rule => rule.action.type === 'block'));
});
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

test('activity log omits allow and header-rule matches from packaged, dynamic and session rules', async () => {
  const h = harness({ popupBlockedDomains: ['video.example'] });
  await h.ready;
  const community = JSON.parse(fs.readFileSync(path.join(root, 'rules/community.json'), 'utf8'));
  const allow = community.find(rule => rule.action.type === 'allow'), block = community.find(rule => rule.action.type === 'block');
  const sandbox = h.state.dynamic.find(rule => rule.action.type === 'modifyHeaders');
  assert.ok(allow && block && sandbox);
  const request = { url: 'https://cdn.example/a.js', type: 'script', tabId: 3, initiator: 'https://news.example' };
  for (const rule of [{ rulesetId: 'community_ruleset', ruleId: allow.id }, { rulesetId: '_dynamic', ruleId: sandbox.id },
    { rulesetId: '_session', ruleId: 950000001 }, { rulesetId: 'community_ruleset', ruleId: block.id }]) h.listeners.ruleMatched({ rule, request });
  await settle();
  const { entries } = await h.send({ type: 'GET_LOG' });
  assert.deepEqual(entries.filter(entry => entry.kind === 'blocked').map(entry => [entry.layer, entry.ruleId]), [['Community lists', block.id]]);
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
  assert.deepEqual([popupScript().js, popupScript().world, popupScript().runAt], [['src/blocking/popups.js'], 'MAIN', 'document_start']);
  // The pop-up blocker does not depend on the ad layer.
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: { ads_ruleset: false } } });
  assert.deepEqual(h.state.scripts.map(script => script.id).sort(), ['notification-guard', 'popup-blocker']);
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

test('cross-origin frames receive the pop-up guard from browser sender metadata', async () => {
  const h = harness({ popupBlockedDomains: ['uukanshu.cc'] });
  await h.ready;
  const frame = { id: 'test', url: 'https://ads.shared.example/frame', frameId: 7,
    tab: { id: 9, url: 'https://www.uukanshu.cc/book/1.html' } };
  const result = await h.send({ type: 'GET_COSMETIC_STATE', installPopupGuard: true }, frame);
  assert.deepEqual([result.ok, result.popupGuard], [true, true]);
  assert.deepEqual(h.state.executions, [{
    target: { tabId: 9, frameIds: [7] }, files: ['src/blocking/popups.js'], world: 'MAIN'
  }]);
  await h.send({ type: 'GET_COSMETIC_STATE' }, { ...frame, frameId: 8, tab: { id: 9, url: 'https://other.example/' } });
  assert.equal(h.state.executions.length, 1, 'a frame outside the selected top site is not injected');
});

test('selected-site guard appends a browser sandbox without blocking media and follows site and master pauses', async () => {
  const h = harness(); await h.ready;
  const policy = () => h.state.dynamic.find(rule => rule.action.type === 'modifyHeaders');
  assert.equal(policy(), undefined);
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'player.example', blocked: true });
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'second.example', blocked: true });
  await h.send({ type: 'ADD_ALLOWED_DOMAIN', domain: 'player.example' });
  await h.send({ type: 'UPDATE_SETTINGS', patch: { rulesets: Object.fromEntries(ids.map(id => [id, false])) } });
  assert.deepEqual(policy().condition, { requestDomains: ['player.example', 'second.example'], resourceTypes: ['main_frame'] });
  assert.equal(h.state.dynamic.filter(rule => rule.action.type === 'modifyHeaders').length, 1, 'one bounded aggregate rule');
  assert.ok(policy().priority > h.state.dynamic.find(rule => rule.action.type === 'allow').priority);
  const header = policy().action.responseHeaders[0];
  assert.equal(header.header, 'content-security-policy'); assert.equal(header.operation, 'append');
  for (const token of ['allow-scripts','allow-same-origin','allow-forms','allow-presentation','allow-storage-access-by-user-activation']) assert.ok(header.value.split(' ').includes(token));
  assert.ok(!header.value.split(' ').some(token => token.startsWith('allow-top-navigation')));
  await h.send({ type: 'SET_SITE_PAUSED', domain: 'player.example', paused: true });
  assert.deepEqual(policy().condition.excludedRequestDomains, ['player.example']);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: false } }); assert.equal(policy(), undefined);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { enabled: true } }); assert.ok(policy());
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'player.example', blocked: false });
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'second.example', blocked: false }); assert.equal(policy(), undefined);
});

for (const fault of ['dynamic', 'ignoreDynamic', 'scripts', 'save']) test('page guard ' + fault + ' failure cannot report a partially enabled guard', async () => {
  const h = harness(); await h.ready;
  h.state.faults[fault] = 1;
  const result = await h.send({ type: 'SET_SITE_POPUPS', domain: 'player.example', blocked: true });
  assert.equal(result.ok, false);
  assert.deepEqual(h.state.storage.popupBlockedDomains, []);
  assert.ok(!h.state.dynamic.some(rule => rule.action.type === 'modifyHeaders'));
  assert.ok(!h.state.scripts.some(script => script.id === 'popup-blocker'));
  assert.equal((await h.send({ type: 'SET_SITE_POPUPS', domain: 'player.example', blocked: true })).ok, true);
  assert.ok(h.state.dynamic.some(rule => rule.action.type === 'modifyHeaders'));
  assert.ok(h.state.scripts.some(script => script.id === 'popup-blocker'));
});

test('page-originated pop-up events cannot forge activity-log entries', async () => {
  const h = harness({ popupBlockedDomains: ['uukanshu.cc'] });
  await h.ready;
  const tab = url => ({ id: 'test', url, tab: { id: 9, url } });
  await h.send({ type: 'LOG_EVENT', event: 'popup-blocked', host: 'spoof.example' }, tab('https://www.uukanshu.cc/book/1.html'));
  await h.send({ type: 'SET_SITE_POPUPS', domain: 'shady.example', blocked: true });
  await settle();
  const { entries } = await h.send({ type: 'GET_LOG' });
  assert.deepEqual(entries.map(entry => entry.message), ['Pop-up blocking turned on for shady.example']);
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

const AD_SCRIPT = 'https://political-effort.com/bjXWV.s/dRGOlb0/YtWndQi/YlWI5xubZoXDIJ/PeWm/9LuSZ/U_lykUPzT/Ul3CMQDhYHyMMoT/AZtpNHTvcrwkNPjVIXxKMnQN';
const loaded = (h, url, { type = 'script', page = 'https://www.uukanshu.cc/book/1.html', tabId = 4, firefox = false } = {}) => {
  h.state.tabs[tabId] ??= { id: tabId, url: page, incognito: false };
  h.listeners.response(firefox ? { url, type, tabId, documentUrl: page, incognito: h.state.tabs[tabId].incognito } : { url, type, tabId, initiator: new URL(page).origin });
};
const flagsOf = async h => Object.fromEntries((await h.send({ type: 'GET_FLAGS' })).flags.map(flag => [flag.site, flag]));

test('suspected ads that loaded are flagged per site with reasons, pages and samples, and logged once', async () => {
  const h = harness();
  await h.ready;
  loaded(h, AD_SCRIPT);
  loaded(h, 'https://www.political-effort.com/acWdZ-y.Pf2gQh9iM_Tkcl5mMnj-QpzqMrTsQ_zuNvTwQx2-NzzAUBzCM_DEMFxGNHy-ZJpKcL2M1_1ObPH', { page: 'https://m.xsw.tw/1/', firefox: true });
  loaded(h, 'https://imp9.pubadx.one/ad', { type: 'image' });
  await settle();
  const flags = await flagsOf(h);
  assert.deepEqual(Object.keys(flags).sort(), ['imp9.pubadx.one', 'political-effort.com', 'www.political-effort.com']);
  const flag = flags['political-effort.com'];
  assert.deepEqual([flag.status, flag.count, flag.hosts, flag.pages, flag.reasons.sort()],
    ['new', 1, ['political-effort.com'], ['www.uukanshu.cc'], ['obfuscated', 'throwaway-domain']]);
  assert.deepEqual(flags['www.political-effort.com'].pages, ['m.xsw.tw']);
  assert.ok(flag.samples[0].startsWith('political-effort.com/bjXWV.s/') && !flag.samples.some(sample => sample.includes('?')));
  assert.deepEqual(flags['imp9.pubadx.one'].reasons, ['ad-path']);
  const events = (await h.send({ type: 'GET_LOG' })).entries.filter(entry => /^Flagged /.test(entry.message));
  assert.deepEqual(events.map(entry => entry.message.split(':')[0]).sort(),
    ['Flagged imp9.pubadx.one for review', 'Flagged political-effort.com for review', 'Flagged www.political-effort.com for review']);
  assert.equal(Object.keys(h.state.storage.adFlags).length, 3, 'flags are kept in local storage');
  const restarted = harness(h.state.storage);
  await restarted.ready;
  assert.equal((await flagsOf(restarted))['political-effort.com'].count, 1, 'flags survive a restart');
});

test('ordinary, first-party, browser-internal, paused, allowed and switched-off requests are not flagged', async () => {
  const h = harness({ whitelistedDomains: ['paused.example'], allowedDomains: ['political-effort.com'] });
  await h.ready;
  loaded(h, 'https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js');
  loaded(h, 'https://uukanshu.cc/ads/banner.png', { type: 'image' });
  loaded(h, 'https://ads.example.net/ads/x.js', { tabId: -1 });
  h.listeners.response({ url: 'https://ads.example.net/ads/x.js', type: 'script', tabId: 2, initiator: 'chrome-extension://test' });
  loaded(h, 'https://ads.example.net/ads/x.js', { page: 'https://www.paused.example/' });
  loaded(h, AD_SCRIPT);
  await settle();
  assert.deepEqual((await h.send({ type: 'GET_FLAGS' })).flags, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { flagSuspects: false } });
  h.listeners.storageChanged({ flagSuspects: {} }, 'local');
  loaded(h, 'https://ads.example.net/ads/x.js');
  await settle();
  assert.deepEqual((await h.send({ type: 'GET_FLAGS' })).flags, []);
  await h.send({ type: 'UPDATE_SETTINGS', patch: { flagSuspects: true } });
  h.listeners.storageChanged({ flagSuspects: {} }, 'local');
  loaded(h, 'https://ads.example.net/ads/x.js');
  await settle();
  assert.equal((await h.send({ type: 'GET_FLAGS' })).flags.length, 1, 'turning flagging back on resumes it');
  assert.ok((await h.send({ type: 'GET_LOG' })).entries.some(entry => entry.message === 'Flagging suspected ads turned off'));
});

test('flag decisions: ignore stops counting, unignore resumes, remove and clear delete, and only extension pages may act', async () => {
  const h = harness();
  await h.ready;
  loaded(h, AD_SCRIPT);
  await settle();
  const youtube = youtubeTab;
  for (const message of [{ type: 'GET_FLAGS' }, { type: 'FLAG_ACTION', site: 'political-effort.com', action: 'remove' }]) {
    assert.equal((await h.send(message, youtube)).ok, false);
  }
  assert.equal((await h.send({ type: 'FLAG_ACTION', site: 'political-effort.com', action: 'ignore' })).ok, true);
  loaded(h, AD_SCRIPT);
  await settle();
  assert.deepEqual([(await flagsOf(h))['political-effort.com'].status, (await flagsOf(h))['political-effort.com'].count], ['ignored', 1]);
  await h.send({ type: 'FLAG_ACTION', site: 'political-effort.com', action: 'unignore' });
  loaded(h, AD_SCRIPT);
  await settle();
  assert.equal((await flagsOf(h))['political-effort.com'].count, 2);
  assert.equal((await h.send({ type: 'FLAG_ACTION', site: 'missing.example', action: 'remove' })).ok, false);
  assert.equal((await h.send({ type: 'FLAG_ACTION', site: 'political-effort.com', action: 'explode' })).ok, false);
  await h.send({ type: 'FLAG_ACTION', site: 'political-effort.com', action: 'remove' });
  assert.deepEqual((await h.send({ type: 'GET_FLAGS' })).flags, []);
  loaded(h, 'https://imp9.pubadx.one/ad', { type: 'image' });
  await settle();
  await h.send({ type: 'FLAG_ACTION', action: 'clear' });
  assert.deepEqual(h.state.storage.adFlags, {});
});

test('page signals accept only fixed reasons and third-party http(s) addresses from content scripts', async () => {
  const h = harness();
  await h.ready;
  const page = { id: 'test', url: 'https://www.uukanshu.cc/book/1.html', tab: { id: 6, incognito: false, url: 'https://www.uukanshu.cc/book/1.html' } };
  await h.send({ type: 'FLAG_CANDIDATES', items: [
    { url: 'https://acceptable.a-ads.com/2453155/', reason: 'ad-size-frame' },
    { url: 'https://img.uukanshu.cc/side.html', reason: 'ad-size-frame' },
    { url: 'javascript:alert(1)', reason: 'ad-label' },
    { url: 'https://spoof.example/x', reason: 'obfuscated' },
    { url: 'https://label.example/x', reason: 'ad-label' }
  ] }, page);
  await h.send({ type: 'FLAG_CANDIDATES', items: [{ url: 'https://extension-page.example/', reason: 'ad-label' }] });
  await settle();
  const flags = await flagsOf(h);
  assert.deepEqual(Object.keys(flags).sort(), ['acceptable.a-ads.com', 'img.uukanshu.cc', 'label.example']);
  assert.deepEqual(flags['acceptable.a-ads.com'].reasons, ['ad-size-frame']);
});

test('private and unknown tabs leave no persisted flag or flag log through either producer', async () => {
  const h = harness(); await h.ready;
  for (const incognito of [true, undefined]) {
    const tab = { id: 4, incognito, url: 'https://private.example/' };
    h.state.tabs[4] = tab;
    for (const firefox of [true, false]) loaded(h, AD_SCRIPT, { firefox, page: tab.url });
    await h.send({ type: 'FLAG_CANDIDATES', items: [{ reason: 'ad-label', url: 'https://ads.example/ads/' }] }, { id: 'test', url: tab.url, tab });
    await settle();
  }
  delete h.state.tabs[4];
  h.listeners.response({ type: 'script', tabId: 4, url: AD_SCRIPT, initiator: 'https://private.example/' });
  await settle();
  assert.deepEqual(await flagsOf(h), {});
  assert.equal(h.state.storage.adFlags, undefined);
  assert.ok(!(await h.send({ type: 'GET_LOG' })).entries.some(entry => /^Flagged /.test(entry.message)));
});

test('the flag store keeps the 500 most recently seen sites', async () => {
  const h = harness();
  await h.ready;
  for (let i = 0; i < 501; i++) {
    h.state.now += 1000;
    loaded(h, `https://ads${i}.example${i}.net/ads/x.js`);
    await settle();
  }
  const flags = (await h.send({ type: 'GET_FLAGS' })).flags;
  assert.equal(flags.length, 500);
  assert.ok(!flags.some(flag => flag.site === 'ads0.example0.net') && flags.some(flag => flag.site === 'ads500.example500.net'));
});

test('a failed read of saved flags is reported and retried, never saved over as empty', async () => {
  const h = harness({ adFlags: { 'kept.example': { site: 'kept.example', status: 'new', hosts: ['kept.example'], reasons: ['ad-path'],
    pages: ['uukanshu.cc'], samples: [], count: 3, firstSeen: 1, lastSeen: 1 } } });
  await h.ready;
  const realGet = h.api.storage.local.get;
  h.api.storage.local.get = async keys => { if (keys.includes('adFlags')) throw new Error('Injected read failure'); return realGet(keys); };
  loaded(h, AD_SCRIPT);
  await settle();
  assert.equal((await h.send({ type: 'GET_FLAGS' })).ok, false, 'the failure is reported');
  h.api.storage.local.get = realGet;
  await settle();
  assert.deepEqual(Object.keys(h.state.storage.adFlags), ['kept.example'], 'saved flags were not overwritten');
  assert.equal((await flagsOf(h))['kept.example'].count, 3, 'the next read succeeds');
});
