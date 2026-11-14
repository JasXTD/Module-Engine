/* Native userscript lifecycle. This module owns no DNR or content-script rules. */
(() => {
  'use strict';
  const core = BlockAdsUserScriptCore, network = BlockAdsUserScriptNetwork, KEY = 'userscriptManager', PREFIX = 'blockads-user-';
  const errorText = error => error?.message || String(error);
  const clone = value => JSON.parse(JSON.stringify(value));
  const token = () => (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '');
  const granted = (metadata, name) => metadata.grants.includes('GM.' + name) || metadata.grants.includes('GM_' + name) || name === 'xmlhttpRequest' && metadata.grants.includes('GM.xmlHttpRequest');
  const needsStorage = source => core.parse(source).grants.some(grant => /^GM[._]/.test(grant) && !/^GM[._](info|addStyle|addElement|getResourceText|getResourceURL|getResourceUrl)$/.test(grant));
  const VALUE_METHODS = Object.freeze({ get: 'getValue', set: 'setValue', delete: 'deleteValue', list: 'listValues',
    getMany: 'getValues', setMany: 'setValues', deleteMany: 'deleteValues', connect: null, diagnostic: null, menus: 'registerMenuCommand',
    request: 'xmlhttpRequest', abortRequest: 'xmlhttpRequest', openTab: 'openInTab', closeTab: 'openInTab',
    clipboard: 'setClipboard', notification: 'notification', removeNotification: 'notification', download: 'download', abortDownload: 'download', cookie: 'cookie' });
  const VALUE_LIMITS = Object.freeze({ total: 64, script: 16, tab: 8 });
  function normalized(script) {
    return { id: script.id, matches: [...(script.matches || [])].sort(), excludeMatches: [...(script.excludeMatches || [])].sort(),
      includeGlobs: [...(script.includeGlobs || [])].sort(),
      runAt: script.runAt || 'document_idle', allFrames: Boolean(script.allFrames), world: script.world || 'USER_SCRIPT',
      worldId: script.worldId || '', js: script.js };
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const sortedScripts = scripts => scripts.map(normalized).sort((a, b) => a.id.localeCompare(b.id));
  const sortedWorlds = worlds => worlds.map(world => ({ worldId: world.worldId, messaging: Boolean(world.messaging),
    csp: world.csp || '' })).sort((a, b) => a.worldId.localeCompare(b.worldId));
  function create(api) {
    network.configure(api);
    const controls = [], values = [], byScript = new Map(), byTab = new Map(), connections = new Map(), pendingMenus = new Set();
    const assetJobs = new Map(), requests = new Map(), tabs = new Map(), openingTabs = new Set(), tabRates = new Map();
    const sourceJobs = new Map(), frameProbes = new Map(), cookieJobs = new Map();
    const diagnosticRates = new Map();
    let diagnosticSink = null, diagnosticPending = 0;
    const actions = BlockAdsUserScriptActions.create(api, connection => connections.get(connection.id) === connection);
    let running = false, controlPending = 0, valuePending = 0, connectionPending = 0, lastError = '', boundEvent, boundConnect;
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
      if (message.operation === 'diagnostic') {
        const sink = diagnosticSink;
        if (!sink) return Promise.resolve({ ok: false, error: 'Diagnostic capture is off.' });
        if (typeof message.message !== 'string' || message.message.length > 2048 || typeof message.stack !== 'string' || message.stack.length > 8192)
          throw new Error('Invalid userscript diagnostic.');
        const key = message.id + ':' + sender.tab.id, now = Date.now();
        for (const [id, rate] of diagnosticRates) if (rate.start + 30000 <= now) diagnosticRates.delete(id);
        const rate = diagnosticRates.get(key) || { start: now, count: 0 };
        if (diagnosticPending >= 8 || rate.count >= 10 || !diagnosticRates.has(key) && diagnosticRates.size >= 64)
          throw new Error('Diagnostic capture limit reached.');
        rate.count++; diagnosticRates.set(key, rate); diagnosticPending++;
        // A separate, bounded lane admission cannot consume GM or manager slots.
        // Capture the approval identity so queued work cannot enter a new session.
        return schedule(values, async () => {
          if (diagnosticSink !== sink) return { ok: false };
          const { script, pageURL } = await authorize(message, sender);
          if (diagnosticSink !== sink) return { ok: false };
          const url = new URL(pageURL);
          sink({ time: Date.now(), scriptId: script.id, revision: script.revision, name: core.parse(script.source).name,
            tabId: sender.tab.id, frameId: sender.frameId, url: url.origin + url.pathname, message: message.message, stack: message.stack });
          return { ok: true };
        }, () => { diagnosticPending--; });
      }
      if (message.operation === 'menus') {
        const connection = connections.get(message.connectionId);
        if (!connection?.ready || connection.scriptId !== message.id || connection.token !== message.token ||
            !sameDocument(connection.sender, sender)) throw new Error('This userscript connection has expired.');
        // Automatic menu publication must not compete with a page's eight GM
        // value slots. One update per native connection and 64 overall bounds
        // this separate admission; controls still own the higher-priority lane.
        if (pendingMenus.size >= 64 || pendingMenus.has(connection.id)) throw new Error('Too many pending script menu updates.');
        pendingMenus.add(connection.id);
        return schedule(values, () => valueRequest(message, sender), () => { pendingMenus.delete(connection.id); });
      }
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
    async function target(library) {
      const enabled = library.enabled ? library.scripts.filter(script => script.enabled) : [];
      for (const script of enabled) {
        try { await network.verify(script); }
        catch (error) { throw Object.assign(new Error(errorText(error)), { code: 'INVALID_SCRIPT_ASSETS' }); }
      }
      return { scripts: enabled.flatMap(script => core.registrations(script, library.scripts.indexOf(script))), worlds: enabled.filter(script => core.nativeWorld(core.parse(script.source)) === 'USER_SCRIPT')
        .map(script => ({ worldId: core.nativeId(script.id), messaging: needsStorage(script.source), csp: "script-src 'self'; object-src 'none'" })) };
    }
    async function apply(desired, current) {
      const native = current.native;
      // Chromium orders native injections by ID; Firefox uses registration order.
      // Ordinal IDs and one ordered batch preserve both without sharing worlds.
      const changed = !same(sortedScripts(current.scripts), sortedScripts(desired.scripts));
      const remove = changed ? current.scripts.map(script => script.id) : [];
      if (remove.length) await native.unregister({ ids: remove });
      for (const world of desired.worlds) {
        const previous = current.worlds.find(item => item.worldId === world.worldId);
        if (!previous || !same(sortedWorlds([previous]), sortedWorlds([world]))) await native.configureWorld(world);
      }
      const add = changed ? desired.scripts : [];
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
        if (message?.operation === 'connect') throw new Error('Use a native userscript connection.');
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
      const connect = api.runtime.onUserScriptConnect;
      if (connect && (connect.hasListener ? !connect.hasListener(receiveConnection) : connect !== boundConnect)) {
        connect.addListener(receiveConnection); boundConnect = connect;
      }
    }
    function closeConnection(connection, error = 'This userscript is inactive. Reload the page.') {
      dropConnection(connection);
      try { connection.port.postMessage({ type: 'revoked', error }); } catch { /* The native document already closed. */ }
      try { connection.port.disconnect(); } catch { /* Already disconnected during document teardown. */ }
    }
    function dropConnection(connection) {
      connections.delete(connection.id);
      actions.drop(connection);
      for (const [controller, owner] of cookieJobs) if (owner === connection) controller.abort(new Error('This userscript connection has expired.'));
      for (const [key, request] of requests) if (request.connection === connection) { request.controller.abort(); requests.delete(key); }
      // Revoke ownership, not the user's open pages. In-flight browser actions
      // cannot be cancelled, but are never replayed or rebound to another realm.
      for (const [key, job] of tabs) if (job.connection === connection) tabs.delete(key);
    }
    function tabEvent(job, event, error) {
      if (tabs.get(job.key) !== job || connections.get(job.connection.id) !== job.connection) return;
      if (['closed', 'error', 'unavailable'].includes(event)) tabs.delete(job.key);
      try { job.connection.port.postMessage({ type: 'tab', tabHandle: job.handle, event, ...(error ? { error } : {}) }); }
      catch { dropConnection(job.connection); }
    }
    async function openTab(job, details) {
      try {
        const parent = await api.tabs.get(job.connection.sender.tab.id);
        if (tabs.get(job.key) !== job) return;
        if (!Number.isInteger(parent.windowId) || !Number.isInteger(parent.index)) throw new Error('The originating tab is unavailable.');
        // Preserve the originating window, including its private-browsing mode.
        const options = { url: details.url, active: details.active, pinned: details.pinned, windowId: parent.windowId };
        if (details.insert) Object.assign(options, { index: parent.index + 1, openerTabId: parent.id });
        // Firefox containers: keep the source tab's container unless the script
        // chooses one. Other browsers have no containers and ignore the option.
        if (typeof api.runtime.getBrowserInfo === 'function') {
          if (parent.incognito && details.container !== undefined) throw new Error('Firefox containers are unavailable in private windows.');
          const store = details.container === undefined ? parent.cookieStoreId : details.container === 0 ? 'firefox-default' : 'firefox-container-' + details.container;
          if (!parent.incognito && store && store !== 'firefox-default') {
            // Firefox requires the cookies permission for any cookieStoreId.
            if (!await api.permissions.contains({ permissions: ['cookies'] })) throw new Error('Allow helper access in Modules & scripts to open tabs in Firefox containers.');
            if (tabs.get(job.key) !== job) return;
            options.cookieStoreId = store;
          }
        }
        const created = await api.tabs.create(options);
        if (tabs.get(job.key) !== job) return;
        if (!Number.isInteger(created?.id)) throw new Error('The browser did not return the created tab.');
        job.tabId = created.id;
        // onRemoved can arrive before tabs.create resolves (e.g. our existing
        // blocked-popup cleanup). Reconcile that race before announcing a handle.
        try { await api.tabs.get(job.tabId); }
        catch (error) {
          // A lookup failure alone does not prove closure. Confirm absence or
          // invalidate the handle while leaving its last known state intact.
          try {
            const remaining = await api.tabs.query({});
            if (!remaining.some(tab => tab.id === job.tabId)) tabEvent(job, 'closed');
            else tabEvent(job, 'unavailable', errorText(error));
          } catch (lookup) { tabEvent(job, 'unavailable', errorText(lookup)); }
          return;
        }
        tabEvent(job, 'opened');
      } catch (error) { tabEvent(job, 'error', errorText(error)); }
      finally { openingTabs.delete(job); }
    }
    function tabRequest(message, sender, script, connection) {
      if (!connection) throw new Error('Tab helpers require a native userscript connection.');
      if (typeof message.tabHandle !== 'string' || !/^[0-9]{1,16}$/.test(message.tabHandle)) throw new Error('Invalid tab handle.');
      const key = connection.id + ':' + message.tabHandle;
      if (message.operation === 'closeTab') {
        const job = tabs.get(key);
        if (!job || !Number.isInteger(job.tabId)) throw new Error('This tab handle is no longer available.');
        // Release the scheduler while the browser processes this one owned tab.
        if (!job.closing) {
          job.closing = true;
          void api.tabs.remove(job.tabId).then(() => tabEvent(job, 'closed'), error => {
            job.closing = false;
            if (tabs.get(key) === job) {
              try { connection.port.postMessage({ type: 'tab', tabHandle: job.handle, event: 'close-error', error: errorText(error) }); }
              catch { dropConnection(connection); }
            }
          });
        }
        return { ok: true };
      }
      const details = core.tabOptions(message.details?.url,
        Object.fromEntries(Object.entries(message.details || {}).filter(([name]) => name !== 'url')), sender.url);
      const active = [...tabs.values()], pending = [...openingTabs];
      if (tabs.has(key) || active.length >= 64 || active.filter(job => job.connection.scriptId === script.id).length >= 16 ||
          active.filter(job => job.connection === connection).length >= 8 || pending.length >= 8 ||
          pending.filter(job => job.connection.scriptId === script.id).length >= 4) throw new Error('Too many userscript tab handles or pending openings.');
      const now = performance.now(), rate = tabRates.get(script.id);
      if (rate && now - rate.start < 60000 && rate.count >= 32) throw new Error('At most 32 tab openings per script per minute.');
      tabRates.set(script.id, rate && now - rate.start < 60000 ? { start: rate.start, count: rate.count + 1 } : { start: now, count: 1 });
      for (const id of tabRates.keys()) if (!active.some(job => job.connection.scriptId === id) && tabRates.get(id).start < now - 60000) tabRates.delete(id);
      const job = { key, handle: message.tabHandle, connection }; tabs.set(key, job); openingTabs.add(job);
      void openTab(job, details);
      return { ok: true };
    }
    function reconcileConnections(library, available = true) {
      for (const connection of connections.values()) {
        const script = library.scripts.find(item => item.id === connection.scriptId);
        if (!available || !library.enabled || !script?.enabled || script.token !== connection.token) closeConnection(connection);
      }
      for (const [id, job] of assetJobs) {
        const script = library.scripts.find(item => item.id === id);
        if (!script || script.enabled || script.revision !== job.revision) { job.controller.abort(); assetJobs.delete(id); }
      }
      for (const [id, job] of sourceJobs) {
        if (!job.scriptId) continue;
        const script = library.scripts.find(item => item.id === job.scriptId);
        if (!script || script.revision !== job.revision) {
          job.controller.abort(new Error('The script changed during the update check. Check again.')); sourceJobs.delete(id);
        }
      }
    }
    function valueSnapshot(script, metadata, revision) {
      if (['getValue', 'getValues', 'addValueChangeListener'].some(name => granted(metadata, name))) return { values: script.values, revision };
      if (granted(metadata, 'listValues')) return { keys: Object.keys(script.values), revision };
      return { revision };
    }
    function receiveConnection(port) {
      let connection;
      try {
        if (typeof port.name !== 'string' || port.name.length > 160) throw new Error('Invalid userscript connection.');
        const [, id, capability] = /^US_CHANNEL:([a-f0-9-]+):([a-f0-9]+)$/.exec(port.name) || [];
        const message = { type: 'US_VALUE', operation: 'connect', id, token: capability }, sender = port.sender;
        validateValueRequest(message, sender);
        const active = [...connections.values()];
        if (active.length >= 256 || active.filter(item => item.sender.tab.id === sender.tab.id).length >= 64 ||
            active.filter(item => item.scriptId === id).length >= 64) throw new Error('Too many active userscript connections.');
        connection = { id: crypto.randomUUID(), scriptId: id, token: capability, sender, port, menus: [], ready: false };
        connections.set(connection.id, connection);
        port.onDisconnect.addListener(() => dropConnection(connection));
        // Cache hydration has separate bounded admission: otherwise a page
        // matching more than eight legacy scripts permanently rejects some at
        // startup. It shares the low-priority lane, never manager capacity.
        if (connectionPending >= 64) throw new Error('Too many pending userscript connections. Reload the page.');
        connectionPending++;
        void schedule(values, async () => {
          const { library, script, metadata } = await authorize(message, sender);
          if (!connections.has(connection.id)) return;
          connection.ready = true; connection.metadata = metadata;
          port.postMessage({ type: 'ready', connectionId: connection.id, ...valueSnapshot(script, metadata, library.revision) });
        }, () => { connectionPending--; }).catch(error => closeConnection(connection, errorText(error)));
      } catch (error) {
        if (connection) closeConnection(connection, errorText(error));
        else {
          try { port.postMessage({ type: 'revoked', error: errorText(error) }); } catch { /* Already disconnected. */ }
          try { port.disconnect(); } catch { /* Already disconnected. */ }
        }
      }
    }
    async function synchronize(library, strict = false) {
      bindMessages();
      const current = await access(), desired = await target(library);
      if (!current.available) {
        reconcileConnections(library, false);
        if (strict || (!current.denied && library.enabled)) throw new Error(current.error);
        return current;
      }
      try { await apply(desired, current); }
      catch (error) {
        try { await restore(current); }
        catch (rollback) { throw new Error(errorText(error) + ' Browser rollback also failed: ' + errorText(rollback)); }
        throw error;
      }
      reconcileConnections(library);
      return current;
    }
    function view(library, availability) {
      return { ok: true, enabled: library.enabled, active: library.enabled && availability.available && !lastError,
        available: availability.available, needsPermission: availability.needsPermission, error: lastError || availability.error,
        revision: library.revision, scripts: library.scripts.map(({ id, revision, enabled, source, assets, sourceURL, tags, autoPageApproved }) =>
          ({ id, revision, enabled, source, sourceURL, tags, autoPageApproved, metadata: core.parse(source), assets: assets?.map(({ body, ...asset }) =>
            ({ ...asset, size: core.decodeAsset(body).length })) ?? null })) };
    }
    async function snapshot() {
      const library = await read();
      try { const available = await synchronize(library); lastError = ''; return view(library, available); }
      catch (error) {
        lastError = errorText(error);
        if (error.code === 'INVALID_SCRIPT_ASSETS') {
          for (const connection of connections.values()) closeConnection(connection);
          try { const current = await access(); if (current.available) await apply({ scripts: [], worlds: [] }, current); }
          catch (cleanup) { lastError += ' Could not remove stale registrations: ' + errorText(cleanup); }
        }
        return view(library, { available: false, needsPermission: false, error: lastError });
      }
    }
    async function inspect() {
      const library = await read(), available = await access();
      const result = view(library, available);
      try {
        const desired = await target(library);
        const synchronized = available.available && same(sortedScripts(available.scripts), sortedScripts(desired.scripts)) &&
          same(sortedWorlds(available.worlds), sortedWorlds(desired.worlds));
        result.active = library.enabled && synchronized && !lastError;
        if (available.available && !synchronized) result.error = 'Native userscript registrations differ from the saved library.';
      } catch (error) { result.active = false; result.error = errorText(error); }
      return result;
    }
    async function commit(before, next, requireAccess = false) {
      next.revision = before.revision + 1;
      next = core.library(next);
      const current = await access();
      if (!current.available && (requireAccess || (!current.denied && before.enabled))) throw new Error(current.error);
      let storageAttempted = false;
      try {
        if (current.available) await apply(await target(next), current);
        storageAttempted = true;
        await api.storage.local.set({ [KEY]: next });
        if (!same(await read(), next)) throw new Error('The userscript library could not be verified after saving.');
        reconcileConnections(next, current.available);
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
      if (message.type === 'US_MENU_LIST' || message.type === 'US_MENU_RUN') return menuCommand(message);
      if (message.type === 'US_CANCEL_ASSETS') {
        assetJobs.get(message.id)?.controller.abort(); assetJobs.delete(message.id); return { ok: true };
      }
      if (message.type === 'US_CANCEL_SOURCE') {
        sourceJobs.get(message.requestId)?.controller.abort(new Error('Script download cancelled.'));
        sourceJobs.delete(message.requestId); return { ok: true };
      }
      const before = await read(), next = clone(before);
      let script;
      if (message.id !== undefined) {
        script = next.scripts.find(item => item.id === message.id);
        if (!script || message.revision !== script.revision) throw new Error('This script changed in another window. Refresh and reopen it before applying changes.');
      }
      if (message.type === 'US_SAVE' || message.type === 'US_APPLY_SOURCE') {
        const metadata = core.parse(message.source);
        let review;
        if (message.type === 'US_APPLY_SOURCE') {
          review = core.sourceReview(message.source, message.sourceURL, script);
          if (review.versionChange === -1) throw new Error('The downloaded version is older. The installed script was preserved.');
          if (review.unchanged) throw new Error('This source is already installed.');
        }
        if (script) Object.assign(script, { assets: same(core.assetSpecs(core.parse(script.source)), core.assetSpecs(metadata)) ? script.assets : null,
          source: message.source, enabled: false, autoPageApproved: false, revision: script.revision + 1, token: token() });
        else {
          if (next.scripts.length >= core.LIMITS.scripts) throw new Error('The library supports up to 32 scripts.');
          script = { id: crypto.randomUUID(), revision: 1, enabled: false, source: message.source, token: token(), values: {} };
          next.scripts.push(script);
        }
        if (review) script.sourceURL = review.sourceURL;
        if (message.tags !== undefined) script.tags = core.tags(message.tags);
      } else if (message.type === 'US_TAGS') {
        if (!script) throw new Error('Choose a saved script to tag.');
        script.tags = core.tags(message.tags); script.revision++;
      } else if (message.type === 'US_MOVE') {
        if (!script || ![-1, 1].includes(message.direction)) throw new Error('Choose a script and move it earlier or later.');
        if (!same(message.order, before.scripts.map(item => item.id))) throw new Error('The script order changed in another window. Refresh and try again.');
        const index = next.scripts.indexOf(script), destination = index + message.direction;
        if (destination < 0 || destination >= next.scripts.length) throw new Error('The script is already at this end of the library.');
        next.scripts.splice(index, 1); next.scripts.splice(destination, 0, script);
      } else if (message.type === 'US_ENABLE') {
        if (!script || typeof message.enabled !== 'boolean') throw new Error('Choose a saved script and a valid enable state.');
        if (message.enabled) await network.verify(script);
        Object.assign(script, { enabled: message.enabled, autoPageApproved: message.enabled && core.parse(script.source).injection === 'auto',
          revision: script.revision + 1, token: token() });
      } else if (message.type === 'US_ASSET_READ') {
        const asset = script?.assets?.[message.index];
        if (!asset) throw new Error('Choose a prepared dependency.');
        return { ok: true, asset: { ...asset, text: new TextDecoder().decode(core.decodeAsset(asset.body)) } };
      } else if (message.type === 'US_DELETE') {
        if (!script) throw new Error('Choose a saved script to delete.');
        next.scripts = next.scripts.filter(item => item.id !== script.id);
      } else throw new Error('Unknown userscript command.');
      const response = await commit(before, next, next.enabled && message.type === 'US_ENABLE' && message.enabled);
      return { ...response, selectedId: message.type === 'US_DELETE' ? null : script.id };
    }
    async function fetchSource(message) {
      // Source bytes stay in the manager's read-only review until approval. They
      // survive a worker restart there; applying never fetches a second version.
      const job = await enqueue(async () => {
        if (typeof message.requestId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.requestId)) throw new Error('Invalid script download ID.');
        if (sourceJobs.has(message.requestId) || sourceJobs.size >= 4) throw new Error('Script downloads are already busy.');
        const library = await read();
        let script, url = message.url;
        if (message.type === 'US_CHECK_UPDATE') {
          script = library.scripts.find(item => item.id === message.id);
          if (!script || script.revision !== message.revision) throw new Error('This script changed. Refresh and reopen it.');
          if (!script.sourceURL) throw new Error('No installed URL. Use Install from URL to review and link this script first.');
          url = script.sourceURL;
        }
        const job = { requestId: message.requestId, url: core.sourceURL(url), scriptId: script?.id,
          revision: script?.revision, controller: new AbortController() };
        sourceJobs.set(job.requestId, job); return job;
      });
      const timer = setTimeout(() => job.controller.abort(new Error('Script download timed out.')), network.LIMITS.timeout);
      try {
        const source = await network.fetchSource(job.url, job.controller.signal);
        return await enqueue(async () => {
          job.controller.signal.throwIfAborted();
          const library = await read(), metadata = core.parse(source);
          const script = job.scriptId ? library.scripts.find(item => item.id === job.scriptId) : library.scripts.find(item => {
            const previous = core.parse(item.source); return previous.name === metadata.name && previous.namespace === metadata.namespace;
          });
          if (job.scriptId && (!script || script.revision !== job.revision)) throw new Error('This script changed during the update check. Check again.');
          return { ok: true, review: core.sourceReview(source, job.url, script) };
        });
      } finally { clearTimeout(timer); if (sourceJobs.get(job.requestId) === job) sourceJobs.delete(job.requestId); }
    }
    async function prepareAssets(message) {
      // Only admission and the final commit use the manager queue. Downloads
      // cannot monopolize it, so edits, cancellation and disable stay responsive.
      const job = await enqueue(async () => {
        const library = await read(), script = library.scripts.find(item => item.id === message.id);
        if (!script || script.revision !== message.revision) throw new Error('This script changed. Refresh and reopen it.');
        if (script.enabled) throw new Error('Disable this script before preparing dependencies.');
        const metadata = core.parse(script.source);
        if (!core.assetSpecs(metadata).length) throw new Error('This script has no dependencies.');
        if (assetJobs.has(script.id) || assetJobs.size >= 4) throw new Error('Dependency preparation is already busy.');
        const job = { id: script.id, revision: script.revision, metadata, controller: new AbortController() };
        assetJobs.set(script.id, job); return job;
      });
      const timer = setTimeout(() => job.controller.abort(new Error('Dependency download timed out.')), network.LIMITS.timeout);
      try {
        const assets = await network.prepare(job.metadata, job.controller.signal);
        return await enqueue(async () => {
          job.controller.signal.throwIfAborted();
          const before = await read(), next = clone(before), script = next.scripts.find(item => item.id === job.id);
          if (assetJobs.get(job.id) !== job || !script || script.revision !== job.revision || script.enabled) throw new Error('The script changed during preparation. Downloaded data was discarded.');
          script.assets = assets; script.revision++; script.token = token();
          const result = await commit(before, next);
          return { ...result, selectedId: script.id };
        });
      } finally { clearTimeout(timer); if (assetJobs.get(job.id) === job) assetJobs.delete(job.id); }
    }
    async function currentFrame(sender) {
      const key = sender.tab.id + ':' + sender.frameId;
      if (frameProbes.has(key) || frameProbes.size >= 16) throw new Error('The page scope check is still pending. Try again when the page responds.');
      const pending = Promise.resolve().then(() => api.scripting.executeScript({
        target: { tabId: sender.tab.id, frameIds: [sender.frameId] }, world: 'ISOLATED', injectImmediately: true, func: () => location.href }));
      frameProbes.set(key, pending);
      // Native execution cannot be cancelled. Retain its slot until it settles
      // so an unresponsive renderer cannot accumulate abandoned injections.
      const release = () => frameProbes.delete(key);
      pending.then(release, release);
      let timer;
      try {
        return await Promise.race([pending, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The page scope check timed out. Reload a responsive matching page.')), 2000);
        })]);
      } finally { clearTimeout(timer); }
    }
    async function authorize(message, sender) {
      validateValueRequest(message, sender);
      const library = await read(), script = library.scripts.find(item => item.id === message.id);
      if (!library.enabled || !script?.enabled || message.token !== script.token) throw new Error('This userscript is inactive or its capability has expired. Reload the page.');
      const metadata = core.parse(script.source);
      const permitted = message.operation === 'diagnostic' ? needsStorage(script.source) : message.operation === 'connect'
        ? ['getValue', 'getValues', 'listValues', 'addValueChangeListener', 'registerMenuCommand', 'unregisterMenuCommand', 'xmlhttpRequest', 'openInTab', 'setClipboard', 'notification', 'download', 'cookie'].some(name => granted(metadata, name))
        : granted(metadata, VALUE_METHODS[message.operation]) || message.operation === 'menus' &&
          Array.isArray(message.menus) && !message.menus.length && granted(metadata, 'unregisterMenuCommand');
      if (core.nativeWorld(metadata) !== 'USER_SCRIPT' || !permitted ||
          !core.allows(metadata, sender.url) || (!metadata.allFrames && sender.frameId !== 0) ||
          (sender.userScriptWorldId !== undefined && sender.userScriptWorldId !== core.nativeId(script.id))) throw new Error('This userscript is not allowed to perform that storage operation here.');
      const available = await access();
      if (!available.available) throw new Error(available.error);
      if (!available.scripts.some(item => item.worldId === core.nativeId(script.id))) throw new Error('This userscript is no longer registered.');
      // Chromium can retain the original MessageSender URL after pushState.
      // Read this frame's live URL in our isolated extension world using the
      // existing scripting permission; never trust a URL supplied by a script.
      const pageURL = await verifyFrame(metadata, sender);
      return { library, script, metadata, pageURL };
    }
    async function verifyFrame(metadata, sender) {
      const frames = await currentFrame(sender);
      const frame = frames.find(item => item.frameId === sender.frameId);
      if (!frame || frame.error || sender.documentId && frame.documentId && sender.documentId !== frame.documentId ||
          !core.allows(metadata, frame.result)) throw new Error('This userscript is outside its current page scope. Reload a matching page.');
      return frame.result;
    }
    async function cookieRequest(message, metadata, sender, pageURL, connection) {
      if (!connection) throw new Error('Cookies require a native userscript connection.');
      if (cookieJobs.size >= 8 || [...cookieJobs.values()].filter(owner => owner.scriptId === connection.scriptId).length >= 2)
        throw new Error('Earlier native cookie operations are still pending.');
      const controller = new AbortController(); cookieJobs.set(controller, connection);
      const verify = async () => {
        controller.signal.throwIfAborted();
        if (connections.get(connection.id) !== connection) throw new Error('This userscript connection has expired.');
        await verifyFrame(metadata, sender);
        controller.signal.throwIfAborted();
      };
      let submitted = false;
      const onWriteDispatch = () => { controller.signal.throwIfAborted(); submitted = true; };
      const pending = BlockAdsUserScriptActions.cookieRequest(api, message.method, message.details, metadata, sender, pageURL, verify, onWriteDispatch);
      // Native cookie calls cannot be cancelled. Retain their admission slots
      // until they settle. Revocation blocks new writes and late reads, but an
      // already submitted write must report its native outcome without rollback.
      const release = () => cookieJobs.delete(controller); pending.then(release, release);
      let abort, timer;
      const expired = new Promise((_, reject) => {
        abort = () => { if (!submitted) reject(controller.signal.reason); };
        controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
          const error = new Error(submitted
            ? 'Native cookie write timed out after submission; its outcome is unknown and it may still complete. It will not be retried.'
            : 'Native cookie operation timed out; it will not be retried.');
          // Revocation may have aborted the controller already. The deadline
          // still releases the broker queue while the native call retains a slot.
          controller.abort(error); reject(error);
        }, 2000);
      });
      try { return await Promise.race([pending, expired]); }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
    }
    const sameDocument = (a, b) => a.tab.id === b.tab.id && a.frameId === b.frameId && a.documentId === b.documentId;
    const storageKey = key => {
      if (typeof key !== 'string' || !key || key.length > 256) throw new Error('Use a nonempty storage key of at most 256 characters.');
      return key;
    };
    const storageKeys = keys => {
      if (!Array.isArray(keys) || keys.length > 256) throw new Error('Use an array of up to 256 storage keys.');
      return [...new Set(keys.map(storageKey))];
    };
    function menuItems(items) {
      if (!Array.isArray(items) || items.length > 32) throw new Error('At most 32 menu commands per script instance.');
      const ids = new Set();
      return items.map(item => {
        if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || ids.has(item.id) ||
            typeof item.caption !== 'string' || !item.caption.trim() || item.caption.length > 256 ||
            typeof item.title !== 'string' || item.title.length > 512 || typeof item.accessKey !== 'string' ||
            item.accessKey.length > 1 || typeof item.autoClose !== 'boolean') throw new Error('Invalid menu command.');
        ids.add(item.id);
        return { id: item.id, caption: item.caption, title: item.title, accessKey: item.accessKey, autoClose: item.autoClose, icon: core.safeMenuIcon(item.icon) };
      });
    }
    async function valueRequest(message, sender) {
      const { library, script, metadata, pageURL } = await authorize(message, sender);
      const connection = message.connectionId && connections.get(message.connectionId);
      if (message.connectionId && (!connection?.ready || connection.scriptId !== script.id || connection.token !== script.token ||
          !sameDocument(connection.sender, sender))) throw new Error('This userscript connection has expired.');
      if (message.operation === 'openTab' || message.operation === 'closeTab') return tabRequest(message, sender, script, connection);
      if (message.operation === 'cookie') return cookieRequest(message, metadata, sender, pageURL, connection);
      if (['clipboard', 'notification', 'removeNotification', 'download', 'abortDownload'].includes(message.operation)) return actions.request(message, script, metadata, connection);
      if (message.operation === 'request' || message.operation === 'abortRequest') {
        if (!connection) throw new Error('Network requests require a native userscript connection.');
        if (typeof message.requestId !== 'string' || !/^[0-9]{1,16}$/.test(message.requestId)) throw new Error('Invalid request ID.');
        const key = connection.id + ':' + message.requestId;
        if (message.operation === 'abortRequest') { requests.get(key)?.controller.abort(); return { ok: true }; }
        const active = [...requests.values()];
        if (requests.has(key) || active.length >= 32 || active.filter(item => item.connection === connection).length >= 4 ||
            active.filter(item => item.connection.sender.tab.id === sender.tab.id).length >= 8 ||
            active.filter(item => item.connection.scriptId === script.id).length >= 8) throw new Error('Too many active userscript network requests.');
        const details = network.validate(message.details, metadata, sender.url), controller = new AbortController();
        const job = { connection, controller }; requests.set(key, job);
        // Authorize synchronously with other state changes, then release the
        // runner. Accepted requests are never retried after a worker restart.
        void network.request(details, controller, payload => {
          if (requests.get(key) !== job || !connections.has(connection.id)) return;
          try { connection.port.postMessage({ type: 'request', requestId: message.requestId, ...payload }); }
          catch { dropConnection(connection); }
        }).finally(() => { if (requests.get(key) === job) requests.delete(key); });
        return { ok: true };
      }
      if (message.operation === 'menus') {
        if (!connection) throw new Error('Menu commands require a native userscript connection.');
        connection.menus = menuItems(message.menus); return { ok: true };
      }
      if (message.operation === 'list') return { ok: true, keys: Object.keys(script.values) };
      if (message.operation === 'getMany') {
        const query = message.query;
        const names = query === undefined ? Object.keys(script.values) : Array.isArray(query) ? storageKeys(query) : Object.keys(core.validateValues(query));
        return { ok: true, values: Object.fromEntries(names.filter(name => Object.hasOwn(script.values, name)).map(name => [name, script.values[name]])) };
      }
      const key = ['get', 'set', 'delete'].includes(message.operation) ? storageKey(message.key) : undefined;
      if (message.operation === 'get') return Object.hasOwn(script.values, key) ? { ok: true, exists: true, value: script.values[key] } : { ok: true, exists: false };
      const before = clone(library);
      const values = new Map(Object.entries(script.values));
      if (message.operation === 'delete' || message.operation === 'deleteMany') {
        for (const name of key === undefined ? storageKeys(message.keys) : [key]) values.delete(name);
      } else if (message.operation === 'setMany') {
        for (const [name, value] of Object.entries(core.validateValues(message.values))) values.set(name, value);
      } else values.set(key, core.jsonValue(message.value));
      script.values = core.validateValues(Object.fromEntries(values));
      library.revision++;
      try {
        await api.storage.local.set({ [KEY]: core.library(library) });
        if (!same(await read(), library)) throw new Error('Script values could not be verified after saving.');
      } catch (error) {
        try {
          await api.storage.local.set({ [KEY]: before });
          if (!same(await read(), before)) throw new Error('Script value rollback could not be verified.');
        } catch (rollback) {
          for (const connection of connections.values()) if (connection.scriptId === script.id) closeConnection(connection);
          throw new Error(errorText(error) + ' Value rollback failed: ' + errorText(rollback));
        }
        throw error;
      }
      for (const subscriber of connections.values()) {
        if (!subscriber.ready || subscriber.scriptId !== script.id || subscriber.token !== script.token) continue;
        try { subscriber.port.postMessage({ type: 'values', origin: connection?.id, ...valueSnapshot(script, subscriber.metadata, library.revision) }); }
        catch { dropConnection(subscriber); }
      }
      return { ok: true, ...valueSnapshot(script, metadata, library.revision) };
    }
    async function menuCommand(message) {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('Choose a page tab for script commands.');
      const library = await read(), available = await access();
      reconcileConnections(library, available.available);
      if (message.type === 'US_MENU_LIST') return { ok: true, active: library.enabled && available.available, commands: [...connections.values()]
        .filter(item => item.ready && item.sender.tab.id === message.tabId)
        .flatMap(item => item.menus.map(menu => ({ ...menu, connectionId: item.id, scriptName: item.metadata.name, frameId: item.sender.frameId }))) };
      const connection = connections.get(message.connectionId), menu = connection?.menus.find(item => item.id === message.menuId);
      if (!menu || connection.sender.tab.id !== message.tabId) throw new Error('This menu command has expired. Refresh the popup.');
      await authorize({ type: 'US_VALUE', operation: 'menus', id: connection.scriptId, token: connection.token }, connection.sender);
      const event = Object.fromEntries(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'].map(key => [key, message.event?.[key] === true]));
      connection.port.postMessage({ type: 'menu', id: menu.id, event });
      return { ok: true, autoClose: menu.autoClose };
    }
    const start = () => enqueue(async () => {
      try { await snapshot(); }
      catch (error) {
        lastError = errorText(error);
        for (const connection of connections.values()) closeConnection(connection);
        // Invalid persistent data must not leave old scripts executing, or erase it.
        try { const current = await access(); if (current.available) await apply({ scripts: [], worlds: [] }, current); }
        catch (cleanup) { lastError += ' Could not remove stale registrations: ' + errorText(cleanup); }
      }
    });
    bindMessages();
    api.permissions?.onAdded?.addListener(() => { void start(); });
    api.permissions?.onRemoved?.addListener(() => { void start(); });
    api.tabs?.onRemoved?.addListener(tabId => {
      for (const job of tabs.values()) if (job.tabId === tabId) tabEvent(job, 'closed');
      for (const connection of connections.values()) if (connection.sender.tab.id === tabId) closeConnection(connection);
    });
    api.tabs?.onUpdated?.addListener((tabId, change) => {
      // A same-document navigation may move a top-frame script outside its
      // declared scope without disconnecting its native port.
      if (!change.url) return;
      for (const connection of connections.values()) if (connection.ready && connection.sender.tab.id === tabId &&
          connection.sender.frameId === 0 && !core.allows(connection.metadata, change.url)) closeConnection(connection);
    });
    return Object.freeze({
      start,
      inspect: () => enqueue(inspect),
      setDiagnosticSink: sink => { diagnosticSink = typeof sink === 'function' ? sink : null; diagnosticRates.clear(); },
      request: message => message.type === 'US_PREPARE_ASSETS' ? prepareAssets(message)
        : ['US_FETCH_SOURCE', 'US_CHECK_UPDATE'].includes(message.type) ? fetchSource(message) : enqueue(() => command(message)),
      state: () => enqueue(async () => {
        const result = await snapshot();
        return { enabled: result.enabled, active: result.active, available: result.available,
          count: result.scripts.filter(script => script.enabled).length, error: result.error, needsPermission: result.needsPermission };
      }),
      setEnabled: enabled => enqueue(async () => {
        if (typeof enabled !== 'boolean') throw new Error('Invalid userscript module switch.');
        if (!enabled) { for (const job of assetJobs.values()) job.controller.abort(); assetJobs.clear(); }
        if (!enabled) { for (const job of sourceJobs.values()) job.controller.abort(new Error('Userscripts were paused. Script download cancelled.')); sourceJobs.clear(); }
        const before = await read(), next = clone(before); next.enabled = enabled;
        if (enabled !== before.enabled) for (const script of next.scripts) script.token = token();
        return commit(before, next, enabled);
      })
    });
  }
  globalThis.BlockAdsUserScripts = Object.freeze({ create, KEY });
})();
