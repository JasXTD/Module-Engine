/* Scheduled userscript update checks and .user.js link interception.
   Downloads stay inert review data: nothing here saves, applies or runs script
   code. With autoApply on, a staged update is passed to the runtime's `apply`,
   which installs it only if it needs no new access (core.accessChange). */
(() => {
  'use strict';
  const core = globalThis.BlockAdsUserScriptCore;
  const KEY = 'userscriptUpdates', LIBRARY = 'userscriptManager', ALARM = 'userscriptUpdateCheck';
  const MANAGER = 'src/ui/manager/manager.html';
  const LIMITS = Object.freeze({ interval: 24 * 60 * 60 * 1000, alarmMinutes: 60, firstDelayMinutes: 5, meta: 64 * 1024,
    staged: 1024 * 1024, timeout: 30000, message: 512, intercepts: 8, interceptWindow: 60000, tabWindow: 2000,
    bypass: 15000, bypasses: 64 });
  const OUTCOMES = new Set(['current', 'staged', 'available', 'error', 'skipped', 'applied']);
  // Saved settings that fail validation turn every automatic behavior off.
  const CLOSED = Object.freeze({ interceptLinks: false, autoCheck: false, autoApply: false });
  const ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  const FILTER = Object.freeze({ types: ['main_frame'], urls: ['http://*/*.user.js', 'https://*/*.user.js', 'http://*/*.user.js?*', 'https://*/*.user.js?*'] });
  const fail = message => { throw new Error(message); };
  const errorText = error => String(error?.message || error).slice(0, LIMITS.message);
  const clone = value => JSON.parse(JSON.stringify(value));
  // Chromium storage returns object keys sorted; verification compares content only.
  const canonical = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
  const defaults = () => ({ schemaVersion: 1, interceptLinks: true, autoCheck: true, autoApply: true, scripts: {} });
  const hex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  // A check result belongs to the exact installed source and URL it compared
  // against, not to the record revision: toggling or tagging keeps it current.
  const baseline = async script => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode((script.sourceURL || '') + '\n' + script.source)));

  function declaredURL(metadata, key) {
    const value = metadata.informational?.[key];
    if (!value) return null;
    try { return core.sourceURL(value); } catch { return undefined; }
  }
  // Violentmonkey-compatible destinations: @downloadURL, else the approved
  // install URL, provides the new source; @updateURL, else that same URL,
  // provides the version. Only scripts linked through a reviewed URL install
  // are checked; a local script's @downloadURL is offered for a manual review.
  function targets(script) {
    const metadata = core.parse(script.source), notes = [];
    const download = declaredURL(metadata, 'downloadURL'), update = declaredURL(metadata, 'updateURL');
    if (download === undefined) notes.push('@downloadURL is not a usable HTTPS URL, so the installed URL is used.');
    if (update === undefined) notes.push('@updateURL is not a usable HTTPS URL, so versions are checked by downloading the script.');
    const linked = script.sourceURL ? core.sourceURL(script.sourceURL) : null, source = linked && (download || linked);
    return { download: source || null, version: source && update && update !== source ? update : null,
      suggested: !linked && download ? download : null, automatic: Boolean(source && metadata.explicitVersion), notes };
  }
  // Metadata files may carry keys the strict parser rejects; only one
  // @version line in a well-formed leading block is read.
  function metaVersion(text) {
    if (typeof text !== 'string') return null;
    const block = core.metadataBlock(text);
    if (block === null || block.length > 16384) return null;
    // Greedy capture, trimmed afterwards: a lazy value before trailing blanks was quadratic.
    const versions = [...block.matchAll(/^[ \t]*\/\/[ \t]*@version[ \t]+(\S[^\r\n]*)$/gm)].map(match => match[1].trimEnd());
    return versions.length === 1 && versions[0].length <= 2048 ? versions[0] : null;
  }
  function state(raw) {
    if (raw === undefined) return defaults();
    // autoApply is newer than the other settings: a saved state without it
    // takes the default.
    if (!raw || typeof raw !== 'object' || raw.schemaVersion !== 1 || typeof raw.interceptLinks !== 'boolean' ||
        typeof raw.autoCheck !== 'boolean' || raw.autoApply !== undefined && typeof raw.autoApply !== 'boolean' ||
        !raw.scripts || typeof raw.scripts !== 'object' || Array.isArray(raw.scripts)) fail('Saved update settings are invalid. Automatic checks, updates and link interception are off until you change a setting.');
    // Entries are a cache of check results. A damaged entry is dropped and
    // simply checked again; it can never become an approval.
    const scripts = {}; let staged = 0;
    for (const [id, entry] of Object.entries(raw.scripts)) {
      if (Object.keys(scripts).length >= core.LIMITS.scripts || !ID.test(id) || !entry || typeof entry !== 'object' ||
          typeof entry.base !== 'string' || !/^[a-f0-9]{64}$/.test(entry.base) || !Number.isSafeInteger(entry.checkedAt) ||
          entry.checkedAt < 0 || !OUTCOMES.has(entry.outcome) ||
          entry.message !== undefined && (typeof entry.message !== 'string' || entry.message.length > LIMITS.message) ||
          entry.version !== undefined && (typeof entry.version !== 'string' || !entry.version || entry.version.length > 2048) ||
          (entry.outcome === 'staged') !== (entry.staged !== undefined)) continue;
      const result = { base: entry.base, checkedAt: entry.checkedAt, outcome: entry.outcome,
        ...(entry.message ? { message: entry.message } : {}), ...(entry.version ? { version: entry.version } : {}) };
      if (entry.staged !== undefined) {
        let size;
        try {
          if (!entry.staged || typeof entry.staged !== 'object' || Object.keys(entry.staged).sort().join() !== 'source,sourceURL') throw new Error();
          core.parse(entry.staged.source); core.sourceURL(entry.staged.sourceURL); size = core.bytes(entry.staged.source);
        } catch { continue; }
        if (staged + size > LIMITS.staged) continue;
        staged += size; result.staged = { source: entry.staged.source, sourceURL: entry.staged.sourceURL };
      }
      scripts[id] = result;
    }
    return { schemaVersion: 1, interceptLinks: raw.interceptLinks, autoCheck: raw.autoCheck, autoApply: raw.autoApply ?? true, scripts };
  }
  function interceptURL(details) {
    // Prerendered and other non-active documents are never navigated: only a
    // committed top-level GET in a real tab is treated as an install click.
    if (!details || details.type !== 'main_frame' || details.method !== 'GET' || !Number.isInteger(details.tabId) ||
        details.tabId < 0 || details.frameId !== 0 || details.documentLifecycle === 'prerender' ||
        details.frameType !== undefined && details.frameType !== 'outermost_frame' || typeof details.url !== 'string') return null;
    let url; try { url = new URL(details.url); } catch { return null; }
    url.hash = '';
    if (!/\.user\.js$/i.test(url.pathname)) return null;
    try { return core.sourceURL(url.href); } catch { return null; }
  }
  const installHash = url => '#install=' + encodeURIComponent(core.sourceURL(url));
  function installFromHash(hash) {
    const match = /^#install=([^#&]+)$/.exec(typeof hash === 'string' ? hash : '');
    if (!match) return null;
    try { return core.sourceURL(decodeURIComponent(match[1])); } catch { return null; }
  }

  // apply({ id, revision, source, sourceURL }) resolves to { applied, reason } or
  // { applied, name, version }; log records an extension event.
  function create(api, { network, now = () => Date.now(), apply, log } = {}) {
    if (!network?.fetchSource) fail('Update checks need the bounded source downloader.');
    let writes = Promise.resolve(), run = null;
    const recent = [], tabTimes = new Map(), bypasses = new Map();
    const readLibrary = async () => core.library((await api.storage.local.get(LIBRARY))[LIBRARY]);
    const readRaw = async () => (await api.storage.local.get(KEY))[KEY];
    async function readState() {
      try { return state(await readRaw()); }
      catch (error) { return { schemaVersion: 1, ...CLOSED, scripts: {}, error: errorText(error) }; }
    }
    // Preference writes and the final install share a queue. A completed opt-out
    // therefore also covers an install that had already entered its native commit.
    function serialize(work) {
      const task = writes.then(work);
      writes = task.catch(() => {});
      return task;
    }
    function update(mutate, repair = false) {
      return serialize(async () => {
        const raw = await readRaw();
        let current;
        try { current = state(raw); }
        catch (error) { if (!repair) throw error; current = { schemaVersion: 1, ...CLOSED, scripts: {} }; }
        const next = clone(current);
        if (await mutate(next) === false) return current;
        const normalized = state(next);
        // A rejected write changes nothing; only a written but unverified value is rolled back.
        await api.storage.local.set({ [KEY]: normalized });
        try {
          if (canonical(await readRaw()) !== canonical(normalized)) fail('Update settings could not be verified after saving.');
        } catch (error) {
          try { await api.storage.local.set({ [KEY]: raw === undefined ? defaults() : raw }); }
          catch (rollback) { throw new Error(errorText(error) + ' Rollback also failed: ' + errorText(rollback)); }
          throw error;
        }
        return normalized;
      });
    }
    async function prune(next, library) {
      const bases = new Map(await Promise.all(library.scripts.map(async script => [script.id, await baseline(script)])));
      for (const [id, entry] of Object.entries(next.scripts)) if (bases.get(id) !== entry.base) delete next.scripts[id];
      return bases;
    }
    async function bounded(signal, work) {
      const controller = new AbortController(), abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const timer = setTimeout(() => controller.abort(new Error('Update check timed out.')), LIMITS.timeout);
      try { return await work(controller.signal); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    async function fetchMetadata(url, signal) {
      // Same transport rules as source downloads: no cookies, referrer, cache or redirects.
      const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      try {
        if (!response.ok) fail('Version check returned HTTP ' + response.status + '.');
        if (/(?:text\/html|application\/xhtml)/i.test(response.headers.get('content-type') || '')) fail('The @updateURL returned HTML.');
        if (Number(response.headers.get('content-length')) > LIMITS.meta) fail('The @updateURL response exceeds 64 KiB.');
        if (!response.body) return '';
        const reader = response.body.getReader(), chunks = []; let loaded = 0;
        try {
          for (;;) {
            signal.throwIfAborted();
            const { value, done } = await reader.read();
            if (done) break;
            loaded += value.length;
            if (loaded > LIMITS.meta) fail('The @updateURL response exceeds 64 KiB.');
            chunks.push(value);
          }
        } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
        const bytes = new Uint8Array(loaded); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail('The @updateURL response must be valid UTF-8 text.'); }
      } finally { if (response.body && !response.body.locked) await response.body.cancel(); }
    }
    async function check(script, signal) {
      const plan = targets(script), installed = core.parse(script.source).explicitVersion;
      if (!installed) return { outcome: 'skipped', message: 'Automatic checks need an @version. Use Check for updates to review changes.' };
      if (plan.version) {
        const remote = metaVersion(await bounded(signal, inner => fetchMetadata(plan.version, inner)));
        if (!remote) fail('The @updateURL response has no single @version in a metadata block.');
        const change = core.compareVersions(remote, installed);
        if (change === null) fail('The @updateURL version ' + remote + ' cannot be compared with ' + installed + '.');
        if (change !== 1) return { outcome: 'current', version: remote };
      }
      const source = await bounded(signal, inner => network.fetchSource(plan.download, inner));
      const review = core.sourceReview(source, plan.download, script), version = review.metadata.explicitVersion;
      if (review.versionChange === null) fail('The downloaded @version is missing or cannot be compared. Use Check for updates to review it.');
      if (review.versionChange !== 1) return { outcome: 'current', ...(version ? { version } : {}) };
      return { outcome: 'staged', version, staged: { source, sourceURL: review.sourceURL } };
    }
    function record(script, base, result) {
      return update(async next => {
        const library = await readLibrary(), bases = await prune(next, library);
        // A script edited, re-linked or deleted during the download keeps no stale result.
        if (bases.get(script.id) !== base) return;
        const entry = { base, checkedAt: now(), outcome: result.outcome,
          ...(result.message ? { message: errorText(result.message) } : {}), ...(result.version ? { version: result.version } : {}) };
        if (result.staged) {
          const used = Object.entries(next.scripts).reduce((total, [id, item]) => total + (id !== script.id && item.staged ? core.bytes(item.staged.source) : 0), 0);
          // Over budget, only the available version is kept; review downloads it again.
          if (used + core.bytes(result.staged.source) <= LIMITS.staged) entry.staged = result.staged;
          else entry.outcome = 'available';
        }
        next.scripts[script.id] = entry;
      });
    }
    // After an automatic install the script's source is the update, so its
    // record moves to the new baseline and the next check waits a full day.
    async function markApplied(id, version) {
      const script = (await readLibrary()).scripts.find(item => item.id === id);
      if (!script) return;
      const base = await baseline(script);
      await update(async next => {
        const bases = await prune(next, await readLibrary());
        if (bases.get(id) !== base) return false;
        next.scripts[id] = { base, checkedAt: now(), outcome: 'applied', ...(version ? { version } : {}) };
      });
    }
    // Why a downloaded update was left for review, shown beside it.
    function explain(id, base, reason) {
      return update(next => {
        const entry = next.scripts[id];
        if (!entry || entry.base !== base || !['staged', 'available'].includes(entry.outcome)) return false;
        entry.message = errorText('Waiting for your review: ' + reason + '.');
      });
    }
    function runChecks({ force = false } = {}) {
      if (run) return run.promise;
      const controller = new AbortController(), signal = controller.signal;
      const promise = (async () => {
        const [settings, library] = await Promise.all([readState(), readLibrary()]);
        if (!force && (!settings.autoCheck || !library.enabled)) return { checked: 0, staged: 0, applied: 0 };
        let checked = 0, staged = 0, applied = 0;
        // Sequential and bounded: at most one update download at a time.
        for (const script of library.scripts) {
          if (signal.aborted) break;
          if (!targets(script).download) continue;
          const base = await baseline(script), entry = settings.scripts[script.id], time = now();
          if (!force && entry?.base === base && entry.checkedAt <= time && time - entry.checkedAt < LIMITS.interval) continue;
          let result;
          try { result = await check(script, signal); }
          catch (error) { if (signal.aborted) break; result = { outcome: 'error', message: errorText(error) }; }
          if (signal.aborted) break;
          let saved = await record(script, base, result);
          checked++;
          // An update that needs no new access is installed now when allowed;
          // any other waits for review, with the reason shown.
          if (result.outcome === 'staged' && settings.autoApply && apply) {
            let outcome;
            try {
              outcome = await serialize(async () => {
                if (!(await readState()).autoApply || signal.aborted) return null;
                return apply({ id: script.id, revision: script.revision, ...result.staged }, signal);
              });
            }
            catch (error) { outcome = { applied: false, reason: 'it could not be installed automatically (' + errorText(error) + ')' }; }
            if (outcome?.applied) {
              applied++;
              await markApplied(script.id, outcome.version);
              try { await log?.({ kind: 'event', message: `Updated userscript "${outcome.name}" to ${outcome.version} automatically; it asks for no new access` }); }
              catch (error) { console.warn('[Module Engine] Could not log an automatic userscript update:', errorText(error)); }
              continue;
            }
            if (outcome && !signal.aborted) saved = await explain(script.id, base, outcome.reason || 'it could not be installed automatically');
          }
          if (saved.scripts[script.id]?.outcome === 'staged') staged++;
        }
        return { checked, staged, applied, cancelled: signal.aborted };
      })();
      run = { controller, promise };
      const release = () => { if (run?.promise === promise) run = null; };
      promise.then(release, release);
      return promise;
    }
    function cancel(reason = 'Update checks were cancelled.') {
      run?.controller.abort(new Error(reason));
    }
    async function view() {
      const [library, settings] = await Promise.all([readLibrary(), readState()]), scripts = {};
      for (const script of library.scripts) {
        const entry = settings.scripts[script.id], current = entry?.base === await baseline(script);
        scripts[script.id] = { ...targets(script), ...(current ? { checkedAt: entry.checkedAt, outcome: entry.outcome,
          ...(entry.message ? { message: entry.message } : {}), ...(entry.version ? { available: entry.version } : {}) } : {}) };
      }
      return { ok: true, interceptLinks: settings.interceptLinks, autoCheck: settings.autoCheck, autoApply: settings.autoApply, error: settings.error || '',
        checking: Boolean(run), scripts };
    }
    async function setSettings(patch) {
      const changes = Object.entries(patch || {}).filter(([key]) => ['interceptLinks', 'autoCheck', 'autoApply'].includes(key));
      if (!changes.length || changes.some(([, value]) => typeof value !== 'boolean')) fail('Choose a valid update setting.');
      if (patch.autoCheck === false || patch.autoApply === false) cancel('Automatic update checks or installs were turned off.');
      await update(next => { Object.assign(next, Object.fromEntries(changes)); }, true);
      return view();
    }
    async function stagedReview(message) {
      const library = await readLibrary(), script = library.scripts.find(item => item.id === message?.id);
      if (!script || script.revision !== message.revision) fail('This script changed. Refresh and reopen it.');
      const entry = (await readState()).scripts[script.id];
      if (!entry?.staged || entry.base !== await baseline(script)) fail('This downloaded update is no longer current. Use Check for updates.');
      // The same review contract as a manual check; approval applies these exact bytes.
      return { ok: true, review: core.sourceReview(entry.staged.source, entry.staged.sourceURL, script), checkedAt: entry.checkedAt };
    }
    function allowNavigation(tabId, url) {
      // One-shot passage for a URL the review page found is not a direct userscript.
      if (!Number.isInteger(tabId) || tabId < 0) fail('Open the file from a browser tab.');
      const target = core.sourceURL(url);
      for (const [id, item] of bypasses) if (now() - item.time >= LIMITS.bypass) bypasses.delete(id);
      if (!bypasses.has(tabId) && bypasses.size >= LIMITS.bypasses) fail('Too many pending file openings. Try again shortly.');
      bypasses.set(tabId, { url: target, time: now() });
      return { ok: true };
    }
    function bypassed(tabId, url) {
      const item = bypasses.get(tabId);
      if (!item) return false;
      bypasses.delete(tabId);
      return item.url === url && now() - item.time < LIMITS.bypass;
    }
    function admitted(tabId) {
      // A page cannot use repeated script links to keep replacing tabs.
      const time = now();
      while (recent.length && time - recent[0] >= LIMITS.interceptWindow) recent.shift();
      for (const [id, last] of tabTimes) if (time - last >= LIMITS.tabWindow) tabTimes.delete(id);
      if (recent.length >= LIMITS.intercepts || tabTimes.has(tabId)) return false;
      recent.push(time); tabTimes.set(tabId, time);
      return true;
    }
    async function intercept(details) {
      const url = interceptURL(details);
      if (!url || bypassed(details.tabId, url)) return false;
      const [settings, library] = await Promise.all([readState(), readLibrary().catch(() => null)]);
      if (!settings.interceptLinks || !library?.enabled || !admitted(details.tabId)) return false;
      // The tab's own navigation is replaced by the review page; the extension
      // downloads the source separately without cookies.
      await api.tabs.update(details.tabId, { url: api.runtime.getURL(MANAGER) + installHash(url) });
      return true;
    }
    async function start() {
      if (!api.alarms) return;
      if (!await api.alarms.get(ALARM)) await api.alarms.create(ALARM, { delayInMinutes: LIMITS.firstDelayMinutes, periodInMinutes: LIMITS.alarmMinutes });
    }
    api.alarms?.onAlarm?.addListener(alarm => {
      if (alarm?.name === ALARM) void runChecks().catch(error => console.warn('[Module Engine] Scheduled userscript update check:', errorText(error)));
    });
    api.webRequest?.onBeforeRequest?.addListener(details => {
      void intercept(details).catch(error => console.warn('[Module Engine] Userscript link:', errorText(error)));
    }, { types: [...FILTER.types], urls: [...FILTER.urls] });
    // Backup takes this writer before the manager queue, matching auto-apply's
    // lock order. Never acquire it from an already running manager operation.
    return Object.freeze({ start, runChecks, cancel, view, setSettings, stagedReview, allowNavigation, intercept, exclusive: serialize });
  }
  globalThis.BlockAdsUserScriptUpdates = Object.freeze({ KEY, ALARM, MANAGER, LIMITS, FILTER, targets, metaVersion, state,
    interceptURL, installHash, installFromHash, create });
})();
