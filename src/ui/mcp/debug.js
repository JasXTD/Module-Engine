/* Explicit UI approval owns the localhost bridge. Secrets stay in page memory. */
(() => {
  'use strict';
  const api = globalThis.browser || chrome, protocol = ModuleEngineDebugProtocol, el = id => document.getElementById(id);
  let session = null, connecting = false, reads = 0;
  function notice(message, error = false) { el('status').textContent = message; el('status').className = 'notice' + (error ? ' error' : ''); }
  function render() {
    el('connect').disabled = connecting || Boolean(session);
    el('disconnect').disabled = !session && !connecting;
    el('pairingCode').disabled = el('scopes').disabled = connecting || Boolean(session);
    el('connectionBadge').textContent = session?.ready ? 'Connected · read-only' : connecting ? 'Connecting' : 'Disconnected';
    el('connectionBadge').className = 'badge' + (session?.ready ? ' active' : '');
  }
  async function post(current, route, body, keepalive = false) {
    const response = await fetch(current.origin + route, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + current.token }, body: JSON.stringify(body),
      signal: keepalive ? AbortSignal.timeout(1000) : current.controller.signal, keepalive });
    if (!response.ok) throw new Error('Local MCP connection refused the request (' + response.status + '). Get a new pairing code and connect again.');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > protocol.MAX_BYTES) throw new Error('The local MCP response exceeded its size limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  }
  function disconnect(message = 'Disconnected. The agent can no longer read this browser.', error = false) {
    const current = session; session = null; connecting = false;
    if (current) {
      clearTimeout(current.timer); clearInterval(current.heartbeat); current.controller.abort();
      for (const job of current.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Debug connection ended.')); }
      current.pending.clear(); current.port?.disconnect();
      if (current.paired) void post(current, '/disconnect', {}, true).catch(() => {});
    }
    el('pairingCode').value = ''; el('sessionDetail').textContent = ''; notice(message, error); render();
  }
  function nativeRead(current, request) {
    protocol.call(request.name, request.arguments ?? {});
    if (typeof request.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(request.id) || current.pending.has(request.id)) throw new Error('Invalid local debugging request.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { current.pending.delete(request.id); reject(new Error('Browser debugging read timed out.')); }, 5000);
      current.pending.set(request.id, { resolve, reject, timer });
      try { current.port.postMessage({ type: 'read', id: request.id, name: request.name, arguments: request.arguments ?? {} }); }
      catch (error) { clearTimeout(timer); current.pending.delete(request.id); reject(error); }
    });
  }
  async function poll(current) {
    try {
      while (session === current) {
        const response = await post(current, '/poll', {});
        if (session !== current || !response.request) continue;
        let result;
        try { result = await nativeRead(current, response.request); }
        catch (error) { result = { ok: false, error: error.message }; }
        if (session !== current) return;
        const item = document.createElement('li'); item.textContent = new Date().toLocaleTimeString() + ' · ' + String(response.request.name).slice(0, 64) + (result.ok === false ? ' · refused' : ' · completed');
        el('reads').prepend(item); while (el('reads').children.length > 20) el('reads').lastChild.remove();
        el('readCount').textContent = ++reads + (reads === 1 ? ' read' : ' reads'); el('emptyReads').hidden = true;
        await post(current, '/result', { id: response.request.id, result });
      }
    } catch (error) { if (session === current) disconnect(error.message, true); }
  }
  el('connectForm').addEventListener('submit', async event => {
    event.preventDefault(); if (connecting || session || !event.isTrusted) return;
    let current;
    try {
      const code = protocol.pairing(el('pairingCode').value.trim());
      const scopes = ['status', ...(el('shareScripts').checked ? ['scripts'] : []), ...(el('shareLogs').checked ? ['logs'] : []), ...(el('shareNetwork').checked ? ['network'] : [])];
      current = { ...code, controller: new AbortController(), pending: new Map() };
      session = current; connecting = true; render(); notice('Connecting to the local MCP server…');
      current.timer = setTimeout(() => { if (session === current) disconnect('Connection timed out. Get a new pairing code and try again.', true); }, 8000);
      const paired = await post(current, '/pair', { scopes, browser: /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : 'Chromium' });
      if (session !== current) return;
      if (typeof paired.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(paired.token) || !Number.isFinite(paired.expiresAt)) throw new Error('Invalid local pairing response.');
      current.token = paired.token; current.paired = true;
      current.port = api.runtime.connect({ name: 'ME_DEBUG_READONLY' });
      current.port.onDisconnect.addListener(() => { void api.runtime.lastError; if (session === current) disconnect('The browser debugging channel closed. Connect again to continue.', true); });
      current.port.onMessage.addListener(message => {
        if (session !== current) return;
        if (message.type === 'closed') { disconnect(message.error, true); return; }
        if (message.type === 'ready') {
          clearTimeout(current.timer); current.ready = true; connecting = false; el('pairingCode').value = '';
          const expiresAt = Math.min(paired.expiresAt, message.expiresAt, Date.now() + protocol.SESSION_MS);
          current.timer = setTimeout(() => disconnect('Debug session expired. Connect again to continue.'), Math.max(0, expiresAt - Date.now()));
          current.heartbeat = setInterval(() => { try { current.port.postMessage({ type: 'heartbeat' }); } catch { disconnect('Browser debugging channel closed.', true); } }, 10000);
          el('sessionDetail').textContent = 'Approved: ' + scopes.join(', ') + ' · expires ' + new Date(expiresAt).toLocaleTimeString();
          notice('Connected. Keep this page open while your agent inspects Module Engine.'); render(); void poll(current);
        } else if (message.type === 'result') {
          const job = current.pending.get(message.id); if (!job) return;
          clearTimeout(job.timer); current.pending.delete(message.id); job.resolve(message.result);
        }
      });
      current.port.postMessage({ type: 'approve', scopes });
    } catch (error) { if (!current || session === current) disconnect(error.message, true); }
  });
  el('disconnect').addEventListener('click', () => disconnect());
  addEventListener('pagehide', () => disconnect());
  render();
})();
