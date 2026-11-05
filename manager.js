/* Extension-page controller. Script source is text throughout this interface. */
(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome, core = BlockAdsUserScriptCore;
  const el = id => document.getElementById(id);
  const template = ['// ==UserScript==', '// @name         My page customization', '// @namespace    local.module-engine',
    '// @version      1.0', '// @description  A local page customization', '// @match        https://example.com/*',
    '// @run-at       document-idle', '// @grant        none', '// ==/UserScript==', '', '// Your script goes here.', ''].join('\n');
  let library = null, modules = [], editor = null, busy = false, confirming = false, pendingRefresh = false, refreshTimer;
  const dirty = () => editor !== null && el('scriptSource').value !== editor.source;
  const selected = () => library?.scripts.find(script => script.id === editor?.id);
  const stale = () => editor?.id && selected()?.revision !== editor.revision;
  function notice(text, error = false) {
    el('status').textContent = text;
    el('status').className = error ? 'notice error' : 'notice success';
  }
  async function send(message) {
    const response = await api.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Refresh status to retry.');
    return response;
  }
  function confirm(title, text, action) {
    if (confirming) return Promise.resolve(false);
    confirming = true; render();
    el('confirmTitle').textContent = title; el('confirmText').textContent = text; el('confirmAccept').textContent = action;
    const dialog = el('confirmDialog'); dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => {
        const accepted = dialog.returnValue === 'accept';
        confirming = false; render(); resolve(accepted);
        queueMicrotask(drainRefresh);
      }, { once: true });
      dialog.showModal();
    });
  }
  const discardPermission = () => !dirty() || confirm('Discard this draft?', 'Your unsaved source edits will be discarded. The saved script stays in your library.', 'Discard draft');
  function openEditor(script, source) {
    editor = script ? { id: script.id, revision: script.revision, source: script.source } : source !== undefined ? { source: '' } : null;
    const input = el('scriptSource');
    input.value = script?.source ?? source ?? '';
    // Assigning a value leaves the caret at the end of the text, and focusing then
    // scrolls the editor to the end of the last line. Open every script at its start.
    input.setSelectionRange(0, 0); input.scrollTop = 0; input.scrollLeft = 0;
    render();
  }
  function preview() {
    const container = el('scriptPreview'); container.replaceChildren();
    const note = (text, className = 'muted') => { const p = document.createElement('p'); p.textContent = text; p.className = className; container.append(p); };
    if (!editor) { note('Choose a saved script or create one.'); return; }
    try {
      const meta = core.parse(el('scriptSource').value), details = document.createElement('dl');
      details.className = 'meta';
      const row = (term, value, literal = false) => {
        const dt = document.createElement('dt'), dd = document.createElement('dd'), text = literal ? document.createElement('code') : dd;
        dt.textContent = term; text.textContent = value;
        if (literal) dd.append(text);
        details.append(dt, dd);
      };
      row('Script', meta.name + ' · ' + meta.version);
      row('Sites', meta.matches.join(', '), true);
      if (meta.excludeMatches.length) row('Excluded', meta.excludeMatches.join(', '), true);
      row('Timing', meta.runAt.replace('_', '-'));
      row('Frames', meta.allFrames ? 'Matching frames' : 'Top frame only');
      row('World', meta.world === 'MAIN' ? 'Page world (shared with the site)' : 'Isolated script world');
      row('APIs', meta.grants.join(', ') || 'none', true);
      container.append(details);
      for (const warning of meta.warnings) note(warning);
    } catch (error) { note(error.message, 'error-text'); }
  }
  function render() {
    const locked = busy || confirming;
    const blocking = modules.find(module => module.id === 'blocking'), userscripts = modules.find(module => module.id === 'userscripts');
    for (const [module, input, badge] of [[blocking, 'blockingEnabled', 'blockerStatus'], [userscripts, 'userscriptsEnabled', 'scriptsStatus']]) {
      el(input).checked = Boolean(module?.enabled);
      el(input).disabled = locked || typeof module?.enabled !== 'boolean' ||
        (input === 'userscriptsEnabled' && !module.available && !module.enabled);
      el(badge).textContent = !module ? 'Checking' : module.enabled === null || (module.enabled && module.error) ? 'Needs attention' : module.active ? 'Active' : 'Off';
      el(badge).className = 'badge' + (module?.active ? ' active' : module?.enabled && module.error ? ' problem' : '');
    }
    el('blockerCard').classList.toggle('off', !blocking?.active);
    el('scriptsCard').classList.toggle('off', !userscripts?.active);
    const count = el('scriptCount');
    if (!library) count.textContent = 'Local script library';
    else count.replaceChildren(...[[library.scripts.filter(script => script.enabled).length, ' enabled'], [library.scripts.length, ' saved']].map(([number, label]) => {
      const chip = document.createElement('span'), value = document.createElement('b');
      value.textContent = String(number); chip.append(value, label); return chip;
    }));
    el('scriptAccess').textContent = !userscripts ? '' : userscripts.available ? 'Browser access allowed' : 'Browser access needed';
    el('scriptAccess').classList.toggle('needed', Boolean(userscripts && !userscripts.available));
    el('accessPanel').hidden = !userscripts || userscripts.available;
    el('accessHelp').textContent = userscripts?.error || 'Browser userscript access is unavailable.';
    el('grantAccess').hidden = !userscripts?.needsPermission;
    el('grantAccess').disabled = locked;
    el('extensionDetails').disabled = locked;
    el('refresh').disabled = locked;
    el('newScript').disabled = el('importScript').disabled = locked || !library;
    el('libraryCount').textContent = (library?.scripts.length || 0) + ' scripts';
    const list = el('scriptList'), search = el('searchScripts').value.trim().toLowerCase(); list.replaceChildren();
    const scripts = (library?.scripts || []).filter(script => [script.metadata.name, ...script.metadata.matches].join(' ').toLowerCase().includes(search));
    for (const script of scripts) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.className = 'script-item'; button.disabled = locked;
      button.setAttribute('aria-pressed', String(script.id === editor?.id)); button.dataset.id = script.id;
      const main = document.createElement('span'); main.className = 'script-main';
      const title = document.createElement('strong'); title.textContent = script.metadata.name;
      const detail = document.createElement('small'); detail.textContent = script.metadata.matches.join(', ');
      const state = document.createElement('span'); state.className = 'script-state' + (script.enabled ? ' on' : '');
      state.textContent = script.enabled ? 'On' : 'Off'; state.title = script.enabled ? 'Enabled' : 'Disabled';
      main.append(title, detail); button.append(main, state); item.append(button); list.append(item);
      button.addEventListener('click', async () => {
        if (await discardPermission()) { openEditor(script); el('scriptSource').focus(); }
      });
    }
    el('emptyLibrary').hidden = scripts.length > 0;
    el('emptyLibrary').textContent = search ? 'No matching scripts.' : 'No scripts yet. Create one or import a local .user.js file.';
    const script = selected(), changed = dirty();
    el('editorHeading').textContent = script?.metadata.name || (editor ? 'New script' : 'Script editor');
    el('draftState').textContent = stale() ? 'Saved script changed elsewhere' : changed ? 'Unsaved draft' : script ? 'Saved · ' + (script.enabled ? 'enabled' : 'disabled') : editor ? 'Not saved' : 'No script open';
    el('draftState').classList.toggle('dirty', stale() || changed);
    el('activationHelp').textContent = !editor ? 'Open a script to change this' : !script ? 'Available after saving'
      : stale() ? 'Load the latest version first' : changed ? 'Save or discard changes first'
      : !script.enabled ? 'Off for future page loads' : userscripts?.active ? 'Runs on matching page loads' : 'Turn on Userscripts to run it';
    el('saveHint').textContent = changed ? 'Unsaved changes. A saved script stays off until you switch it back on.'
      : 'Saved scripts start turned off. Reload open pages after changing a script.';
    el('saveHint').classList.toggle('dirty', changed);
    el('scriptSource').disabled = locked || !editor;
    el('saveScript').disabled = locked || !editor || (!changed && Boolean(editor.id));
    el('discardDraft').disabled = locked || !editor || (!changed && !stale());
    el('exportScript').disabled = locked || !editor;
    el('deleteScript').disabled = locked || !script;
    el('scriptEnabled').disabled = locked || !script || changed || stale();
    el('scriptEnabled').checked = Boolean(script?.enabled);
    preview();
  }
  async function load() {
    const results = await Promise.allSettled([send({ type: 'MODULES_GET' }), send({ type: 'US_LIST' })]);
    const errors = [];
    if (results[0].status === 'fulfilled') modules = results[0].value.modules; else errors.push(results[0].reason.message);
    if (results[1].status === 'fulfilled') {
      library = results[1].value;
      // Never replace an open draft on a storage notification, including deletions.
      if (editor?.id && !dirty() && !stale()) {
        const fresh = selected(); if (fresh) editor = { id: fresh.id, revision: fresh.revision, source: fresh.source };
      }
    } else errors.push(results[1].reason.message);
    const blockerError = modules.find(module => module.id === 'blocking')?.error;
    if (blockerError) errors.push('Ad blocking: ' + blockerError);
    if (errors.length) throw new Error(errors.join(' '));
  }
  async function run(work, success) {
    if (busy || confirming) return;
    busy = true; render();
    try { await work(); if (success) notice(success); }
    catch (error) { notice(error.message || String(error), true); }
    finally {
      busy = false; render();
      drainRefresh();
    }
  }
  function drainRefresh() {
    if (pendingRefresh && !busy && !confirming) { pendingRefresh = false; void run(load); }
  }
  el('refresh').addEventListener('click', () => run(load, 'Status refreshed. Reload open pages after changing scripts.'));
  el('blockingEnabled').addEventListener('change', () => {
    const enabled = el('blockingEnabled').checked;
    void run(async () => { await send({ type: 'MODULE_SET', id: 'blocking', enabled }); await load(); }, enabled ? 'Ad blocking enabled.' : 'Ad blocking paused. The userscript module has its own switch.');
  });
  el('userscriptsEnabled').addEventListener('change', () => {
    const enabled = el('userscriptsEnabled').checked;
    void run(async () => { await send({ type: 'MODULE_SET', id: 'userscripts', enabled }); await load(); }, enabled ? 'Userscripts enabled for future page loads.' : 'Userscripts paused for future page loads. Reload open pages to clear earlier changes.');
  });
  el('grantAccess').addEventListener('click', () => {
    // Request directly in the trusted gesture, before any asynchronous work.
    const permission = api.permissions.request({ permissions: ['userScripts'] });
    void run(async () => { if (!await permission) throw new Error('Userscript permission was not granted.'); await load(); }, 'Permission granted. If browser access is still unavailable, enable Allow User Scripts in extension details and refresh status.');
  });
  el('extensionDetails').addEventListener('click', () => run(async () => {
    const url = /Firefox\//.test(navigator.userAgent) ? 'about:addons' :
      (/Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome') + '://extensions/?id=' + api.runtime.id;
    await api.tabs.create({ url });
  }));
  el('newScript').addEventListener('click', async () => {
    if (await discardPermission()) { openEditor(null, template); el('scriptSource').focus(); notice('New draft. Review its site scope, then save it. Saved scripts start turned off.'); }
  });
  el('importScript').addEventListener('click', () => el('scriptFile').click());
  el('scriptFile').addEventListener('change', () => {
    const file = el('scriptFile').files[0]; el('scriptFile').value = ''; if (!file) return;
    if (busy || confirming) { notice('Wait for the current action, then import the file again.', true); return; }
    void run(async () => {
      if (file.size > core.LIMITS.source) throw new Error('Import a .user.js file of at most 128 KiB.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); core.parse(source);
      if (await discardPermission()) { openEditor(null, source); notice('Imported as a draft. Review the source and site scope, then save it. Saved scripts start turned off.'); }
    });
  });
  el('scriptSource').addEventListener('input', render);
  el('searchScripts').addEventListener('input', render);
  el('saveScript').addEventListener('click', () => {
    const message = { type: 'US_SAVE', source: el('scriptSource').value, ...(editor?.id ? { id: editor.id, revision: editor.revision } : {}) };
    void run(async () => {
      library = await send(message);
      openEditor(library.scripts.find(script => script.id === library.selectedId));
      await load();
    }, 'Script saved and turned off. Review its sites, then turn on Run this script.');
  });
  el('scriptEnabled').addEventListener('change', () => {
    const enabled = el('scriptEnabled').checked, script = selected();
    void run(async () => {
      library = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled });
      openEditor(library.scripts.find(item => item.id === script.id)); await load();
    }, enabled ? 'Script enabled. It runs on matching page loads while the userscript module is on.' : 'Script disabled for future loads. Reload pages where it already ran.');
  });
  el('discardDraft').addEventListener('click', async () => {
    if (await discardPermission()) void run(async () => {
      await load(); openEditor(selected());
    }, 'Loaded the latest saved source.');
  });
  el('deleteScript').addEventListener('click', async () => {
    const script = selected(); if (!script) return;
    if (!await confirm('Delete this script?', 'Delete “' + script.metadata.name + '”, its local values and any open draft? Reload pages where it already ran.', 'Delete script')) return;
    void run(async () => { library = await send({ type: 'US_DELETE', id: script.id, revision: script.revision }); openEditor(null); await load(); }, 'Script and its local values deleted.');
  });
  el('exportScript').addEventListener('click', () => {
    const source = el('scriptSource').value;
    let name = 'userscript'; try { name = core.parse(source).name; } catch { /* Export invalid drafts for recovery too. */ }
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = (name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'userscript') + '.user.js';
    document.body.append(link); link.click(); link.remove();
    // Give the browser's download task time to consume its local Blob URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice(dirty() ? 'Exported the current draft as a .user.js file.' : 'Exported the script as a .user.js file.');
  });
  addEventListener('beforeunload', event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !['userscriptManager', 'enabled', 'protectionError'].some(key => key in changes)) return;
    if (changes.userscriptManager && !changes.enabled && !changes.protectionError) {
      const visible = value => JSON.stringify({ enabled: value?.enabled,
        scripts: value?.scripts?.map(script => [script.id, script.revision, script.enabled]) });
      if (visible(changes.userscriptManager.oldValue) === visible(changes.userscriptManager.newValue)) return;
    }
    if (busy || confirming) pendingRefresh = true;
    else { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => {
      if (busy || confirming) pendingRefresh = true; else void run(load);
    }, 100); }
  });
  void run(load, 'Module settings loaded. Create or import a script to get started.');
})();
