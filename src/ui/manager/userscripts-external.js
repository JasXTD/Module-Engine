/* A paired local file can supply a draft, never save, enable or execute a script. */
(() => {
  'use strict';
  const normalize = source => source.replace(/\r\n?/g, '\n');
  function pairing(value) {
    const match = /^MEF1\.([1-9][0-9]{0,4})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match || Number(match[1]) > 65535) throw new Error('Paste the MEF1 pairing code printed by the external-editor helper.');
    return { origin: 'http://127.0.0.1:' + match[1], token: match[2] };
  }
  function create({ state, confirm, load }) {
    const el = id => document.getElementById(id);
    let session, candidate, connecting = false, message = 'Not connected. Your draft is unchanged.', error = false;
    function render() {
      const current = state(), locked = current.locked;
      el('externalCode').disabled = locked || connecting || Boolean(session);
      el('externalConnect').disabled = locked || connecting || Boolean(session);
      el('externalStop').disabled = !session;
      el('externalLoad').hidden = !candidate;
      el('externalLoad').disabled = locked || !candidate || candidate.source === current.source;
      el('externalStatus').textContent = !error && session?.paired && candidate?.source === current.source && !current.dirty
        ? candidate.name + ' · Tracking. File matches the draft.' : message;
      el('externalStatus').classList.toggle('error-text', error);
    }
    function notice(text, isError = false) { message = text; error = isError; render(); }
    async function post(current, route, body, final = false) {
      const response = await fetch(current.origin + route, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + current.token }, body: JSON.stringify(body), keepalive: final,
        signal: final ? AbortSignal.timeout(1000) : AbortSignal.any([current.controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error('The helper refused the connection (' + response.status + '). Restart it to get a new code.');
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 800000) throw new Error('The helper response exceeded its size limit.');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Invalid helper response.');
      return result;
    }
    function stop(text = 'Tracking stopped. Your draft is unchanged.', isError = false) {
      const previous = session; session = candidate = undefined; connecting = false;
      el('externalCode').value = '';
      if (previous) {
        clearTimeout(previous.timer); clearTimeout(previous.expiry); previous.controller.abort();
        if (previous.paired) void post(previous, '/disconnect', {}, true).catch(() => {});
      }
      notice(text, isError);
    }
    async function poll(current) {
      try {
        const value = await post(current, '/read', current.hash ? { hash: current.hash } : {});
        if (session !== current || state().key !== current.key) return;
        if (value.error !== undefined) {
          if (typeof value.error !== 'string' || value.error.length > 300) throw new Error('Invalid helper response.');
          // Do not offer an outdated snapshot while the file is missing or invalid.
          candidate = undefined; current.hash = undefined; notice(value.error, true);
        } else {
          if (typeof value.name !== 'string' || !value.name.toLowerCase().endsWith('.user.js') || value.name.length > 255 || /[\\/\x00-\x1f]/.test(value.name) ||
              typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) throw new Error('Invalid helper file description.');
          if (value.source !== undefined) {
            if (typeof value.source !== 'string' || BlockAdsUserScriptCore.bytes(value.source) > BlockAdsUserScriptCore.LIMITS.source) throw new Error('The helper file exceeds 128 KiB.');
            const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.source)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
            if (session !== current) return;
            if (digest !== value.hash) throw new Error('The helper file hash did not match its source.');
            current.hash = value.hash; candidate = { ...value, source: normalize(value.source) };
            notice(value.name + (candidate.source === state().source ? ' · Tracking. File matches the draft.' : ' · File changed. Load it into the draft to review.'));
          } else if (value.hash !== current.hash) throw new Error('The helper omitted the changed file.');
        }
        current.timer = setTimeout(() => { if (session === current) void poll(current); }, 1000);
      } catch (cause) { if (session === current) stop('Tracking stopped: ' + cause.message, true); }
    }
    async function connect(event) {
      if (!event.isTrusted || session || connecting || state().locked) return;
      let current;
      try {
        current = { ...pairing(el('externalCode').value.trim()), key: state().key, controller: new AbortController() };
        session = current; connecting = true; el('externalCode').value = ''; notice('Connecting to your local file helper…');
        const result = await post(current, '/pair', {});
        if (session !== current) return;
        if (typeof result.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(result.token) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('Invalid helper pairing response.');
        current.token = result.token; current.paired = true; connecting = false;
        current.expiry = setTimeout(() => { if (session === current) stop('Tracking expired. Restart the helper to connect again.'); }, Math.min(30 * 60 * 1000, result.expiresAt - Date.now()));
        notice('Connected. Reading the selected file…'); void poll(current);
      } catch (cause) { if (!current || session === current) stop(cause.message, true); }
    }
    el('externalConnect').addEventListener('click', connect);
    el('externalCode').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void connect(event); } });
    el('externalStop').addEventListener('click', () => stop());
    el('externalLoad').addEventListener('click', async event => {
      const current = session, proposed = candidate, before = state();
      if (!event.isTrusted || !current || !proposed || before.locked || proposed.source === before.source) return;
      let different = false;
      try { const metadata = BlockAdsUserScriptCore.parse(proposed.source); different = before.identity && (metadata.name !== before.identity.name || metadata.namespace !== before.identity.namespace); }
      catch { /* Incomplete source can be reviewed; the normal syntax checks and save validation still apply. */ }
      if ((before.dirty || different) && !await confirm('Replace the source draft?', (different ? 'This file names a different script. ' : '') +
          'Load “' + proposed.name + '” over the current source draft? Unsaved source edits will be replaced. Saved scripts and local tags stay as they are.', 'Load into draft')) return;
      if (session !== current || candidate !== proposed || state().key !== before.key || state().locked || state().source !== before.source) {
        if (session === current) notice('The file or draft changed during review. Review the latest change and try again.', true);
        return;
      }
      load(proposed.source); notice(proposed.name + ' · Loaded into draft. Review the source and permissions, then Save when ready.');
    });
    addEventListener('pagehide', () => stop());
    return Object.freeze({ render, stop });
  }
  globalThis.ModuleEngineExternalEditor = Object.freeze({ create, pairing, normalize });
})();
