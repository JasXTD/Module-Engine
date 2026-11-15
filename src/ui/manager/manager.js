/* Extension-page controller. Script source is text throughout this interface. */
(() => {
  'use strict';
  const api = typeof browser !== 'undefined' ? browser : chrome, core = BlockAdsUserScriptCore, updates = BlockAdsUserScriptUpdates;
  const el = id => document.getElementById(id);
  const sourceEditor = BlockAdsEditor.create();
  const completion = BlockAdsCompletion.attach(el('scriptSource')), normalizeSource = ModuleEngineExternalEditor.normalize;
  const template = ['// ==UserScript==', '// @name         My page customization', '// @namespace    local.module-engine',
    '// @version      1.0', '// @description  A local page customization', '// @match        https://example.com/*',
    '// @run-at       document-idle', '// @grant        none', '// ==/UserScript==', '', '// Your script goes here.', ''].join('\n');
  let library = null, modules = [], editor = null, busy = false, confirming = false, pendingRefresh = false, refreshTimer;
  let assetJob = null;
  let installation = null;
  // Background update results are review data only; the library stays the source of truth.
  let updateState = null, checkingAll = false;
  let helperPermissions = [], allowedPermissions = new Set();
  let editorKey = 0;
  const externalEditor = ModuleEngineExternalEditor.create({
    state: () => ({ key: editorKey, locked: busy || confirming || Boolean(installation) || !editor || Boolean(stale()),
      source: el('scriptSource').value, dirty: sourceDirty(), identity: selected()?.metadata }),
    confirm,
    load: source => {
      completion.hide(); const input = el('scriptSource'); input.value = source; input.setSelectionRange(0, 0);
      input.scrollTop = input.scrollLeft = 0; sourceEditor.update(source); render(); input.focus(); sourceEditor.sync();
    }
  });
  const sourceDirty = () => editor !== null && el('scriptSource').value !== editor.source;
  const tagsDirty = () => Boolean(editor?.id && el('scriptTags').value !== editor.tags);
  const dirty = () => sourceDirty() || tagsDirty();
  const allTags = script => [...new Set([...(script.tags || []), ...(script.metadata.tags || [])])];
  const selected = () => library?.scripts.find(script => script.id === editor?.id);
  const stale = () => editor?.id && selected()?.revision !== editor.revision;
  function notice(text, error = false) {
    el('status').textContent = text;
    el('status').className = error ? 'notice error' : 'notice success';
  }
  async function send(message) {
    const response = await api.runtime.sendMessage(message);
    if (!response?.ok) throw Object.assign(new Error(response?.error || 'The extension did not respond. Refresh status to retry.'),
      typeof response?.code === 'string' ? { code: response.code } : {});
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
  const discardPermission = () => !dirty() || confirm('Discard this draft?', 'Your unsaved source or tag edits will be discarded. The saved script stays in your library.', 'Discard draft');
  function openEditor(script, source, { keepTracking = false } = {}) {
    if (!keepTracking) { editorKey++; externalEditor.stop(); }
    completion.hide();
    editor = script ? { id: script.id, revision: script.revision, source: normalizeSource(script.source), tags: (script.tags || []).join(', ') } : source !== undefined ? { source: '' } : null;
    el('scriptTags').value = editor?.tags || '';
    const input = el('scriptSource');
    input.value = script?.source ?? source ?? '';
    // Render first: the editor body is hidden while no script is open.
    render();
    // Assigning a value leaves the caret at the end of the text, and focusing then
    // scrolls the editor to the end of the last line. Open every script at its start.
    input.setSelectionRange(0, 0); input.scrollTop = 0; input.scrollLeft = 0;
    sourceEditor.update(input.value); sourceEditor.sync();
  }
  const updateInfo = script => script && updateState?.scripts?.[script.id] || null;
  const updateReady = script => { const info = updateInfo(script); return ['staged', 'available'].includes(info?.outcome) ? info.available || '' : null; };
  const when = time => new Date(time).toLocaleString();
  const code = text => { const node = document.createElement('code'); node.textContent = text; return node; };
  const size = bytes => bytes < 1024 ? bytes + ' bytes' : (bytes / 1024).toFixed(1) + ' KiB';
  // The MCP page shows agent proposals with this same review.
  const { cookieScope, worldDescription } = BlockAdsScriptReview;
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
      if (meta.description) row('Description', meta.description);
      row('Sites', [...meta.matches, ...meta.includes].join(', '), true);
      if (meta.excludeMatches.length || meta.excludes.length) row('Excluded', [...meta.excludeMatches, ...meta.excludes].join(', '), true);
      row('Timing', meta.runAt.replace('_', '-'));
      row('Execution', meta.unwrap ? 'Unwrapped global code; grants ignored' : meta.topLevelAwait ? 'Async wrapper; top-level await enabled' : 'Function wrapper');
      row('Frames', meta.allFrames ? 'Matching frames' : 'Top frame only');
      row('World', worldDescription(meta));
      row('APIs', meta.grants.join(', ') || 'none', true);
      if (meta.tags.length) row('Author tags', meta.tags.join(', '));
      if (meta.grants.some(grant => /^GM[._]openInTab$/.test(grant))) row('Tab access', 'Open HTTP(S) tabs and close tabs created by this script instance.', true);
      if (meta.grants.some(grant => /xmlhttprequest|[._]download$/i.test(grant))) row('Network access', meta.connects.join(', ') || 'Any HTTP(S) destination (no @connect restriction)', true);
      if (meta.grants.some(grant => /^GM[._]cookie$/.test(grant))) row('Cookie access', cookieScope(meta), true);
      container.append(details);
      if (meta.injection === 'auto' && !meta.unwrap && selected()?.enabled && !selected().autoPageApproved && !sourceDirty())
        note('This older auto script still runs isolated. Review the page-access warning, then disable and re-enable it to use page-first execution.');
      for (const warning of meta.warnings) note(warning);
    } catch (error) { note(error.message, 'error-text'); }
  }
  function renderAssets(locked) {
    const script = selected(), list = el('dependencyList'); list.replaceChildren();
    let specs = []; try { if (editor) specs = core.assetSpecs(core.parse(el('scriptSource').value)); } catch { /* The source preview reports metadata errors. */ }
    el('dependencies').hidden = !specs.length && !assetJob;
    for (const [index, spec] of specs.entries()) {
      // One row per dependency: what declares it, its URL and, once cached, its digest.
      const item = document.createElement('li'), info = document.createElement('div'), kind = document.createElement('span'), url = document.createElement('code');
      info.className = 'dependency-info'; kind.className = 'dependency-kind';
      kind.textContent = spec.kind === 'resource' ? '@resource ' + spec.name : '@require';
      url.textContent = spec.url; info.append(kind, url); item.append(info);
      const asset = !dirty() && !stale() ? script?.assets?.[index] : null;
      if (asset) {
        const detail = document.createElement('small'); detail.textContent = size(asset.size) + ' · SHA-256 ' + asset.sha256; info.append(detail);
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Review contents'; button.disabled = locked;
        button.addEventListener('click', () => run(async () => {
          const response = await send({ type: 'US_ASSET_READ', id: script.id, revision: script.revision, index });
          el('assetTitle').textContent = asset.name || '@require'; el('assetDigest').textContent = asset.url + '\nSHA-256 ' + asset.sha256;
          el('assetSource').value = response.asset.text; el('assetDialog').showModal();
          el('assetSource').setSelectionRange(0, 0); el('assetSource').scrollTop = 0;
          el('assetDialog').scrollTop = 0; el('assetTitle').focus({ preventScroll: true });
        }));
        item.append(button);
      }
      list.append(item);
    }
    el('prepareAssets').disabled = locked || Boolean(assetJob) || !script || script.enabled || dirty() || stale();
    el('prepareAssets').textContent = script?.assets ? 'Download again' : 'Prepare dependencies';
    el('cancelAssets').hidden = !assetJob; el('cancelAssets').disabled = locked;
    el('dependencyStatus').textContent = assetJob ? 'Downloading dependencies… Other module controls remain available.' : !script || dirty() || stale() ? 'Save and reopen the current source first.'
      : script.enabled ? 'Disable this script to download dependencies again.' : script.assets ? 'Cached. Review the contents, then enable this script.' : 'Prepare dependencies before enabling this script.';
  }
  function render() {
    const locked = busy || confirming || Boolean(installation);
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
    el('worldLimitWarning').hidden = !library?.enabled || library.scripts.filter(script => script.enabled && core.nativeWorld(script.metadata) === 'USER_SCRIPT').length <= 10;
    el('accessPanel').hidden = !userscripts || userscripts.available;
    el('accessHelp').textContent = userscripts?.error || 'Browser userscript access is unavailable.';
    el('grantAccess').hidden = !userscripts?.needsPermission;
    el('grantAccess').disabled = locked;
    el('extensionDetails').disabled = locked;
    el('refresh').disabled = locked;
    el('newScript').disabled = el('importScript').disabled = locked || !library;
    el('installURL').disabled = locked || !library || Boolean(assetJob);
    el('interceptLinks').checked = Boolean(updateState?.interceptLinks); el('autoCheck').checked = Boolean(updateState?.autoCheck);
    el('interceptLinks').disabled = el('autoCheck').disabled = locked || !updateState;
    const checking = checkingAll || Boolean(updateState?.checking), waiting = (library?.scripts || []).filter(item => updateReady(item) !== null).length;
    el('checkAll').disabled = locked || checking || !library?.scripts.some(item => item.sourceURL);
    el('checkAll').textContent = checking ? 'Checking…' : 'Check all now';
    el('updateSummary').textContent = !updateState ? '' : updateState.error || (checking ? 'Checking linked scripts…'
      : waiting ? waiting + (waiting === 1 ? ' update' : ' updates') + ' ready to review' : library?.enabled ? '' : 'Both run only while Userscripts is on.');
    el('updateSummary').classList.toggle('error-text', Boolean(updateState?.error));
    const total = library?.scripts.length || 0;
    el('libraryCount').textContent = total + (total === 1 ? ' script' : ' scripts');
    const list = el('scriptList'), search = el('searchScripts').value.trim().toLowerCase(); list.replaceChildren();
    const filter = el('tagFilter'), chosen = filter.value;
    const tags = [...new Set((library?.scripts || []).flatMap(allTags))].sort((a, b) => a.localeCompare(b));
    filter.replaceChildren(...['', ...tags].map(tag => { const option = document.createElement('option'); option.value = tag; option.textContent = tag || 'All tags'; return option; }));
    filter.value = tags.includes(chosen) ? chosen : '';
    const scripts = (library?.scripts || []).filter(script => (!filter.value || allTags(script).includes(filter.value)) &&
      [script.metadata.name, ...script.metadata.matches, ...script.metadata.includes, ...allTags(script)].join(' ').toLowerCase().includes(search));
    for (const script of scripts) {
      const item = document.createElement('li'), button = document.createElement('button');
      button.className = 'script-item'; button.disabled = locked;
      button.setAttribute('aria-pressed', String(script.id === editor?.id)); button.dataset.id = script.id;
      const main = document.createElement('span'); main.className = 'script-main';
      // Long names and site lists are clipped in the list; the tooltip keeps them whole.
      const title = document.createElement('strong'); title.textContent = title.title = script.metadata.name;
      const detail = document.createElement('small'); detail.textContent = detail.title = [...script.metadata.matches, ...script.metadata.includes].join(', ');
      const state = document.createElement('span'); state.className = 'script-state' + (script.enabled ? ' on' : '');
      state.textContent = script.enabled ? 'On' : 'Off'; state.title = script.enabled ? 'Enabled' : 'Disabled';
      main.append(title, detail); button.append(main);
      const ready = updateReady(script);
      if (ready !== null) {
        const chip = document.createElement('span'); chip.className = 'script-state update'; chip.textContent = 'Update';
        chip.title = 'Update' + (ready ? ' ' + ready : '') + ' ready to review'; button.append(chip);
      }
      button.append(state); item.append(button); list.append(item);
      const labels = allTags(script);
      if (labels.length) { const tags = document.createElement('small'); tags.className = 'script-tags'; tags.textContent = tags.title = labels.join(' · '); main.append(tags); }
      button.addEventListener('click', async () => {
        if (await discardPermission()) { openEditor(script); el('scriptSource').focus(); }
      });
    }
    el('emptyLibrary').hidden = scripts.length > 0;
    el('emptyLibrary').textContent = search || filter.value ? 'No matching scripts.' : 'No scripts yet. Create one or import a local .user.js file.';
    const script = selected(), changed = dirty();
    const position = script ? library.scripts.indexOf(script) : -1;
    el('organization').hidden = !script;
    el('scriptTags').disabled = locked || !script || stale();
    el('saveTags').disabled = locked || !script || !tagsDirty() || sourceDirty() || stale();
    el('orderPosition').textContent = 'Position ' + (position + 1) + ' of ' + total;
    el('moveEarlier').disabled = locked || changed || stale() || position <= 0;
    el('moveLater').disabled = locked || changed || stale() || position < 0 || position >= total - 1;
    // With nothing open, the editor shows a short empty state instead of disabled controls.
    el('editorEmpty').hidden = Boolean(editor);
    for (const id of ['editorBody', 'editorIntro', 'runControl', 'draftState']) el(id).hidden = !editor;
    el('editorHeading').textContent = script?.metadata.name || (editor ? 'New script' : 'Script editor');
    el('draftState').textContent = stale() ? 'Saved script changed elsewhere' : changed ? 'Unsaved draft' : script ? 'Saved · ' + (script.enabled ? 'enabled' : 'disabled') : editor ? 'Not saved' : 'No script open';
    el('draftState').classList.toggle('dirty', stale() || changed);
    el('activationHelp').textContent = !editor ? 'Open a script to change this' : !script ? 'Available after saving'
      : stale() ? 'Load the latest version first' : changed ? 'Save or discard changes first'
      : !script.enabled ? 'Off for future page loads' : userscripts?.active ? 'Runs on matching page loads' : 'Turn on Userscripts to run it';
    el('saveHint').textContent = !changed ? 'Saved scripts start turned off. Reload open pages after changing a script.'
      : !sourceDirty() && script ? 'Unsaved tags. Save tags to keep the current script state.'
      : script?.enabled ? 'Unsaved changes. Saving turns this script off until you switch it back on.'
      : 'Unsaved changes. A saved script stays off until you switch it on.';
    el('saveHint').classList.toggle('dirty', changed);
    el('scriptSource').disabled = locked || !editor;
    el('showSuggestions').disabled = locked || !editor;
    if (locked) completion.hide();
    externalEditor.render();
    el('saveScript').disabled = locked || !editor || (!sourceDirty() && Boolean(editor.id));
    el('discardDraft').disabled = locked || !editor || (!changed && !stale());
    el('exportScript').disabled = locked || !editor;
    el('deleteScript').disabled = locked || !script;
    el('scriptEnabled').disabled = locked || !script || changed || stale() || !script.enabled && core.assetSpecs(script.metadata).length > 0 && !script.assets;
    el('scriptEnabled').checked = Boolean(script?.enabled);
    el('scriptUpdates').hidden = !script;
    renderUpdates(script, locked || changed || Boolean(stale()) || Boolean(assetJob));
    preview();
    let grants = [];
    try { grants = editor ? core.parse(el('scriptSource').value).grants : []; helperPermissions = BlockAdsUserScriptActions.permissions(grants, /Firefox\//.test(navigator.userAgent)); }
    catch { helperPermissions = []; } // The source preview displays invalid metadata.
    const missing = helperPermissions.filter(permission => !allowedPermissions.has(permission));
    // Firefox tab helpers need the cookies permission only to keep containers.
    const helperLabels = { clipboardWrite: 'copy to the clipboard', notifications: 'show notifications', downloads: 'save files',
      offscreen: 'report upload progress', webRequestBlocking: 'check Firefox redirect destinations',
      cookies: grants.some(grant => /^GM[._]cookie$/.test(grant)) ? 'read and change cookies, including HttpOnly cookies' : 'open tabs in Firefox containers' };
    el('helperAccess').hidden = !helperPermissions.length;
    el('helperAccess').classList.toggle('needed', missing.length > 0);
    el('helperAccessText').textContent = missing.length
      ? 'Allow this script to ' + helperPermissions.filter(permission => helperLabels[permission]).map(permission => helperLabels[permission]).join(', ') + '. Only allow access after reviewing its source.'
      : 'Browser access is allowed for this script’s helpers.';
    el('grantHelpers').hidden = !missing.length;
    el('grantHelpers').disabled = locked;
    renderAssets(locked);
    renderInstallation();
  }
  function renderUpdates(script, blocked) {
    const installed = el('installedSource'), route = el('updateRoute'), result = el('updateResult');
    const linked = Boolean(script?.sourceURL), info = updateInfo(script), ready = updateReady(script);
    // Only a script installed from a URL is checked; a local one gets the way to link one.
    if (linked) installed.replaceChildren('Installed from ', code(script.sourceURL));
    else if (info?.suggested) installed.replaceChildren('Local script. Its @downloadURL is ', code(info.suggested), '. Review it to link updates; nothing is contacted until you do.');
    else installed.textContent = 'Local script. To link an update URL, use Install from URL with the same @name and @namespace.';
    const parts = [];
    if (linked && info?.download && info.download !== script.sourceURL) parts.push('Updates download from ', code(info.download), '. ');
    if (linked && info?.version) parts.push('Versions are checked at ', code(info.version), '. ');
    if (linked) parts.push(...(info?.notes || []).map(note => note + ' '));
    route.replaceChildren(...parts); route.hidden = !parts.length;
    const version = script?.metadata.explicitVersion || 'unversioned';
    result.textContent = !linked || !info ? ''
      : info.outcome === 'staged' ? 'Update ready: ' + version + ' → ' + info.available + '. Downloaded ' + when(info.checkedAt) + '; nothing changes until you apply it.'
      : info.outcome === 'available' ? 'Version ' + info.available + ' is available (found ' + when(info.checkedAt) + '). Reviewing it downloads the source again.'
      : info.outcome === 'current' ? 'Up to date' + (info.available ? ' (offered version ' + info.available + ')' : '') + ' · checked ' + when(info.checkedAt) + '.'
      : info.outcome === 'error' ? 'Last check failed ' + when(info.checkedAt) + ': ' + info.message
      : info.outcome === 'skipped' ? info.message
      : !info.automatic ? 'Automatic checks need an @version. Use Check for updates to review changes.'
      : !updateState.autoCheck ? 'Daily checks are off. Check for updates at any time.'
      : !library?.enabled ? 'Daily checks run while Userscripts is on.' : 'Not checked yet. Daily checks run in the background.';
    result.hidden = !result.textContent;
    result.className = info?.outcome === 'error' ? 'error-text' : ready !== null ? 'update-ready' : 'muted';
    el('reviewUpdate').hidden = !linked || ready === null;
    el('reviewUpdate').disabled = blocked;
    el('linkDownload').hidden = linked || !info?.suggested;
    el('linkDownload').disabled = blocked || !library;
    el('checkUpdate').hidden = el('updateHelp').hidden = !linked;
    el('checkUpdate').disabled = blocked || !linked;
  }
  function renderInstallation() {
    if (!installation) return;
    const { review, requestId, committing } = installation;
    const changed = review?.id && library?.scripts.find(script => script.id === review.id)?.revision !== review.revision;
    el('sourceURL').disabled = Boolean(requestId || committing);
    el('fetchSource').disabled = Boolean(requestId || committing || busy);
    el('cancelSource').disabled = Boolean(committing);
    el('cancelSource').textContent = requestId ? 'Cancel download' : 'Cancel';
    el('openRaw').hidden = !installation.intercepted;
    el('openRaw').disabled = Boolean(committing || busy);
    el('installReview').hidden = !review;
    el('applySource').hidden = !review;
    el('applySource').disabled = Boolean(!review || requestId || committing || busy || changed || review.unchanged || review.versionChange === -1);
    el('applySource').textContent = review?.id ? 'Apply update' : 'Install script';
    el('installStatus').textContent = changed ? 'This script changed in another window. Check again before applying.' : installation.status;
    el('installStatus').className = 'notice' + (installation.error || changed ? ' error' : '');
  }
  function showSourceReview(review) {
    const old = review.previousSource ? core.parse(review.previousSource) : null, next = review.metadata;
    BlockAdsScriptReview.render(el('reviewChanges'), BlockAdsScriptReview.rows(review.previousSource, review.source,
      { previousSourceURL: review.previousSourceURL, sourceURL: review.sourceURL }));
    // A first install has no current version to compare, so its empty column is hidden.
    el('installReview').classList.toggle('fresh', !old);
    el('reviewCaption').textContent = old ? 'Script access and settings · changed rows are marked' : 'Script access and settings';
    el('reviewURL').textContent = 'Fetched from: ' + review.sourceURL;
    el('previousCode').hidden = !old;
    el('reviewBefore').value = review.previousSource || ''; el('reviewAfter').value = review.source;
    for (const id of ['reviewBefore', 'reviewAfter']) { el(id).setSelectionRange(0, 0); el(id).scrollTop = 0; el(id).scrollLeft = 0; }
    el('reviewEffect').textContent = (old ? 'Applying replaces the current source, including local edits, and keeps saved script values. ' : 'Installing adds a paused script to your library. ')
      + 'Review the code and any dependencies, then turn on Run this script. Later checks use the update source shown above; every update needs your review. '
      + next.warnings.join(' ');
  }
  const destination = script => { try { return updates.targets(script).download || script.sourceURL; } catch { return script.sourceURL; } };
  async function fetchInstallation() {
    const state = installation; if (!state || state.requestId || state.committing || busy) return;
    // A downloaded update is offered once; Check again always downloads afresh.
    const staged = state.staged; state.staged = false;
    state.review = null; state.error = false; state.status = staged ? 'Opening the downloaded update…' : 'Fetching source for review…';
    state.requestId = crypto.randomUUID(); renderInstallation();
    try {
      if (state.script) {
        const current = library?.scripts.find(script => script.id === state.script.id);
        if (!current?.sourceURL) throw new Error('This script or its installed URL is no longer available. Close this review and refresh status.');
        state.script = current; el('sourceURL').value = destination(current);
      }
      const message = staged ? { type: 'US_STAGED_REVIEW', id: state.script.id, revision: state.script.revision }
        : state.script ? { type: 'US_CHECK_UPDATE', id: state.script.id, revision: state.script.revision }
        : { type: 'US_FETCH_SOURCE', url: el('sourceURL').value.trim() };
      const { review, checkedAt } = await send({ ...message, requestId: state.requestId });
      if (installation !== state) return;
      state.review = review;
      state.status = (staged ? 'Downloaded ' + when(checkedAt) + '. ' : '') + (review.unchanged ? 'Already up to date. The source is identical.'
        : !review.id ? 'Ready to review. This script has not been installed.'
        : review.versionChange === -1 ? 'The downloaded version is older. Downgrades are not applied.'
        : review.versionChange === 1 ? 'Newer version available: ' + core.parse(review.previousSource).version + ' → ' + review.metadata.version
        : review.previousSource === review.source ? 'Source is identical. Applying will link this URL and pause the script.'
        : review.versionChange === 0 ? 'Source changed without a newer version. Review all changes before applying.'
        : 'Source changed. Version numbers are missing or cannot be compared; review all changes before applying.');
      showSourceReview(review);
    } catch (error) {
      if (installation !== state) return;
      // A link to an HTML file view or a redirecting URL is not a direct
      // userscript: hand it back to the browser's ordinary handling.
      if (state.intercepted && !state.script && ['SOURCE_REDIRECT', 'SOURCE_NOT_SCRIPT'].includes(error.code) && await openInBrowser(state, true)) return;
      state.error = true; state.status = error.message + (state.intercepted ? ' Choose Open file in browser to view it normally.' : '');
    } finally { if (installation === state) { state.requestId = null; renderInstallation(); } }
  }
  async function openInBrowser(state, automatic = false) {
    if (!state.url || installation !== state || state.committing) return false;
    // The extension holds passage in memory. If it was lost, for example after a
    // worker restart, never hand the same link back automatically twice in a row.
    if (automatic) {
      try {
        const key = 'moduleEngineReturned:' + state.url, last = Number(sessionStorage.getItem(key)) || 0;
        if (Date.now() - last < 30000) return false;
        sessionStorage.setItem(key, String(Date.now()));
      } catch { return false; }
    }
    try { await send({ type: 'US_LINK_BYPASS', url: state.url }); }
    catch (error) { if (installation === state) { state.error = true; state.status = error.message; renderInstallation(); } return false; }
    if (installation !== state) return false;
    if (state.requestId) void send({ type: 'US_CANCEL_SOURCE', requestId: state.requestId }).catch(() => {});
    location.replace(state.url);
    return true;
  }
  function closeInstallation() {
    const state = installation; if (!state || state.committing) return;
    installation = null; el('installDialog').close(); render();
    const trigger = el(state.script ? 'checkUpdate' : 'installURL');
    if (!trigger.disabled) trigger.focus({ preventScroll: true });
    if (state.requestId) void send({ type: 'US_CANCEL_SOURCE', requestId: state.requestId }).catch(error => notice(error.message, true));
    drainRefresh();
  }
  async function openInstallation(script, { staged = false, url = '', intercepted = false } = {}) {
    if (busy || confirming || installation || !await discardPermission()) return;
    installation = { script, staged, intercepted, url, review: null,
      status: script ? 'Checking the update source…' : url ? 'Fetching source for review…' : 'Paste a direct .user.js URL to review its source.' };
    el('installTitle').textContent = script ? 'Review update' : intercepted ? 'Install from link' : 'Install from URL';
    el('sourceURL').value = script ? destination(script) : url; el('sourceURL').readOnly = Boolean(script);
    el('fetchSource').textContent = script ? 'Check again' : 'Fetch for review';
    render(); el('installDialog').showModal(); el('installDialog').scrollTop = 0;
    el(script || url ? 'installTitle' : 'sourceURL').focus({ preventScroll: true });
    if (script || url) void fetchInstallation();
  }
  async function load() {
    const results = await Promise.allSettled([send({ type: 'MODULES_GET' }), send({ type: 'US_LIST' }), api.permissions.getAll(), send({ type: 'US_UPDATE_STATE' })]);
    const errors = [];
    if (results[0].status === 'fulfilled') modules = results[0].value.modules; else errors.push(results[0].reason.message);
    if (results[1].status === 'fulfilled') {
      library = results[1].value;
      // Never replace an open draft on a storage notification, including deletions.
      if (editor?.id && !dirty() && !stale()) {
        const fresh = selected(); if (fresh) editor = { id: fresh.id, revision: fresh.revision, source: normalizeSource(fresh.source), tags: (fresh.tags || []).join(', ') };
      }
    } else errors.push(results[1].reason.message);
    if (results[2].status === 'fulfilled') allowedPermissions = new Set(results[2].value.permissions);
    else errors.push(results[2].reason.message);
    if (results[3].status === 'fulfilled') updateState = results[3].value;
    else { updateState = null; errors.push('Updates: ' + results[3].reason.message); }
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
  function requestRefresh() {
    if (busy || confirming) pendingRefresh = true;
    else { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => {
      if (busy || confirming) pendingRefresh = true; else void run(load);
    }, 100); }
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
  el('grantHelpers').addEventListener('click', () => {
    const permission = api.permissions.request({ permissions: helperPermissions });
    void run(async () => { if (!await permission) throw new Error('Helper access was not granted.'); await load(); },
      'Helper access granted. Reload the script’s page before trying it again.');
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
  el('installURL').addEventListener('click', () => { void openInstallation(); });
  el('checkUpdate').addEventListener('click', () => { void openInstallation(selected()); });
  el('reviewUpdate').addEventListener('click', () => {
    const script = selected(); if (script && !el('reviewUpdate').disabled) void openInstallation(script, { staged: updateInfo(script)?.outcome === 'staged' });
  });
  el('linkDownload').addEventListener('click', () => {
    const url = updateInfo(selected())?.suggested; if (url && !el('linkDownload').disabled) void openInstallation(null, { url });
  });
  el('openRaw').addEventListener('click', () => { if (installation && !el('openRaw').disabled) void openInBrowser(installation); });
  for (const id of ['interceptLinks', 'autoCheck']) el(id).addEventListener('change', () => {
    const value = el(id).checked;
    void run(async () => { updateState = await send({ type: 'US_UPDATE_SETTINGS', settings: { [id]: value } }); },
      id === 'interceptLinks' ? (value ? 'Opening a .user.js link now shows its review here first.' : '.user.js links now open normally in the browser.')
        : value ? 'Installed scripts are checked daily while Userscripts is on.' : 'Daily update checks are off. Check for updates at any time.');
  });
  el('checkAll').addEventListener('click', async () => {
    if (el('checkAll').disabled) return;
    checkingAll = true; render();
    try {
      updateState = await send({ type: 'US_CHECK_ALL' });
      const { checked, cancelled } = updateState.result, scripts = library?.scripts || [];
      const ready = scripts.filter(item => updateReady(item) !== null).length;
      const failed = scripts.filter(item => updateInfo(item)?.outcome === 'error').length;
      notice(cancelled ? 'Update checks were cancelled.' : 'Checked ' + checked + (checked === 1 ? ' script. ' : ' scripts. ')
        + (ready ? ready + (ready === 1 ? ' update is' : ' updates are') + ' ready to review.' : 'No updates are waiting.')
        + (failed ? ' ' + failed + (failed === 1 ? ' check' : ' checks') + ' failed; select a script for details.' : ''), cancelled || failed > 0 && !ready);
    } catch (error) { notice(error.message, true); }
    finally { checkingAll = false; render(); pendingRefresh = true; drainRefresh(); }
  });
  el('fetchSourceForm').addEventListener('submit', event => { event.preventDefault(); void fetchInstallation(); });
  el('sourceURL').addEventListener('input', () => {
    if (!installation || installation.requestId || installation.committing) return;
    installation.review = null; installation.error = false; installation.status = 'URL changed. Fetch the source again before installing.'; renderInstallation();
  });
  el('cancelSource').addEventListener('click', closeInstallation);
  el('installDialog').addEventListener('cancel', event => { event.preventDefault(); closeInstallation(); });
  // A queued close event from the previous review can arrive after reopening.
  el('installDialog').addEventListener('close', () => { if (!el('installDialog').open) closeInstallation(); });
  el('applySource').addEventListener('click', async () => {
    const state = installation, review = state?.review;
    if (!review || el('applySource').disabled || busy) return;
    busy = true; state.committing = true; render();
    try {
      library = await send({ type: 'US_APPLY_SOURCE', source: review.source, sourceURL: review.sourceURL,
        ...(review.id ? { id: review.id, revision: review.revision } : {}) });
      installation = null; el('installDialog').close();
      openEditor(library.scripts.find(script => script.id === library.selectedId)); await load();
      notice(review.id ? 'Update applied. Saved values kept; the script is paused. Review dependencies, then turn it on again.'
        : 'Script installed and paused. Review dependencies, then turn on Run this script.');
    } catch (error) {
      if (installation === state) { state.error = true; state.status = error.message; }
      else notice(error.message, true);
    } finally { busy = false; state.committing = false; render(); drainRefresh(); }
  });
  el('scriptFile').addEventListener('change', () => {
    const file = el('scriptFile').files[0]; el('scriptFile').value = ''; if (!file) return;
    if (busy || confirming) { notice('Wait for the current action, then import the file again.', true); return; }
    void run(async () => {
      if (file.size > core.LIMITS.source) throw new Error('Import a .user.js file of at most 128 KiB.');
      const source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); core.parse(source);
      if (await discardPermission()) { openEditor(null, source); notice('Imported as a draft. Review the source and site scope, then save it. Saved scripts start turned off.'); }
    });
  });
  el('scriptSource').addEventListener('input', () => { sourceEditor.update(el('scriptSource').value); render(); });
  el('prepareAssets').addEventListener('click', async () => {
    const script = selected(); if (!script || busy || confirming || assetJob || dirty() || stale()) return;
    const job = { id: script.id, revision: script.revision }; assetJob = job; render();
    try {
      const response = await send({ type: 'US_PREPARE_ASSETS', ...job });
      if (editor?.id === job.id && editor.revision === job.revision && !dirty()) {
        if (!library || response.revision >= library.revision) library = response;
        openEditor(response.scripts.find(item => item.id === job.id));
      }
      notice('Dependencies cached. Review their contents before enabling this script.');
    } catch (error) { notice(error.message, true); }
    finally { if (assetJob === job) assetJob = null; render(); pendingRefresh = true; drainRefresh(); }
  });
  el('cancelAssets').addEventListener('click', () => {
    if (assetJob) void run(() => send({ type: 'US_CANCEL_ASSETS', id: assetJob.id }), 'Dependency download cancelled.');
  });
  el('searchScripts').addEventListener('input', render);
  el('tagFilter').addEventListener('change', render);
  el('scriptTags').addEventListener('input', render);
  el('saveTags').addEventListener('click', () => {
    const script = selected(); if (!script || el('saveTags').disabled) return;
    void run(async () => {
      const tags = core.tags(el('scriptTags').value.split(',').map(tag => tag.trim()).filter(Boolean));
      library = await send({ type: 'US_TAGS', id: script.id, revision: editor.revision, tags });
      openEditor(library.scripts.find(item => item.id === script.id), undefined, { keepTracking: true }); await load();
    }, 'Local tags saved.');
  });
  for (const [id, direction] of [['moveEarlier', -1], ['moveLater', 1]]) el(id).addEventListener('click', () => {
    const script = selected(); if (!script || el(id).disabled) return;
    void run(async () => {
      library = await send({ type: 'US_MOVE', id: script.id, revision: editor.revision, direction, order: library.scripts.map(item => item.id) });
      await load();
    }, 'Execution order saved. Reload matching pages to use it.');
  });
  el('saveScript').addEventListener('click', () => {
    const message = { type: 'US_SAVE', source: el('scriptSource').value, ...(editor?.id ? { id: editor.id, revision: editor.revision,
      tags: el('scriptTags').value.split(',').map(tag => tag.trim()).filter(Boolean) } : {}) };
    void run(async () => {
      library = await send(message);
      openEditor(library.scripts.find(script => script.id === library.selectedId), undefined, { keepTracking: true });
      await load();
    }, 'Script saved and turned off. Review its sites, then turn on Run this script.');
  });
  el('scriptEnabled').addEventListener('change', () => {
    const enabled = el('scriptEnabled').checked, script = selected();
    void run(async () => {
      library = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled });
      openEditor(library.scripts.find(item => item.id === script.id), undefined, { keepTracking: true }); await load();
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
    if (area !== 'local' || !['userscriptManager', 'userscriptUpdates', 'enabled', 'protectionError'].some(key => key in changes)) return;
    if (changes.userscriptManager && !changes.userscriptUpdates && !changes.enabled && !changes.protectionError) {
      const visible = value => JSON.stringify({ enabled: value?.enabled,
        scripts: value?.scripts?.map(script => [script.id, script.revision, script.enabled]) });
      if (visible(changes.userscriptManager.oldValue) === visible(changes.userscriptManager.newValue)) return;
    }
    requestRefresh();
  });
  api.permissions.onAdded.addListener(requestRefresh);
  api.permissions.onRemoved.addListener(requestRefresh);
  // An intercepted .user.js link opens this page with its URL in the fragment.
  // Clear it so a reload does not fetch again; the review itself installs nothing.
  const linkedInstall = updates.installFromHash(location.hash);
  if (location.hash.startsWith('#install=')) history.replaceState(null, '', location.pathname + location.search);
  void run(load, linkedInstall ? 'Review the linked script before installing it.' : 'Module settings loaded. Create or import a script to get started.')
    .then(() => { if (linkedInstall) void openInstallation(null, { url: linkedInstall, intercepted: true }); });
})();
