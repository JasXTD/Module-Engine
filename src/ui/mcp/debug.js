/* Explicit UI approval owns the localhost bridge. Secrets stay in page memory.
   Agent requests relayed here can only read or propose; decisions on proposals
   are sent to the background only from trusted clicks on this page. */
(() => {
  'use strict';
  const api = globalThis.browser || chrome, protocol = ModuleEngineDebugProtocol, review = BlockAdsScriptReview, el = id => document.getElementById(id);
  const TITLE = document.title, ACTIONS = { apply: 'apply', applyEnable: 'apply_enable', reject: 'reject', revert: 'revert' };
  let session = null, connecting = false, reads = 0, deciding = null;
  const proposals = new Map(), nodes = new Map(), bidiReviews = new Map();
  function notice(message, error = false) { el('status').textContent = message; el('status').className = 'notice' + (error ? ' error' : ''); }
  const changesApproved = () => Boolean(session?.ready && session.scopes.includes(protocol.CHANGES));
  function render() {
    el('connect').disabled = connecting || Boolean(session);
    el('disconnect').disabled = !session && !connecting;
    el('pairingCode').disabled = el('scopes').disabled = connecting || Boolean(session);
    el('connectionBadge').textContent = session?.ready ? (changesApproved() ? 'Connected · changes need your review' : 'Connected · read-only') : connecting ? 'Connecting' : 'Disconnected';
    el('connectionBadge').className = 'badge' + (session?.ready ? ' active' : '');
    el('proposalsCard').hidden = !changesApproved() && !proposals.size;
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
    const current = session; session = null; connecting = false; deciding = null;
    if (current) {
      clearTimeout(current.timer); clearInterval(current.heartbeat); current.controller.abort();
      for (const job of current.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Debug connection ended.')); }
      current.pending.clear(); current.port?.disconnect();
      if (current.paired) void post(current, '/disconnect', {}, true).catch(() => {});
    }
    // Proposals belong to the connection; the background discards them too.
    proposals.clear(); renderProposals();
    el('pairingCode').value = ''; el('sessionDetail').textContent = ''; notice(message, error); render();
  }
  // The manager's parser worker checks syntax off the page thread, so the user
  // only reviews proposals that parse. It never runs the proposed code.
  function syntaxCheck(source) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('../manager/userscripts-editor-worker.js');
      const finish = (error, diagnostics) => { clearTimeout(timer); worker.terminate(); if (error) reject(error); else resolve(diagnostics); };
      const timer = setTimeout(() => finish(new Error('The syntax check timed out.')), 3000);
      worker.onmessage = event => finish(null, Array.isArray(event.data?.diagnostics) ? event.data.diagnostics : []);
      worker.onerror = event => { event.preventDefault(); finish(new Error('The syntax check could not run.')); };
      worker.postMessage({ revision: 1, source });
    });
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
  async function answer(current, request) {
    if (request.name === 'module_engine_propose_script') {
      protocol.call(request.name, request.arguments ?? {});
      if (!current.scopes.includes(protocol.CHANGES)) throw new Error('This debugging scope was not approved.');
      const problems = (await syntaxCheck(request.arguments.source)).filter(item => item.kind !== 'bidi');
      if (problems.length) return { ok: false, error: 'The proposed source has errors, so it was not shown to the user. Fix them and propose again.',
        diagnostics: problems.slice(0, 20).map(({ kind, message, line, column }) => ({ kind, message: String(message).slice(0, 512), line, column })) };
      if (session !== current) throw new Error('Debug connection ended.');
    }
    return nativeRead(current, request);
  }
  async function poll(current) {
    try {
      while (session === current) {
        const response = await post(current, '/poll', {});
        if (session !== current || !response.request) continue;
        let result;
        try { result = await answer(current, response.request); }
        catch (error) { result = { ok: false, error: error.message }; }
        if (session !== current) return;
        const item = document.createElement('li'); item.textContent = new Date().toLocaleTimeString() + ' · ' + String(response.request.name).slice(0, 64) + (result.ok === false ? ' · refused' : ' · completed');
        el('reads').prepend(item); while (el('reads').children.length > 20) el('reads').lastChild.remove();
        el('readCount').textContent = ++reads + (reads === 1 ? ' read' : ' reads'); el('emptyReads').hidden = true;
        await post(current, '/result', { id: response.request.id, result });
      }
    } catch (error) { if (session === current) disconnect(error.message, true); }
  }
  const STATUS = { applied: 'Applied', rejected: 'Rejected', stale: 'Out of date', superseded: 'Replaced by a newer proposal', failed: 'Failed', reverted: 'Reverted', expired: 'Expired' };
  function heading(proposal) {
    if (proposal.kind === 'enabled') return (proposal.requestedEnabled ? 'Turn on: ' : 'Turn off: ') + proposal.name;
    return (proposal.created ? 'New script: ' : 'Edit: ') + proposal.name;
  }
  function effect(proposal) {
    const parts = [];
    if (proposal.kind === 'enabled') parts.push(proposal.requestedEnabled ? 'Turning this script on runs the code above on the sites listed.' : 'Turning this script off stops it on every site. Its source and saved values are kept.');
    else if (proposal.created) parts.push('Apply adds this script turned off. Apply & enable also turns it on, so it runs on the sites listed above.');
    else parts.push('Apply replaces the current source and turns the script off' + (proposal.wasEnabled ? ' (it is on now)' : '') + '. Saved script values are kept. Apply & enable turns it on with the new code.');
    if (proposal.needsDependencies) parts.push('Prepare or review its dependencies and enable it in Modules & scripts.');
    return parts.join(' ');
  }
  function button(id, label, action, primary = false) {
    const node = document.createElement('button'); node.type = 'button'; node.id = id; node.textContent = label; node.dataset.action = action;
    if (primary) node.className = 'primary';
    return node;
  }
  function sourcePane(id, label, value) {
    const wrap = document.createElement('div'), title = document.createElement('label'), area = document.createElement('textarea');
    title.htmlFor = id; title.textContent = label; Object.assign(area, { id, readOnly: true, spellcheck: false, dir: 'ltr', value: BlockAdsUserScriptCore.escapeBidi(value || '') });
    wrap.append(title, area); return wrap;
  }
  function build(proposal) {
    const article = document.createElement('article'); article.className = 'proposal'; article.dataset.id = proposal.id;
    const head = document.createElement('h3'); head.textContent = BlockAdsUserScriptCore.escapeBidi(heading(proposal)); article.append(head);
    if (proposal.note) {
      const note = document.createElement('p'), label = document.createElement('strong');
      label.textContent = 'Agent’s note (unverified): '; note.className = 'agent-note'; note.append(label, BlockAdsUserScriptCore.escapeBidi(proposal.note)); article.append(note);
    }
    if (proposal.source) {
      const fresh = proposal.kind === 'enabled' || !proposal.previousSource, wrap = document.createElement('div');
      wrap.className = 'review-table-wrap' + (fresh ? ' fresh' : '');
      wrap.innerHTML = '<table class="review-table"><caption></caption><thead><tr><th scope="col">Setting</th><th scope="col">Current</th><th scope="col">Proposed</th></tr></thead><tbody></tbody></table>';
      wrap.querySelector('caption').textContent = fresh ? 'Script access and settings' : 'Script access and settings · changed rows are marked';
      try { review.render(wrap.querySelector('tbody'), review.rows(fresh ? null : proposal.previousSource, proposal.source, { previousSourceURL: proposal.sourceURL, sourceURL: proposal.sourceURL })); }
      catch (error) { wrap.querySelector('caption').textContent = 'The metadata could not be read: ' + error.message; }
      const panes = document.createElement('div'); panes.className = 'review-code';
      const before = sourcePane('before-' + proposal.id, 'Current source · read only', proposal.previousSource);
      before.hidden = fresh;
      panes.append(before, sourcePane('after-' + proposal.id, (proposal.kind === 'enabled' ? 'Installed' : 'Proposed') + ' source · read only', proposal.source));
      const bidi = review.bidiWarning(proposal.source, { id: 'bidi-' + proposal.id, acknowledge: true, onChange: renderProposals });
      bidiReviews.set(proposal.id, bidi);
      article.append(wrap, bidi.node, panes);
    }
    const detail = document.createElement('p'); detail.className = 'muted'; detail.textContent = effect(proposal);
    const error = document.createElement('p'); error.className = 'notice error'; error.dataset.role = 'error'; error.hidden = true;
    const actions = document.createElement('div'); actions.className = 'actions';
    actions.append(button('reject-' + proposal.id, 'Reject', 'reject'));
    if (proposal.kind === 'enabled') actions.append(button('apply-' + proposal.id, proposal.requestedEnabled ? 'Turn on' : 'Turn off', 'apply', true));
    else actions.append(button('apply-' + proposal.id, 'Apply', 'apply'), button('applyEnable-' + proposal.id, 'Apply & enable', 'applyEnable', true));
    article.append(detail, error, actions);
    return article;
  }
  function decisionItem(proposal) {
    const item = document.createElement('li'), line = document.createElement('span');
    let state = STATUS[proposal.status] || proposal.status;
    if (proposal.status === 'applied' && proposal.enabled !== null) state += proposal.enabled ? ' · on' : ' · off';
    line.textContent = BlockAdsUserScriptCore.escapeBidi(heading(proposal) + ' — ' + state + (proposal.error ? '. ' + proposal.error : ''));
    item.append(line);
    if (proposal.canRevert) item.append(button('revert-' + proposal.id, proposal.kind === 'script' && proposal.created ? 'Remove script' : 'Revert', 'revert'));
    return item;
  }
  function renderProposals() {
    const list = [...proposals.values()], pending = list.filter(item => item.status === 'pending'), decided = list.filter(item => item.status !== 'pending').reverse();
    for (const [id, node] of nodes) if (!pending.some(item => item.id === id)) { node.remove(); nodes.delete(id); bidiReviews.delete(id); }
    for (const proposal of pending) {
      let node = nodes.get(proposal.id);
      // Pending cards are built once, so a new proposal never resets one being read.
      if (!node) { node = build(proposal); nodes.set(proposal.id, node); el('proposals').append(node); }
      const error = node.querySelector('[data-role="error"]'); error.textContent = BlockAdsUserScriptCore.escapeBidi(proposal.error); error.hidden = !proposal.error;
      for (const control of node.querySelectorAll('button')) control.disabled = Boolean(deciding) || !changesApproved() ||
        enables(proposal, control.dataset.action) && proposal.needsDependencies ||
        enables(proposal, control.dataset.action) && bidiReviews.has(proposal.id) && !bidiReviews.get(proposal.id).accepted();
    }
    el('decisions').replaceChildren(...decided.map(decisionItem));
    for (const control of el('decisions').querySelectorAll('button')) control.disabled = Boolean(deciding) || !changesApproved();
    el('decisionsHeading').hidden = !decided.length; el('emptyProposals').hidden = pending.length > 0;
    el('proposalCount').textContent = pending.length ? pending.length + ' waiting' : 'None waiting';
    document.title = (pending.length ? '(' + pending.length + ') ' : '') + TITLE;
    render();
  }
  const enables = (proposal, action) => action === 'applyEnable' || action === 'apply' && proposal.kind === 'enabled' && proposal.requestedEnabled;
  function decide(event) {
    const control = event.target.closest('button[data-action]');
    if (!control || !event.isTrusted || deciding || !changesApproved()) return;
    const id = control.id.slice(control.id.indexOf('-') + 1);
    if (!proposals.has(id)) return;
    const bidi = bidiReviews.get(id);
    if (enables(proposals.get(id), control.dataset.action) && bidi && !bidi.accepted()) return;
    deciding = id; renderProposals();
    try { session.port.postMessage({ type: 'decide', id, action: ACTIONS[control.dataset.action], acknowledgeBidi: Boolean(bidi?.accepted()) }); }
    catch { disconnect('Browser debugging channel closed.', true); }
  }
  el('proposals').addEventListener('click', decide); el('decisions').addEventListener('click', decide);
  el('connectForm').addEventListener('submit', async event => {
    event.preventDefault(); if (connecting || session || !event.isTrusted) return;
    let current;
    try {
      const code = protocol.pairing(el('pairingCode').value.trim());
      const requested = ['status', ...(el('shareScripts').checked ? ['scripts'] : []), ...(el('shareLogs').checked ? ['logs'] : []),
        ...(el('shareNetwork').checked ? ['network'] : []), ...(el('shareChanges').checked ? [protocol.CHANGES] : [])];
      current = { ...code, controller: new AbortController(), pending: new Map(), scopes: [] };
      session = current; connecting = true; render(); notice('Connecting to the local MCP server…');
      current.timer = setTimeout(() => { if (session === current) disconnect('Connection timed out. Get a new pairing code and try again.', true); }, 8000);
      const paired = await post(current, '/pair', { scopes: requested, browser: /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : 'Chromium' });
      if (session !== current) return;
      if (typeof paired.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(paired.token) || !Number.isFinite(paired.expiresAt)) throw new Error('Invalid local pairing response.');
      // The server may narrow the request (a read-only server drops changes), never widen it.
      const scopes = protocol.scopes(paired.scopes);
      if (scopes.some(scope => !requested.includes(scope))) throw new Error('Invalid local pairing response.');
      current.token = paired.token; current.paired = true; current.scopes = scopes;
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
          notice(requested.includes(protocol.CHANGES) && !scopes.includes(protocol.CHANGES)
            ? 'Connected. This MCP server was started without --allow-changes, so the agent can only read.'
            : 'Connected. Keep this tab open; you can switch sections while your agent inspects Module Engine.');
          render(); renderProposals(); void poll(current);
        } else if (message.type === 'result') {
          const job = current.pending.get(message.id); if (!job) return;
          clearTimeout(job.timer); current.pending.delete(message.id); job.resolve(message.result);
        } else if (message.type === 'proposal' && typeof message.proposal?.id === 'string') {
          proposals.set(message.proposal.id, message.proposal);
          // Match the background's bound: keep every pending card, drop the oldest decisions.
          for (const [id, item] of proposals) { if (proposals.size <= 32) break; if (item.status !== 'pending') proposals.delete(id); }
          renderProposals();
        } else if (message.type === 'decided' && message.id === deciding) {
          deciding = null; renderProposals();
        }
      });
      current.port.postMessage({ type: 'approve', scopes });
    } catch (error) { if (!current || session === current) disconnect(error.message, true); }
  });
  el('disconnect').addEventListener('click', () => disconnect());
  addEventListener('pagehide', () => disconnect());
  render();
})();
