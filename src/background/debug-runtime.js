/* The browser boundary: one explicitly approved, expiring Debug-page port. */
(() => {
  'use strict';
  const protocol = ModuleEngineDebugProtocol;
  function create(api, { userscripts, blocking, activity, network }) {
    let active = null;
    const scriptView = script => ({ id: script.id, revision: script.revision, enabled: script.enabled,
      name: script.metadata.name, version: script.metadata.version, metadata: script.metadata, tags: script.tags,
      autoPageApproved: script.autoPageApproved, assets: script.assets });
    const text = (value, max = 2048) => typeof value === 'string' ? value.slice(0, max) : '';
    function stop(session, reason = 'Debugging disconnected.') {
      if (active !== session) return;
      active = null; clearTimeout(session.timer); userscripts.setDiagnosticSink(null); session.logs.length = 0;
      try { session.port.postMessage({ type: 'closed', error: reason }); } catch { /* Context already closed. */ }
      try { session.port.disconnect(); } catch { /* Already disconnected. */ }
    }
    async function read(session, name, args) {
      const tool = protocol.call(name, args);
      if (!tool.scope || !session.scopes.includes(tool.scope)) throw new Error('This debugging scope was not approved.');
      if (name === 'module_engine_get_network_log') return network(args);
      if (name === 'module_engine_get_logs') {
        const kind = args.kind || 'all', limit = args.limit || 50, entries = [];
        if (kind !== 'userscript' && !args.scriptId) for (const entry of (await activity()).slice(-100)) {
          const item = { kind: 'activity', time: entry.time, event: text(entry.kind, 32), message: text(entry.message),
            site: text(entry.site, 253), domain: text(entry.domain, 253), type: text(entry.type, 64), layer: text(entry.layer, 128) };
          if (entry.url) item.url = protocol.safeURL(entry.url);
          if (Number.isInteger(entry.tabId)) item.tabId = entry.tabId;
          entries.push(item);
        }
        if (kind !== 'activity') entries.push(...session.logs.filter(entry => !args.scriptId || entry.scriptId === args.scriptId));
        return { ok: true, entries: entries.sort((a, b) => a.time - b.time).slice(-limit),
          capture: 'Wrapper exceptions, top-level-await rejections and managed GM callback errors in native messaging worlds, including page bridges. Page console, raw scripts, scripts without messaging grants and unrelated asynchronous errors are not captured.' };
      }
      const library = await userscripts.inspect();
      if (name === 'module_engine_status') return { ok: true, version: api.runtime.getManifest().version,
        blocking: await blocking(), userscripts: { enabled: library.enabled, active: library.active, available: library.available,
          error: library.error || '', scripts: library.scripts.length, enabledScripts: library.scripts.filter(script => script.enabled).length },
        debug: { readOnly: true, scopes: session.scopes, expiresAt: session.expiresAt } };
      if (name === 'module_engine_list_scripts') return { ok: true, scripts: library.scripts.map(scriptView) };
      if (name === 'module_engine_get_script') {
        const script = library.scripts.find(item => item.id === args.id);
        if (!script) throw new Error('Script not found.');
        return { ok: true, script: { ...scriptView(script), source: script.source } };
      }
      return { ok: true, moduleEnabled: library.enabled, available: library.available, scripts: library.scripts.map(script => ({
        id: script.id, name: script.metadata.name, enabled: script.enabled,
        matches: BlockAdsUserScriptCore.allows(script.metadata, args.url),
        world: script.metadata.injection === 'auto' && !script.autoPageApproved ? 'USER_SCRIPT' : script.metadata.world,
        fallbackWorld: script.metadata.injection === 'auto' && !script.metadata.unwrap && script.autoPageApproved ? 'USER_SCRIPT' : null,
        runAt: script.metadata.runAt, allFrames: script.metadata.allFrames
      })) };
    }
    api.runtime.onConnect?.addListener(port => {
      if (port.name !== 'ME_DEBUG_READONLY') return;
      if (port.sender?.id !== api.runtime.id || port.sender.url !== api.runtime.getURL('src/ui/mcp/debug.html') || active) { port.disconnect(); return; }
      const session = { port, scopes: [], pending: new Set(), logs: [], started: false, rateStart: Date.now(), rate: 0 };
      active = session;
      session.timer = setTimeout(() => stop(session, 'Debug approval timed out.'), 5000);
      port.onDisconnect.addListener(() => stop(session));
      port.onMessage.addListener(message => {
        if (active !== session) return;
        if (session.started && session.expiresAt <= Date.now()) { stop(session, 'Debug session expired.'); return; }
        if (!session.started) {
          try {
            if (message?.type !== 'approve') throw new Error('Approve debugging from its page first.');
            session.scopes = protocol.scopes(message.scopes); session.started = true;
            session.expiresAt = Date.now() + protocol.SESSION_MS;
            clearTimeout(session.timer); session.timer = setTimeout(() => stop(session, 'Debug session expired. Connect again to continue.'), protocol.SESSION_MS);
            if (session.scopes.includes('logs')) userscripts.setDiagnosticSink(entry => {
              if (active !== session) return;
              session.logs.push({ ...entry, kind: 'userscript' }); if (session.logs.length > 100) session.logs.shift();
            });
            port.postMessage({ type: 'ready', scopes: session.scopes, expiresAt: session.expiresAt });
          } catch (error) { stop(session, error.message); }
          return;
        }
        if (message?.type === 'heartbeat') { port.postMessage({ type: 'heartbeat' }); return; }
        if (message?.type !== 'read' || typeof message.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(message.id) || session.pending.has(message.id)) {
          stop(session, 'Invalid debugging message.'); return;
        }
        if (session.rateStart + 10000 < Date.now()) { session.rateStart = Date.now(); session.rate = 0; }
        if (session.pending.size >= 4 || ++session.rate > 20) { port.postMessage({ type: 'result', id: message.id, result: { ok: false, error: 'Debugging read limit reached. Wait before trying again.' } }); return; }
        session.pending.add(message.id);
        void read(session, message.name, message.arguments ?? {}).catch(error => ({ ok: false, error: error.message || 'Debugging read failed.' }))
          .then(result => {
            session.pending.delete(message.id);
            if (active === session && session.expiresAt > Date.now()) {
              if (new TextEncoder().encode(JSON.stringify(result)).length > protocol.MAX_BYTES - 1024)
                result = { ok: false, error: 'Debug result exceeds its size limit. Request fewer log entries or a smaller script.' };
              try { port.postMessage({ type: 'result', id: message.id, result }); } catch { stop(session); }
            }
          });
      });
    });
    return Object.freeze({ close: () => { if (active) stop(active); } });
  }
  globalThis.BlockAdsDebug = Object.freeze({ create });
})();
