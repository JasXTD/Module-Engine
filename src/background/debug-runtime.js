/* The browser boundary: one explicitly approved, expiring MCP-page port.
   Reads answer directly. Change proposals wait here until the user decides on
   that page; agent requests can only create proposals, never decide them.
   Decisions reuse the manager's own save, enable and delete commands. */
(() => {
  'use strict';
  const protocol = ModuleEngineDebugProtocol;
  const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  const ACTIONS = ['apply', 'apply_enable', 'reject', 'revert'];
  // Pending proposals hold full source; decided ones keep only status and undo data.
  const LIMITS = Object.freeze({ pending: 4, kept: 32 });
  function create(api, { userscripts, blocking, activity, network, log = async () => {} }) {
    let active = null;
    const scriptView = script => ({ id: script.id, revision: script.revision, enabled: script.enabled,
      name: script.metadata.name, version: script.metadata.version, metadata: script.metadata, tags: script.tags,
      autoPageApproved: script.autoPageApproved, assets: script.assets });
    const text = (value, max = 2048) => typeof value === 'string' ? value.slice(0, max) : '';
    const failure = error => text(error?.message || String(error), 512);
    function stop(session, reason = 'Debugging disconnected.') {
      if (active !== session) return;
      active = null; clearTimeout(session.timer); userscripts.setDiagnosticSink(null); session.logs.length = 0; session.proposals.clear();
      try { session.port.postMessage({ type: 'closed', error: reason }); } catch { /* Context already closed. */ }
      try { session.port.disconnect(); } catch { /* Already disconnected. */ }
    }
    const pendingOf = session => [...session.proposals.values()].filter(item => item.status === 'pending');
    const agentView = item => ({ id: item.id, kind: item.kind, status: item.status, scriptId: item.scriptId, name: item.name,
      ...(item.kind === 'enabled' ? { requestedEnabled: item.requestedEnabled } : {}),
      revision: item.revision ?? null, enabled: item.resultEnabled ?? null, error: item.error || '',
      createdAt: item.createdAt, decidedAt: item.decidedAt ?? null });
    const pageView = item => ({ ...agentView(item), note: item.note, wasEnabled: item.wasEnabled, created: !item.baseRevision,
      needsDependencies: item.needsDependencies, canRevert: item.status === 'applied' && Boolean(item.undo),
      ...(item.status === 'pending' ? { source: item.source, previousSource: item.previousSource, sourceURL: item.sourceURL } : {}) });
    function notify(session, item) {
      if (active !== session) return;
      try { session.port.postMessage({ type: 'proposal', proposal: pageView(item) }); } catch { stop(session); }
    }
    function remember(session, item) {
      session.proposals.set(item.id, item);
      for (const [key, entry] of session.proposals) {
        if (session.proposals.size <= LIMITS.kept) break;
        if (entry.status !== 'pending') session.proposals.delete(key);
      }
      notify(session, item);
    }
    function settle(session, item, status, error = '') {
      Object.assign(item, { status, error, decidedAt: Date.now(), source: null, previousSource: null });
      notify(session, item);
    }
    function admit(session, scriptId, sameNew) {
      if (active !== session) throw new Error('Debug connection ended.');
      // The proposal being decided right now is never replaced underneath its decision.
      const pending = pendingOf(session), replaced = pending.filter(item => item.id !== session.deciding && (scriptId ? item.scriptId === scriptId : sameNew(item)));
      if (pending.length - replaced.length >= LIMITS.pending)
        throw new Error('Four proposals are already waiting for the user. Check them with module_engine_get_proposal before proposing more.');
      return replaced;
    }
    const stale = 'This script changed since you read it. Call module_engine_get_script again before proposing a change.';
    async function proposeScript(session, args) {
      const core = BlockAdsUserScriptCore;
      if (core.bytes(args.source) > core.LIMITS.source) throw new Error('A script must contain at most 128 KiB of UTF-8 source.');
      let metadata;
      try { metadata = core.parse(args.source); } catch (error) { throw new Error('Metadata error: ' + failure(error)); }
      const library = await userscripts.inspect();
      let script = null;
      if (args.id !== undefined) {
        script = library.scripts.find(item => item.id === args.id);
        if (!script) throw new Error('Script not found.');
        if (script.revision !== args.revision) throw new Error(stale);
        if (script.source === args.source) throw new Error('This source is already installed.');
        // A stable identity keeps the review honest: an edit cannot repurpose another script.
        if (metadata.name !== script.metadata.name || metadata.namespace !== script.metadata.namespace)
          throw new Error('Keep @name and @namespace when editing. Propose a separate new script instead.');
      } else {
        const duplicate = library.scripts.find(item => item.metadata.name === metadata.name && item.metadata.namespace === metadata.namespace);
        if (duplicate) throw new Error('A script with this @name and @namespace is installed. Pass its id (' + duplicate.id + ') and revision to propose an edit.');
        if (library.scripts.length >= core.LIMITS.scripts) throw new Error('The library already holds the maximum of ' + core.LIMITS.scripts + ' scripts.');
      }
      const replaced = admit(session, script?.id, item => !item.scriptId && item.name === metadata.name && item.namespace === metadata.namespace);
      for (const item of replaced) settle(session, item, 'superseded');
      // Saving keeps prepared dependencies only when their declarations are unchanged.
      const specs = core.assetSpecs(metadata);
      const needsDependencies = specs.length > 0 && (!script?.assets || JSON.stringify(specs) !== JSON.stringify(core.assetSpecs(script.metadata)));
      const item = { id: crypto.randomUUID(), kind: 'script', status: 'pending', scriptId: script?.id ?? null, baseRevision: script?.revision ?? null,
        name: metadata.name, namespace: metadata.namespace, source: args.source, previousSource: script?.source ?? null,
        sourceURL: script?.sourceURL ?? null, wasEnabled: Boolean(script?.enabled), note: args.note ?? '', needsDependencies, createdAt: Date.now() };
      remember(session, item);
      return { ok: true, proposal: agentView(item), warnings: metadata.warnings,
        next: 'Ask the user to review this proposal on the Module Engine MCP page, then call module_engine_get_proposal.' +
          (needsDependencies ? ' Its dependencies must be prepared in Modules & scripts before it can be turned on.' : '') };
    }
    async function proposeEnabled(session, args) {
      const core = BlockAdsUserScriptCore;
      const library = await userscripts.inspect(), script = library.scripts.find(item => item.id === args.id);
      if (!script) throw new Error('Script not found.');
      if (script.revision !== args.revision) throw new Error(stale);
      if (script.enabled === args.enabled) throw new Error('This script is already ' + (args.enabled ? 'on.' : 'off.'));
      if (pendingOf(session).some(item => item.kind === 'script' && item.scriptId === script.id))
        throw new Error('A source change for this script is waiting for the user, who can apply and turn it on together.');
      for (const item of admit(session, script.id)) settle(session, item, 'superseded');
      const item = { id: crypto.randomUUID(), kind: 'enabled', status: 'pending', scriptId: script.id, baseRevision: script.revision,
        name: script.metadata.name, namespace: script.metadata.namespace, requestedEnabled: args.enabled, wasEnabled: script.enabled,
        // Turning code on shows what it can access; turning it off needs no source review.
        source: args.enabled ? script.source : null, previousSource: null, sourceURL: script.sourceURL ?? null, note: args.note ?? '',
        needsDependencies: args.enabled && core.assetSpecs(script.metadata).length > 0 && !script.assets, createdAt: Date.now() };
      remember(session, item);
      return { ok: true, proposal: agentView(item), next: 'Ask the user to review this proposal on the Module Engine MCP page, then call module_engine_get_proposal.' };
    }
    async function apply(session, item, action, acknowledgeBidi) {
      const name = text(item.name, 128), { source, previousSource } = item;
      if (action === 'apply_enable' && item.kind !== 'script') return;
      if ((action === 'apply_enable' || item.kind === 'enabled' && item.requestedEnabled) &&
          BlockAdsUserScriptCore.hasBidi(source) && acknowledgeBidi !== true) {
        item.error = 'Review the escaped source and acknowledge its hidden direction controls before enabling.'; return;
      }
      // For an enable proposal, needsDependencies is only set when it would turn the script on.
      if (item.needsDependencies && (action === 'apply_enable' || item.kind === 'enabled')) {
        item.error = 'Prepare this script’s dependencies in Modules & scripts before turning it on' + (item.kind === 'script' ? ', or apply it without turning it on.' : '.'); return;
      }
      const library = await userscripts.inspect();
      const script = item.scriptId ? library.scripts.find(entry => entry.id === item.scriptId) : null;
      if (item.scriptId && script?.revision !== item.baseRevision) {
        settle(session, item, 'stale', 'The script changed after this proposal was made. Ask the agent to propose it again.'); return;
      }
      if (!item.scriptId && library.scripts.some(entry => entry.metadata.name === item.name && entry.metadata.namespace === item.namespace)) {
        settle(session, item, 'stale', 'A script with this name was installed after this proposal was made.'); return;
      }
      try {
        if (item.kind === 'enabled') {
          const result = await userscripts.request({ type: 'US_ENABLE', id: item.scriptId, revision: item.baseRevision, enabled: item.requestedEnabled, acknowledgeBidi });
          const record = result.scripts.find(entry => entry.id === item.scriptId);
          Object.assign(item, { revision: record.revision, resultEnabled: record.enabled, undo: { revision: record.revision } });
          settle(session, item, 'applied');
          await log({ kind: 'event', message: 'MCP: turned ' + (record.enabled ? 'on' : 'off') + ' "' + name + '" as the agent proposed' });
          return;
        }
        const saved = await userscripts.request({ type: 'US_SAVE', source, ...(item.scriptId ? { id: item.scriptId, revision: item.baseRevision } : {}) });
        let record = saved.scripts.find(entry => entry.id === saved.selectedId), error = '';
        Object.assign(item, { scriptId: record.id, revision: record.revision, resultEnabled: record.enabled,
          undo: { revision: record.revision, source: previousSource, created: !item.baseRevision } });
        if (action === 'apply_enable') {
          try {
            const enabled = await userscripts.request({ type: 'US_ENABLE', id: record.id, revision: record.revision, enabled: true, acknowledgeBidi });
            record = enabled.scripts.find(entry => entry.id === record.id);
            Object.assign(item, { revision: record.revision, resultEnabled: record.enabled }); item.undo.revision = record.revision;
          } catch (problem) { error = 'Saved, but not turned on: ' + failure(problem); }
        }
        settle(session, item, 'applied', error);
        await log({ kind: 'event', message: 'MCP: applied the agent’s ' + (item.baseRevision ? 'edit to' : 'new script') + ' "' + name + '"' +
          (item.resultEnabled ? ' and turned it on' : '; it stays off') });
      } catch (problem) { settle(session, item, 'failed', failure(problem)); }
    }
    async function revert(session, item) {
      if (item.status !== 'applied' || !item.undo) return;
      const library = await userscripts.inspect(), script = library.scripts.find(entry => entry.id === item.scriptId);
      if (script?.revision !== item.undo.revision) {
        item.undo = null; item.error = 'This script changed after the agent’s change was applied. Undo it in Modules & scripts.'; return;
      }
      try {
        // An edit returns to its previous source, saved off like any edit.
        if (item.kind === 'enabled' && item.wasEnabled && BlockAdsUserScriptCore.hasBidi(script.source))
          throw new Error('Turning this source back on needs a fresh review of its hidden direction controls. Propose enabling it again or use Modules & scripts.');
        if (item.kind === 'enabled') await userscripts.request({ type: 'US_ENABLE', id: item.scriptId, revision: item.undo.revision, enabled: item.wasEnabled });
        else if (item.undo.created) await userscripts.request({ type: 'US_DELETE', id: item.scriptId, revision: item.undo.revision });
        else await userscripts.request({ type: 'US_SAVE', id: item.scriptId, revision: item.undo.revision, source: item.undo.source });
        const removed = item.kind === 'script' && item.undo.created;
        item.undo = null; settle(session, item, 'reverted');
        await log({ kind: 'event', message: 'MCP: reverted the agent’s change to "' + text(item.name, 128) + '"' + (removed ? ' and removed the script' : '') });
      } catch (problem) { item.error = 'Could not revert: ' + failure(problem); }
    }
    async function decide(session, message) {
      const item = session.proposals.get(message.id);
      // One decision at a time, so each one starts from the library the last one left.
      if (item && !session.deciding) {
        session.deciding = item.id; item.error = '';
        try {
          if (message.action === 'revert') await revert(session, item);
          else if (item.status !== 'pending') { /* Already decided; the page view is refreshed below. */ }
          else if (message.action === 'reject') {
            settle(session, item, 'rejected');
            await log({ kind: 'event', message: 'MCP: rejected the agent’s proposed change to "' + text(item.name, 128) + '"' });
          } else await apply(session, item, message.action, message.acknowledgeBidi);
        } catch (problem) { item.error = failure(problem); }
        finally { session.deciding = false; }
        notify(session, item);
      }
      if (active === session) try { session.port.postMessage({ type: 'decided', id: message.id }); } catch { stop(session); }
    }
    async function read(session, name, args) {
      const tool = protocol.call(name, args);
      if (!tool.scope || !session.scopes.includes(tool.scope)) throw new Error('This debugging scope was not approved.');
      if (name === 'module_engine_get_network_log') return network(args);
      if (name === 'module_engine_propose_script') return proposeScript(session, args);
      if (name === 'module_engine_propose_enabled') return proposeEnabled(session, args);
      if (name === 'module_engine_get_proposal') {
        const item = session.proposals.get(args.proposalId);
        if (!item) throw new Error('Proposal not found in this session.');
        return { ok: true, proposal: agentView(item) };
      }
      if (name === 'module_engine_get_logs') {
        const kind = args.kind || 'all', limit = args.limit || 50, entries = [];
        if (kind !== 'userscript' && !args.scriptId) for (const entry of (await activity()).slice(-100)) {
          // Field names follow background.js's activity log: blocked requests and
          // closed pop-ups record the server as host, plus a query-free path.
          const item = { kind: 'activity', time: entry.time, event: text(entry.kind, 32), message: text(entry.message),
            site: text(entry.site, 253), host: text(entry.host, 253), path: text(entry.path, 150), type: text(entry.type, 64), layer: text(entry.layer, 128) };
          if (Number.isSafeInteger(entry.ruleId)) item.ruleId = entry.ruleId;
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
        debug: { readOnly: !session.scopes.includes(protocol.CHANGES), scopes: session.scopes, expiresAt: session.expiresAt } };
      if (name === 'module_engine_list_scripts') return { ok: true, scripts: library.scripts.map(scriptView) };
      if (name === 'module_engine_get_script') {
        const script = library.scripts.find(item => item.id === args.id);
        if (!script) throw new Error('Script not found.');
        return { ok: true, script: { ...scriptView(script), source: script.source } };
      }
      const result = { ok: true, moduleEnabled: library.enabled, available: library.available, scripts: library.scripts.map(script => ({
        id: script.id, name: script.metadata.name, enabled: script.enabled,
        matches: BlockAdsUserScriptCore.allows(script.metadata, args.url),
        world: script.metadata.injection === 'auto' && !script.autoPageApproved ? 'USER_SCRIPT' : script.metadata.world,
        fallbackWorld: script.metadata.injection === 'auto' && !script.metadata.unwrap && script.autoPageApproved ? 'USER_SCRIPT' : null,
        runAt: script.metadata.runAt, allFrames: script.metadata.allFrames
      })) };
      if (args.source !== undefined) {
        // A draft is parsed as data only; a newly saved auto script starts isolated.
        let metadata;
        try { metadata = BlockAdsUserScriptCore.parse(args.source); } catch (error) { throw new Error('Metadata error: ' + failure(error)); }
        result.draft = { name: metadata.name, matches: BlockAdsUserScriptCore.allows(metadata, args.url),
          world: metadata.injection === 'auto' ? 'USER_SCRIPT' : metadata.world, runAt: metadata.runAt, allFrames: metadata.allFrames };
      }
      return result;
    }
    // The port keeps its original name so existing MCP pages and tests stay compatible.
    api.runtime.onConnect?.addListener(port => {
      if (port.name !== 'ME_DEBUG_READONLY') return;
      if (port.sender?.id !== api.runtime.id || port.sender.url !== api.runtime.getURL('src/ui/mcp/debug.html') || active) { port.disconnect(); return; }
      const session = { port, scopes: [], pending: new Set(), logs: [], proposals: new Map(), deciding: false, started: false, rateStart: Date.now(), rate: 0 };
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
        // Decisions arrive only from the page's trusted buttons, never from relayed agent requests.
        if (message?.type === 'decide') {
          if (!session.scopes.includes(protocol.CHANGES) || typeof message.id !== 'string' || !UUID.test(message.id) || !ACTIONS.includes(message.action)) {
            stop(session, 'Invalid debugging message.'); return;
          }
          void decide(session, message); return;
        }
        if (message?.type !== 'read' || typeof message.id !== 'string' || !UUID.test(message.id) || session.pending.has(message.id)) {
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
