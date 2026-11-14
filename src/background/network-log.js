/* Optional metadata capture. These observers never cancel or alter traffic. */
(() => {
  'use strict';
  const KEY = 'moduleEngineNetworkLog', PORT = 'ME_NETWORK_LOG';
  const LIMIT = 2000, BYTE_LIMIT = 2 * 1024 * 1024, CAPTURE_MS = 30 * 60 * 1000;
  const READ_BYTE_LIMIT = 128 * 1024;
  const FINAL = new Set(['complete', 'redirect', 'error', 'interrupted']);
  const encoder = new TextEncoder();
  const bounded = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
  const stamp = value => Number.isFinite(value) && value >= 0 && value <= 8640000000000000 ? value : null;
  const integer = (value, fallback = -1) => Number.isSafeInteger(value) && value >= -1 ? value : fallback;
  function safeURL(value, originOnly = false) {
    if (typeof value !== 'string' || value.length > 16384) return '';
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '';
      return (url.origin + (originOnly ? '' : url.pathname)).slice(0, originOnly ? 300 : 1024);
    } catch { return ''; }
  }
  function errorCode(value) {
    // Browser errors are normally symbolic codes. Do not retain free-form text
    // that might echo a URL, credentials, a request body or a server response.
    return typeof value === 'string' && /^[a-zA-Z0-9_:.-]{1,120}$/.test(value)
      ? value : 'Browser error (details omitted)';
  }
  function cleanEntry(value) {
    if (!value || typeof value !== 'object' || !safeURL(value.url)) return null;
    return {
      requestId: bounded(value.requestId, 128), url: safeURL(value.url),
      method: bounded(value.method, 20), type: bounded(value.type, 32),
      tabId: integer(value.tabId), frameId: integer(value.frameId), initiator: safeURL(value.initiator, true),
      observedAt: stamp(value.observedAt) ?? 0, startedAt: stamp(value.startedAt), sentAt: stamp(value.sentAt),
      responseAt: stamp(value.responseAt), endedAt: stamp(value.endedAt),
      state: FINAL.has(value.state) ? value.state : 'interrupted',
      statusCode: Number.isInteger(value.statusCode) && value.statusCode >= 100 && value.statusCode <= 599 ? value.statusCode : null,
      fromCache: value.fromCache === true, redirectTo: safeURL(value.redirectTo),
      error: value.error ? errorCode(value.error) : '', partial: value.partial === true
    };
  }
  function create(api, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    let rows = [], bytes = 0, dropped = 0, sequence = 0, revision = 0;
    let capture = null, scope = null, reason = 'Capture is off.', restored = false, restoring = null;
    let dirty = false, saving = null, saveTimer = null, storageError = '', closed = false;
    let commands = Promise.resolve(), pendingCommands = 0;
    const sizes = new Map(), current = new Map(), ports = new Set(), listeners = [];
    const stages = ['onBeforeRequest', 'onSendHeaders', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred'];
    let available = stages.every(name => typeof api.webRequest?.[name]?.addListener === 'function') &&
      Boolean(api.runtime.onConnect && api.storage?.session?.get && api.storage.session.set);
    let unavailable = available ? '' : 'This browser cannot provide the network log APIs.';

    function resized(row) {
      bytes -= sizes.get(row.id) || 0;
      const size = encoder.encode(JSON.stringify(row)).length + 1;
      sizes.set(row.id, size); bytes += size;
      while (rows.length > LIMIT || bytes > BYTE_LIMIT - 4096) {
        const oldest = rows.shift();
        bytes -= sizes.get(oldest.id) || 0; sizes.delete(oldest.id);
        if (current.get(oldest.requestId) === oldest) current.delete(oldest.requestId);
        dropped++;
      }
    }
    function changed() {
      revision++; dirty = true;
      if (!saveTimer && !saving && !storageError && !closed) saveTimer = setTimer(() => {
        saveTimer = null; void flush().catch(() => {}); // flush exposes failures in status and stops capture.
      }, 500);
    }
    function stop(message, schedule = true) {
      if (!capture) return;
      clearTimer(capture.timer); capture = null; reason = message;
      for (const row of rows.slice()) if (sizes.has(row.id) && !FINAL.has(row.state)) { row.state = 'interrupted'; resized(row); }
      current.clear(); revision++; dirty = true;
      if (schedule) changed();
    }
    async function flush() {
      if (saveTimer) { clearTimer(saveTimer); saveTimer = null; }
      if (saving) await saving;
      if (!dirty) return;
      dirty = false;
      const snapshot = { schemaVersion: 1, entries: rows.map(row => ({ ...row })), dropped, tabId: scope };
      const write = Promise.resolve().then(() => api.storage.session.set({ [KEY]: snapshot }));
      saving = write;
      try { await write; storageError = ''; }
      catch (error) {
        storageError = 'Could not retain the network log in session memory. Capture has stopped; clear or start again to retry.';
        stop(storageError, false); dirty = true;
        throw new Error(storageError, { cause: error });
      } finally {
        if (saving === write) saving = null;
        if (dirty && !storageError && !closed) changed();
      }
    }
    async function restore() {
      if (restored) return;
      restoring ??= (async () => {
        const stored = (await api.storage.session.get(KEY))[KEY];
        if (stored?.schemaVersion === 1 && Array.isArray(stored.entries)) {
          for (const value of stored.entries.slice(-LIMIT)) {
            const row = cleanEntry(value);
            if (row) { row.id = ++sequence; rows.push(row); resized(row); }
          }
          dropped += Number.isSafeInteger(stored.dropped) && stored.dropped >= 0 ? stored.dropped : 0;
          scope = Number.isSafeInteger(stored.tabId) && stored.tabId >= 0 ? stored.tabId : null;
          reason = rows.length ? 'Retained log. Capture is off after background restart.' : 'Capture is off.';
        }
        restored = true; revision++;
      })().catch(error => { restoring = null; throw new Error('Could not read the retained network log. Try again.', { cause: error }); });
      await restoring;
    }
    function observe(stage, details) {
      if (!capture || closed) return;
      if (now() >= capture.expiresAt) { stop('Capture stopped after 30 minutes.'); return; }
      if (capture.tabId !== null && details.tabId !== capture.tabId) return;
      const url = safeURL(details.url), requestId = bounded(details.requestId, 128);
      if (!url || !requestId) return;
      const time = stamp(details.timeStamp) ?? now();
      let row = current.get(requestId);
      if (stage === 'onBeforeRequest') {
        if (row && !row.cleared && !FINAL.has(row.state)) { row.state = 'interrupted'; resized(row); }
        row = null;
      } else if (row?.cleared) {
        if (['onCompleted', 'onErrorOccurred', 'onBeforeRedirect'].includes(stage)) current.delete(requestId);
        return;
      } else if (row && FINAL.has(row.state)) return;
      if (!row) {
        // DNR and mid-flight capture can omit the start event. Retain the event
        // actually observed, without inventing a start time or duration.
        row = { id: ++sequence, requestId, url, method: bounded(details.method, 20), type: bounded(details.type, 32),
          tabId: integer(details.tabId), frameId: integer(details.frameId), initiator: safeURL(details.initiator || details.originUrl || details.documentUrl, true),
          observedAt: time, startedAt: stage === 'onBeforeRequest' ? time : null, sentAt: null, responseAt: null, endedAt: null,
          state: 'request', statusCode: null, fromCache: false, redirectTo: '', error: '', partial: stage !== 'onBeforeRequest' };
        rows.push(row); current.set(requestId, row);
        // Cleared in-flight markers also share this bound.
        while (current.size > LIMIT) current.delete(current.keys().next().value);
      }
      if (stage === 'onSendHeaders') { row.sentAt = time; row.state = 'sent'; }
      if (stage === 'onResponseStarted') { row.responseAt = time; row.state = 'response'; }
      if (Number.isInteger(details.statusCode) && details.statusCode >= 100 && details.statusCode <= 599) row.statusCode = details.statusCode;
      if (details.fromCache === true) row.fromCache = true;
      if (stage === 'onBeforeRedirect') { row.state = 'redirect'; row.endedAt = time; row.redirectTo = safeURL(details.redirectUrl); }
      if (stage === 'onCompleted') { row.state = 'complete'; row.endedAt = time; }
      if (stage === 'onErrorOccurred') { row.state = 'error'; row.endedAt = time; row.error = errorCode(details.error); }
      resized(row); changed();
    }
    function status(session) {
      if (capture && now() >= capture.expiresAt) stop('Capture stopped after 30 minutes.');
      return { available, active: Boolean(capture), ownsCapture: capture?.owner === session,
        tabId: scope, startedAt: capture?.startedAt ?? null, expiresAt: capture?.expiresAt ?? null,
        reason, error: unavailable || storageError, count: rows.length, bytes, dropped, limit: LIMIT, byteLimit: BYTE_LIMIT, revision };
    }
    function valid(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message) || !Number.isSafeInteger(message.id) || message.id < 1 || message.id > 1000000000 ||
          !['read', 'start', 'stop', 'clear'].includes(message.type)) return false;
      const keys = { read: ['id', 'type', 'after'], start: ['id', 'type', 'tabId'], stop: ['id', 'type'], clear: ['id', 'type'] }[message.type];
      return keys && Object.keys(message).every(key => keys.includes(key)) &&
        (message.type !== 'read' || message.after === undefined || Number.isSafeInteger(message.after) && message.after >= 0) &&
        (message.type !== 'start' || message.tabId === null || Number.isSafeInteger(message.tabId) && message.tabId >= 0);
    }
    function resetRows(keepPending) {
      const pending = keepPending ? [...current].filter(([, row]) => !FINAL.has(row.state)) : [];
      current.clear();
      for (const [id] of pending) current.set(id, { cleared: true });
      rows = []; sizes.clear(); bytes = 0; dropped = 0; changed();
    }
    async function command(session, message) {
      if (!available) throw new Error(unavailable);
      await restore();
      if (!ports.has(session)) throw new Error('Network page closed.');
      if (message.type === 'start') {
        if (capture) throw new Error('Stop the current capture before starting a new one.');
        if (message.tabId !== null) {
          const tab = await api.tabs.get(message.tabId);
          if (!safeURL(tab.url)) throw new Error('Choose a tab with an HTTP(S) page.');
        }
        if (!ports.has(session)) throw new Error('Network page closed.');
        // Retry a failed write before replacing retained entries.
        await flush();
        if (!ports.has(session)) throw new Error('Network page closed.');
        resetRows(false); reason = 'Recording browser-reported traffic.';
        scope = message.tabId;
        const startedAt = now();
        capture = { owner: session, tabId: message.tabId, startedAt, expiresAt: startedAt + CAPTURE_MS,
          timer: setTimer(() => stop('Capture stopped after 30 minutes.'), CAPTURE_MS) };
        changed(); await flush();
      } else if (message.type === 'stop') {
        stop('Capture stopped. Retained entries are ready to review.'); await flush();
      } else if (message.type === 'clear') {
        resetRows(true); reason = capture ? 'Recording. Earlier entries cleared.' : 'Log cleared. Capture is off.'; await flush();
      }
      const state = status(session);
      return { status: state, entries: message.after === state.revision ? null : rows.map(row => ({ ...row })) };
    }
    function send(session, message) {
      if (!ports.has(session)) return;
      try { session.port.postMessage(message); }
      catch { disconnect(session); }
    }
    function disconnect(session) {
      if (!ports.delete(session)) return;
      if (capture?.owner === session) stop('Capture stopped because its Network page closed.');
      try { session.port.disconnect(); } catch { /* The page is already gone. */ }
    }
    const connect = port => {
      if (port.name !== PORT) return;
      if (closed || port.sender?.id !== api.runtime.id || port.sender.url !== api.runtime.getURL('src/ui/network/network.html') || ports.size >= 4) {
        port.disconnect(); return;
      }
      const session = { port, pending: new Set() }; ports.add(session);
      port.onDisconnect.addListener(() => disconnect(session));
      port.onMessage.addListener(message => {
        if (!valid(message) || session.pending.has(message.id)) { disconnect(session); return; }
        if (session.pending.size >= 2 || pendingCommands >= 8) { send(session, { id: message.id, ok: false, error: 'Wait for the previous network-log request.' }); return; }
        session.pending.add(message.id); pendingCommands++;
        const work = commands.then(() => command(session, message));
        commands = work.catch(() => {});
        void work.then(result => send(session, { id: message.id, ok: true, ...result }),
          error => send(session, { id: message.id, ok: false, error: error.message })).finally(() => {
          pendingCommands--; session.pending.delete(message.id);
        });
      });
    };
    api.runtime.onConnect?.addListener(connect);
    if (available) try {
      for (const stage of stages) {
        const listener = details => { observe(stage, details); };
        // No blocking, requestBody, requestHeaders, responseHeaders or extraHeaders.
        api.webRequest[stage].addListener(listener, { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] });
        listeners.push([api.webRequest[stage], listener]);
      }
    } catch {
      available = false; unavailable = 'The browser could not attach the network observers. Reload the extension to retry.';
      for (const [event, listener] of listeners) event.removeListener(listener);
      listeners.length = 0;
    }
    const removed = tabId => { if (capture?.tabId === tabId) stop('Capture stopped because its selected tab closed.'); };
    api.tabs.onRemoved?.addListener(removed);
    return {
      // Internal read capability only: the MCP adapter validates arguments and
      // separate consent before invoking it. Do not route through UI commands:
      // even expiry observation here must not stop capture or schedule a save.
      async read(args = {}) {
        if (closed) throw new Error('Network log is unavailable.');
        await restore();
        if (closed) throw new Error('Network log is unavailable.');
        const limit = args.limit ?? 50, query = (args.url || '').toLowerCase(), method = args.method?.toUpperCase();
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Choose 1 to 100 network entries.');
        const matches = rows.filter(row => (args.tabId === undefined || row.tabId === args.tabId) &&
          (!query || row.url.toLowerCase().includes(query)) && (!method || row.method.toUpperCase() === method) &&
          (!args.type || row.type === args.type) && (args.statusCode === undefined || row.statusCode === args.statusCode) &&
          (!args.state || row.state === args.state));
        const entries = []; let readBytes = 0;
        // Reserve room for status and the result wrapper, including JSON escaping
        // when the MCP transport puts the result inside a text content block.
        for (let i = matches.length - 1; i >= 0 && entries.length < limit; i--) {
          const row = matches[i], size = sizes.get(row.id);
          if (readBytes + size > READ_BYTE_LIMIT - 4096) break;
          readBytes += size; entries.push({ ...row });
        }
        entries.reverse();
        return { ok: true, entries, matched: matches.length, truncated: entries.length < matches.length,
          capture: { active: Boolean(capture && capture.expiresAt > now()), tabId: scope,
            startedAt: capture?.startedAt ?? null, expiresAt: capture?.expiresAt ?? null,
            count: rows.length, bytes, dropped, limit: LIMIT, byteLimit: BYTE_LIMIT,
            available, error: unavailable || storageError },
          readLimit: limit, readByteLimit: READ_BYTE_LIMIT,
          redaction: 'URL credentials, query strings and fragments omitted. No headers, cookies or bodies. URL paths may contain private information.',
          coverage: 'Browser-reported metadata only; some events may be missing. A failed request does not establish blocker ownership. Capture is controlled only in the Network page.' };
      },
      async close() {
        closed = true; stop('Capture stopped.');
        for (const session of [...ports]) disconnect(session);
        api.runtime.onConnect?.removeListener?.(connect); api.tabs.onRemoved?.removeListener?.(removed);
        for (const [event, listener] of listeners) event.removeListener(listener);
        await flush();
      }
    };
  }
  globalThis.ModuleEngineNetworkLog = Object.freeze({ create, safeURL, cleanEntry, LIMIT, BYTE_LIMIT, CAPTURE_MS });
})();
