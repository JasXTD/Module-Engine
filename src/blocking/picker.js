/* On-demand picker in the extension's isolated world. All page input is data. */
(async () => {
  'use strict';
  globalThis.BlockAdsPicker?.close();
  const api = typeof browser !== 'undefined' ? browser : chrome;
  const core = BlockAdsPickerCore;
  let disposed = false, host, dialog, observer, timer, expiryTimer, token;
  let selected = null, editing = false, previewing = false, busy = false, matching = [];
  let draftSelector = '', validatedSelector = null;
  let previewStyle = null, marked = new Set();
  const originalFocus = document.activeElement;
  const marker = 'data-blockads-preview-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
  const listeners = [];
  const listen = (target, type, callback, options) => { target.addEventListener(type, callback, options); listeners.push(() => target.removeEventListener(type, callback, options)); };
  const restore = () => {
    for (const node of marked) node.removeAttribute(marker);
    marked.clear(); previewStyle?.remove(); previewStyle = null;
  };
  function close() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect(); clearTimeout(timer); clearTimeout(expiryTimer);
    for (const remove of listeners) {
      try { remove(); } catch (error) { console.warn('[Module Engine] Picker listener cleanup:', error.message); }
    }
    restore();
    if (dialog?.matches(':popover-open')) dialog.hidePopover();
    host?.remove();
    if (originalFocus?.isConnected) originalFocus.focus({ preventScroll: true });
    if (token) {
      try { void api.runtime.sendMessage({ type: 'CLOSE_PICKER', token }).catch(() => {}); }
      catch { /* A reloaded extension cannot receive cleanup from its old context. */ }
    }
  }
  globalThis.BlockAdsPicker = Object.freeze({ close });
  try {
    const session = await api.runtime.sendMessage({ type: 'GET_PICKER_SESSION' });
    if (disposed) return false;
    if (!session?.ok) throw new Error(session?.error || 'The picker session is unavailable.');
    token = session.token;
    const startUrl = location.href;
    host = document.createElement('div');
    host.setAttribute('data-blockads-picker', '');
    host.style.setProperty('all', 'initial', 'important');
    // Keep controls out of the page's DOM API. The page is untrusted even
    // while a real user is interacting with this extension overlay.
    const shadow = host.attachShadow({ mode: 'closed' });
    // Static extension markup only. Selectors, domains and errors use textContent.
    shadow.innerHTML = `<style>
      :host { all: initial; color-scheme: dark; }
      * { box-sizing: border-box; }
      dialog { position:fixed; inset:0; width:100vw; height:100vh; max-width:none; max-height:none;
        margin:0; padding:0; border:0; background:transparent; color:#edf0f3; font:14px/1.45 system-ui,sans-serif; }
      dialog:popover-open { display:block; }
      dialog::backdrop { background:transparent; pointer-events:none; }
      #glass { position:absolute; inset:0; cursor:crosshair; }
      #outline { position:fixed; pointer-events:none; border:2px solid #c8f23a; box-shadow:0 0 0 1px #161a08; background:#c8f23a26; z-index:1; }
      #panel { position:fixed; right:16px; bottom:16px; width:360px; max-width:calc(100vw - 24px);
        max-height:calc(100vh - 24px); overflow:auto; padding:16px; border:1px solid #414853; border-radius:12px;
        background:#15181d; box-shadow:0 8px 32px #0008; z-index:2; }
      h2 { margin:0 0 6px; font-size:16px; } p { margin:8px 0; }
      #scope, #help { color:#a4adb8; font-size:12px; overflow-wrap:anywhere; }
      label { display:block; margin:12px 0 5px; font-weight:600; }
      textarea { display:block; resize:vertical; width:100%; min-height:70px; max-height:180px; padding:9px;
        background:#0d0f12; color:#edf0f3; border:1px solid #414853; border-radius:6px; font:12px/1.5 ui-monospace,monospace; }
      .row { display:flex; flex-wrap:wrap; gap:7px; margin-top:10px; }
      button { min-height:34px; padding:6px 11px; border:1px solid #414853; border-radius:6px; background:#272c34; color:#edf0f3;
        font:600 12px/1.4 system-ui,sans-serif; cursor:pointer; }
      button.primary { background:#c8f23a; color:#161a08; border-color:#c8f23a; }
      button:disabled { opacity:.5; cursor:not-allowed; }
      button:focus-visible, textarea:focus-visible { outline:2px solid #c8f23a; outline-offset:3px; }
      #status { min-height:22px; font-size:12px; } #status.error { color:#ff8a80; }
      [hidden] { display:none !important; }
      @media(max-width:420px) { #panel { right:12px; bottom:12px; } }
    </style><dialog popover="manual" aria-labelledby="title" aria-describedby="help">
      <div id="glass" aria-hidden="true"></div><div id="outline" hidden></div>
      <section id="panel"><h2 id="title">Module Engine · Pick an element</h2>
        <p id="scope"></p><p id="help">Point to an element and click. Keyboard users can choose a nearby element with the buttons below. Escape cancels.</p>
        <div class="row" id="navigation"><button id="parent">Parent</button><button id="child">Child</button><button id="previous">Previous</button><button id="next">Next</button></div>
        <div class="row"><button id="choose" class="primary">Use element</button><button id="again" hidden>Pick again</button></div>
        <div id="editor" hidden><label for="selector">CSS selector</label><textarea id="selector" maxlength="1000" spellcheck="false"></textarea>
          <p id="helpEdit">Check the match count and preview before saving. Saved rules can be removed in My lists.</p></div>
        <p id="status" role="status" aria-live="polite"></p>
        <div class="row"><button id="preview" hidden aria-pressed="false">Preview</button><button id="save" class="primary" hidden>Save hiding rule</button><button id="cancel">Cancel</button></div>
      </section></dialog>`;
    const byId = id => shadow.getElementById(id);
    dialog = shadow.querySelector('dialog');
    byId('scope').textContent = 'Applies to ' + session.domain + ' and its subdomains.';
    document.documentElement.append(host);
    const status = (text, error = false) => { byId('status').textContent = text; byId('status').classList.toggle('error', error); };
    function paint() {
      const box = selected?.isConnected ? selected.getBoundingClientRect() : null;
      byId('outline').hidden = !box?.width || !box?.height || previewing;
      if (box) Object.assign(byId('outline').style, { left: box.x+'px', top:box.y+'px', width:box.width+'px', height:box.height+'px' });
    }
    function select(node) {
      if (!core.selectable(node) || !node.getBoundingClientRect().width || !node.getBoundingClientRect().height) return false;
      selected = node; paint();
      byId('choose').disabled = false;
      for (const [id, candidate] of Object.entries({ parent:node.parentElement, child:node.firstElementChild, previous:node.previousElementSibling, next:node.nextElementSibling })) byId(id).disabled = !core.selectable(candidate);
      status('Selected: ' + node.localName);
      return true;
    }
    function updatePreview() {
      if (disposed || !editing || busy) return;
      restore(); matching = []; validatedSelector = null;
      try {
        const result = core.inspect(draftSelector);
        matching = result.nodes;
        validatedSelector = result.selector;
        if (previewing) {
          previewStyle = document.createElement('style'); previewStyle.textContent = '[' + marker + '] {display:none !important;}';
          for (const node of matching) { node.setAttribute(marker, ''); marked.add(node); }
          (document.head || document.documentElement).append(previewStyle);
        }
        status(matching.length + (matching.length === 1 ? ' element matches.' : ' elements match.') + (previewing ? ' Preview only — not saved.' : ''));
      } catch (error) { status(error.message, true); }
      byId('save').disabled = !matching.length; byId('preview').disabled = !matching.length && !previewing;
      byId('preview').setAttribute('aria-pressed', String(previewing));
      byId('preview').textContent = previewing ? 'Restore preview' : 'Preview';
      paint();
    }
    function choose() {
      try {
        draftSelector = core.selectorFor(selected);
        byId('selector').value = draftSelector;
        editing = true; previewing = false;
        for (const id of ['editor','again','preview','save']) byId(id).hidden = false;
        byId('navigation').hidden = true; byId('choose').hidden = true;
        byId('help').textContent = 'Only matching page elements are hidden. Page roots and very broad selections are refused.';
        updatePreview(); byId('selector').focus();
      } catch (error) { status(error.message, true); }
    }
    function underPointer(event) {
      // The top-layer glass takes the click; underlying links never receive it.
      // Temporarily skip our hit-test surfaces to identify the element below.
      const panel = byId('panel').getBoundingClientRect();
      if (event.clientX >= panel.left && event.clientX <= panel.right && event.clientY >= panel.top && event.clientY <= panel.bottom) return null;
      dialog.style.pointerEvents = 'none'; host.style.setProperty('pointer-events','none','important');
      const node = document.elementFromPoint(event.clientX, event.clientY);
      dialog.style.pointerEvents = ''; host.style.removeProperty('pointer-events');
      return node;
    }
    const trusted = fn => event => { if (event.isTrusted && !disposed && !busy) fn(event); };
    listen(byId('glass'), 'pointermove', trusted(event => { if (!editing) select(underPointer(event)); }));
    listen(byId('glass'), 'click', trusted(event => { event.preventDefault(); event.stopPropagation(); if (!editing && select(underPointer(event))) choose(); }));
    listen(byId('choose'), 'click', trusted(choose));
    listen(byId('cancel'), 'click', trusted(close));
    listen(dialog, 'cancel', event => { event.preventDefault(); if (event.isTrusted && !busy) close(); });
    listen(dialog, 'keydown', event => {
      if (!event.isTrusted) return;
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) close(); }
      if (event.key === 'Tab') {
        const controls = [...shadow.querySelectorAll('button, textarea')].filter(node => !node.disabled && node.getClientRects().length);
        if (!controls.length) { event.preventDefault(); return; }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    listen(byId('again'), 'click', trusted(() => {
      restore(); editing = false; previewing = false;
      draftSelector = ''; validatedSelector = null;
      for (const id of ['editor','again','preview','save']) byId(id).hidden = true;
      byId('navigation').hidden = false; byId('choose').hidden = false;
      select(selected); status('Choose another element.'); paint();
    }));
    for (const [id, property] of Object.entries({parent:'parentElement',child:'firstElementChild',previous:'previousElementSibling',next:'nextElementSibling'})) {
      listen(byId(id), 'click', trusted(() => { const next = selected?.[property]; if (select(next)) next.scrollIntoView({block:'nearest',inline:'nearest'}); }));
    }
    listen(byId('selector'), 'input', trusted(() => {
      draftSelector = byId('selector').value;
      updatePreview();
    }));
    listen(byId('preview'), 'click', trusted(() => { previewing = !previewing; updatePreview(); }));
    listen(byId('save'), 'click', trusted(async () => {
      updatePreview(); if (!matching.length || !validatedSelector) return;
      const selector = validatedSelector;
      busy = true; status('Saving…');
      for (const control of shadow.querySelectorAll('button, textarea')) control.disabled = true;
      try {
        const response = await api.runtime.sendMessage({ type:'SAVE_PICKER_FILTER', token, selector });
        if (disposed) return;
        if (!response?.ok) throw new Error(response?.error || 'Saving failed. Your preview has not been saved.');
        close();
      } catch (error) {
        if (disposed) return;
        busy = false;
        for (const control of shadow.querySelectorAll('button, textarea')) control.disabled = false;
        updatePreview(); status(error.message, true);
      }
    }));
    listen(window, 'pagehide', event => { if (event.isTrusted) close(); });
    listen(window, 'popstate', () => { if (location.href !== startUrl) close(); });
    listen(window, 'hashchange', () => { if (location.href !== startUrl) close(); });
    listen(window, 'resize', paint);
    listen(window, 'scroll', paint, true);
    const changed = (changes, area) => {
      if (area === 'local' && ['enabled','cosmeticFiltering','whitelistedDomains','cosmeticPausedDomains','rulesets'].some(key => key in changes)) {
        void api.runtime.sendMessage({type:'GET_COSMETIC_STATE'}).then(state => { if (!state?.ok || !state.enabled) close(); }).catch(close);
      }
    };
    api.storage.onChanged.addListener(changed); listeners.push(() => api.storage.onChanged.removeListener(changed));
    observer = new MutationObserver(records => {
      try { if (!api.runtime.id) { close(); return; } } catch { close(); return; }
      if (!host.isConnected || location.href !== startUrl) { close(); return; }
      const relevant = records.some(record => record.target !== host && !host.contains(record.target) && record.attributeName !== marker &&
        !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node === previewStyle || node.nodeName === 'STYLE')));
      if (!relevant || timer) return;
      timer = setTimeout(() => { timer = null; if (editing) updatePreview(); else paint(); }, 120);
    });
    observer.observe(document.documentElement, {subtree:true,childList:true,attributes:true,characterData:true});
    expiryTimer = setTimeout(close, Math.max(0, session.expiresAt - Date.now()));
    dialog.showPopover();
    byId('choose').disabled = true;
    for (const id of ['parent','child','previous','next']) byId(id).disabled = true;
    if (!select(originalFocus)) select([...document.body.children].find(node => core.selectable(node) && node.getBoundingClientRect().width && node.getBoundingClientRect().height));
    byId('cancel').focus();
    return true;
  } catch (error) {
    console.warn('[Module Engine] Picker could not start:', error.message); close(); return false;
  }
})();
