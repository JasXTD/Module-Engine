/* Native userscript lifecycle. This module owns no DNR or content-script rules. */
(() => {
  'use strict';
  const core = BlockAdsUserScriptCore, KEY = 'userscriptManager', PREFIX = 'blockads-user-';
  const errorText = error => error?.message || String(error);
  const clone = value => JSON.parse(JSON.stringify(value));
  const token = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '');
  const needsStorage = source => core.parse(source).grants.some(grant => /^GM\.(getValue|setValue|deleteValue|listValues)$/.test(grant));
  const VALUE_METHODS = Object.freeze({ get: 'GM.getValue', set: 'GM.setValue', delete: 'GM.deleteValue', list: 'GM.listValues' });
  const VALUE_LIMITS = Object.freeze({ total: 64, script: 16, tab: 8 });
  function normalized(script) {
    return { id: script.id, matches: [...(script.matches || [])].sort(), excludeMatches: [...(script.excludeMatches || [])].sort(),
      runAt: script.runAt || 'document_idle', allFrames: Boolean(script.allFrames), world: script.world || 'USER_SCRIPT',
      worldId: script.worldId || '', js: script.js };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sortedScripts = scripts => scripts.map(normalized).sort((a, b) => a.id.localeCompare(b.id));
  const sortedWorlds = worlds => worlds.map(world => ({ worldId: world.worldId, messaging: Boolean(world.messaging),
    csp: world.csp || '' })).sort((a, b) => a.worldId.localeCompare(b.worldId));
  function create(api) {
    const controls = [], values = [], byScript = new Map(), byTab = new Map();
    let running = false, controlPending = 0, valuePending = 0, lastError = '', boundEvent;
    // GM traffic cannot consume control capacity. A single runner still owns
    // all writes: controls take precedence after the active transaction finishes.
    function pump() {
      if (running) return;
      const task = controls.shift() || values.shift();
      if (!task) return;
      running = true;
      void Promise.resolve().then(task.work).then(task.resolve, task.reject).finally(() => {
        task.release(); running = false; pump();
      });
    }
    const schedule = (lane, work, release) => new Promise((resolve, reject) => {
      lane.push({ work, release, resolve, reject }); pump();
    });
    const enqueue = work => {
      if (controlPending >= 100) return Promise.reject(new Error('Userscript manager is busy. Try again shortly.'));
      controlPending++;
      return schedule(controls, work, () => { controlPending--; });
    };
    function validateValueRequest(message, sender) {
      if (sender?.id !== api.runtime.id || !Number.isInteger(sender.tab?.id) || !Number.isInteger(sender.frameId) ||
          !message || message.type !== 'US_VALUE' || !Object.hasOwn(VALUE_METHODS, message.operation) ||
          typeof message.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.id) ||
          typeof message.token !== 'string' || !/^[a-f0-9]{64}$/.test(message.token)) throw new Error('Invalid userscript storage request.');
    }
    function enqueueValue(message, sender) {
      validateValueRequest(message, sender);
      const script = message.id, tab = sender.tab.id;
      if (valuePending >= VALUE_LIMITS.total || (byScript.get(script) || 0) >= VALUE_LIMITS.script ||
          (byTab.get(tab) || 0) >= VALUE_LIMITS.tab) throw new Error('Too many pending GM storage requests. Wait for earlier requests to finish.');
      valuePending++; byScript.set(script, (byScript.get(script) || 0) + 1); byTab.set(tab, (byTab.get(tab) || 0) + 1);
      const release = (counts, key) => {
        const remaining = counts.get(key) - 1;
        if (remaining) counts.set(key, remaining); else counts.delete(key);
      };
      return schedule(values, () => valueRequest(message, sender), () => {
        valuePending--; release(byScript, script); release(byTab, tab);
      });
    }
    const read = async () => core.library((await api.storage.local.get([KEY]))[KEY]);
    async function access() {
      const granted = api.permissions?.contains ? await api.permissions.contains({ permissions: ['userScripts'] }) : false;
      if (!granted) return { available: false, denied: true, needsPermission: true, error: 'Allow userscript access to use this module.' };
      const native = api.userScripts;
      if (!native?.getWorldConfigurations || !native?.resetWorldConfiguration) {
        return { available: false, denied: true, needsPermission: false,
          error: 'Enable Allow User Scripts in this extension’s browser details, then refresh status. Isolated userscript worlds require a current browser.' };
      }
      try {
        const scripts = (await native.getScripts()).filter(script => script.id.startsWith(PREFIX));
        const worlds = (await native.getWorldConfigurations()).filter(world => world.worldId?.startsWith(PREFIX));
        return { available: true, denied: false, needsPermission: false, native, scripts, worlds, error: '' };
      } catch (error) {
        return { available: false, denied: /user.?scripts.*not available|allow user scripts|developer mode|permission/i.test(errorText(error)),
          needsPermission: false, error: 'Browser userscript access is unavailable: ' + errorText(error) };
      }
    }
    function target(library) {
      const enabled = library.enabled ? library.scripts.filter(script => script.enabled) : [];
      return { scripts: enabled.map(core.registration), worlds: enabled.filter(script => core.parse(script.source).world === 'USER_SCRIPT')
        .map(script => ({ worldId: core.nativeId(script.id), messaging: needsStorage(script.source), csp: "script-src 'self'; object-src 'none'" })) };
    }
    async function apply(desired, current) {
      const native = current.native;
      const desiredById = new Map(desired.scripts.map(script => [script.id, script]));
      const currentById = new Map(current.scripts.map(script => [script.id, script]));
      const remove = current.scripts.filter(script => !desiredById.has(script.id) ||
        !same(normalized(script), normalized(desiredById.get(script.id)))).map(script => script.id);
      if (remove.length) await native.unregister({ ids: remove });
      for (const world of desired.worlds) {
        const previous = current.worlds.find(item => item.worldId === world.worldId);
        if (!previous || !same(sortedWorlds([previous]), sortedWorlds([world]))) await native.configureWorld(world);
      }
      const add = desired.scripts.filter(script => !currentById.has(script.id) || remove.includes(script.id));
      if (add.length) await native.register(add);
      for (const world of current.worlds) {
        if (!desired.worlds.some(item => item.worldId === world.worldId)) await native.resetWorldConfiguration(world.worldId);
      }
      const actual = await access();
      if (!actual.available || !same(sortedScripts(actual.scripts), sortedScripts(desired.scripts)) ||
          !same(sortedWorlds(actual.worlds), sortedWorlds(desired.worlds))) throw new Error('The browser did not apply the requested userscripts.');
    }
    async function restore(snapshot) {
      const current = await access();
      if (!current.available) throw new Error('Could not restore browser userscript registrations.');
      await apply(snapshot, current);
    }
    const receiveValue = (message, sender, respond) => {
      // Native userscript messages never enter the privileged settings router.
      try {
        enqueueValue(message, sender).then(respond, error => respond({ ok: false, error: errorText(error) }));
      } catch (error) {
        respond({ ok: false, error: errorText(error) });
        return false;
      }
      return true;
    };
    function bindMessages() {
      const event = api.runtime.onUserScriptMessage;
      if (event && (event.hasListener ? !event.hasListener(receiveValue) : event !== boundEvent)) {
        event.addListener(receiveValue);
        boundEvent = event;
      }
    }
    async function synchronize(library, strict = false) {
      bindMessages();
      const current = await access(), desired = target(library);
      if (!current.available) {
        if (strict || (!current.denied && library.enabled)) throw new Error(current.error);
        return current;
      }
      try { await apply(desired, current); }
      catch (error) {
        try { await restore(current); }
        catch (rollback) { throw new Error(errorText(error) + ' Browser rollback also failed: ' + errorText(rollback)); }
        throw error;
      }
      return current;
    }
    function view(library, availability) {
      return { ok: true, enabled: library.enabled, active: library.enabled && availability.available && !lastError,
        available: availability.available, needsPermission: availability.needsPermission, error: lastError || availability.error,
        revision: library.revision, scripts: library.scripts.map(({ id, revision, enabled, source }) =>
          ({ id, revision, enabled, source, metadata: core.parse(source) })) };
    }
    async function snapshot() {
      const library = await read();
      try { const available = await synchronize(library); lastError = ''; return view(library, available); }
      catch (error) { lastError = errorText(error); return view(library, { available: false, needsPermission: false, error: lastError }); }
    }
    async function commit(before, next, requireAccess = false) {
      next.revision = before.revision + 1;
      next = core.library(next);
      const current = await access();
      if (!current.available && (requireAccess || (!current.denied && before.enabled))) throw new Error(current.error);
      let storageAttempted = false;
      try {
        if (current.available) await apply(target(next), current);
        storageAttempted = true;
        await api.storage.local.set({ [KEY]: next });
        if (!same(await read(), next)) throw new Error('The userscript library could not be verified after saving.');
        lastError = '';
        return view(next, current);
      } catch (error) {
        const failures = [];
        if (storageAttempted) {
          try { await api.storage.local.set({ [KEY]: before }); if (!same(await read(), before)) throw new Error('Storage rollback could not be verified.'); }
          catch (rollback) { failures.push(errorText(rollback)); }
        }
        if (current.available) {
          try { await restore(current); } catch (rollback) { failures.push(errorText(rollback)); }
        }
        lastError = 'Userscript changes were not applied. ' + errorText(error) +
          (failures.length ? ' Rollback could not be verified: ' + failures.join('; ') : '');
        throw new Error(lastError);
      }
    }
    async function command(message) {
      if (message.type === 'US_LIST') return snapshot();
      const before = await read(), next = clone(before);
      let script;
      if (message.id !== undefined) {
        script = next.scripts.find(item => item.id === message.id);
        if (!script || message.revision !== script.revision) throw new Error('This script changed in another window. Refresh and reopen it before applying changes.');
      }
      if (message.type === 'US_SAVE') {
        core.parse(message.source);
        if (script) Object.assign(script, { source: message.source, enabled: false, revision: script.revision + 1, token: token() });
        else {
          if (next.scripts.length >= core.LIMITS.scripts) throw new Error('The library supports up to 32 scripts.');
          script = { id: crypto.randomUUID(), revision: 1, enabled: false, source: message.source, token: token(), values: {} };
          next.scripts.push(script);
        }
      } else if (message.type === 'US_ENABLE') {
        if (!script || typeof message.enabled !== 'boolean') throw new Error('Choose a saved script and a valid enable state.');
        Object.assign(script, { enabled: message.enabled, revision: script.revision + 1, token: token() });
      } else if (message.type === 'US_DELETE') {
        if (!script) throw new Error('Choose a saved script to delete.');
        next.scripts = next.scripts.filter(item => item.id !== script.id);
      } else throw new Error('Unknown userscript command.');
      const response = await commit(before, next, next.enabled && message.type === 'US_ENABLE' && message.enabled);
      return { ...response, selectedId: message.type === 'US_DELETE' ? null : script.id };
    }
    async function valueRequest(message, sender) {
      validateValueRequest(message, sender);
      const library = await read(), script = library.scripts.find(item => item.id === message.id);
      if (!library.enabled || !script?.enabled || message.token !== script.token) throw new Error('This userscript is inactive or its capability has expired. Reload the page.');
      const metadata = core.parse(script.source);
      if (metadata.world !== 'USER_SCRIPT' || !metadata.grants.includes(VALUE_METHODS[message.operation]) ||
          !core.allows(metadata, sender.url) || (!metadata.allFrames && sender.frameId !== 0) ||
          (sender.userScriptWorldId !== undefined && sender.userScriptWorldId !== core.nativeId(script.id))) throw new Error('This userscript is not allowed to perform that storage operation here.');
      const available = await access();
      if (!available.available) throw new Error(available.error);
      if (!available.scripts.some(item => item.id === core.nativeId(script.id))) throw new Error('This userscript is no longer registered.');
      if (message.operation === 'list') return { ok: true, keys: Object.keys(script.values) };
      const key = message.key;
      if (typeof key !== 'string' || !key || key.length > 256) throw new Error('Use a nonempty storage key of at most 256 characters.');
      if (message.operation === 'get') return Object.hasOwn(script.values, key) ? { ok: true, exists: true, value: script.values[key] } : { ok: true, exists: false };
      const values = new Map(Object.entries(script.values));
      if (message.operation === 'delete') values.delete(key);
      else values.set(key, core.jsonValue(message.value));
      script.values = core.validateValues(Object.fromEntries(values));
      library.revision++;
      await api.storage.local.set({ [KEY]: core.library(library) });
      return { ok: true };
    }
    const start = () => enqueue(async () => {
      try { await snapshot(); }
      catch (error) {
        lastError = errorText(error);
        // Invalid persistent data must not leave old scripts executing, or erase it.
        try { const current = await access(); if (current.available) await apply({ scripts: [], worlds: [] }, current); }
        catch (cleanup) { lastError += ' Could not remove stale registrations: ' + errorText(cleanup); }
      }
    });
    bindMessages();
    api.permissions?.onAdded?.addListener(() => { void start(); });
    api.permissions?.onRemoved?.addListener(() => { void start(); });
    return Object.freeze({
      start,
      request: message => enqueue(() => command(message)),
      state: () => enqueue(async () => {
        const result = await snapshot();
        return { enabled: result.enabled, active: result.active, available: result.available,
          count: result.scripts.filter(script => script.enabled).length, error: result.error, needsPermission: result.needsPermission };
      }),
      setEnabled: enabled => enqueue(async () => {
        if (typeof enabled !== 'boolean') throw new Error('Invalid userscript module switch.');
        const before = await read(), next = clone(before); next.enabled = enabled;
        if (enabled !== before.enabled) for (const script of next.scripts) script.token = token();
        return commit(before, next, enabled);
      })
    });
  }
  globalThis.BlockAdsUserScripts = Object.freeze({ create, KEY });
})();
