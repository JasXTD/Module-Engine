/* Keep the six packaged sections in one tab. Their documents own their own
   state and ports; hiding a section never unloads it or transfers approval. */
(() => {
  'use strict';
  if (window !== top) return; // Only the tab owns navigation; no nested shells.
  const api = globalThis.browser || chrome;
  const paths = { manager: 'src/ui/manager/manager.html', lists: 'src/ui/lists/lists.html', log: 'src/ui/log/log.html',
    network: 'src/ui/network/network.html', mcp: 'src/ui/mcp/debug.html', appearance: 'src/ui/appearance/appearance.html' };
  const urls = new Map(Object.entries(paths).map(([key, path]) => [api.runtime.getURL(path), key]));
  const rootKey = urls.get(location.href.split('#')[0]);
  if (!rootKey) return;
  const views = new Map(), rootView = { key: rootKey, document, title: document.title, frame: null };
  views.set(rootKey, rootView);
  let active = rootView, sequence = 0, closed = false, publishedTitle = document.title;
  const initialState = readState(history.state);
  let position = initialState?.position || 0;
  // Keep the URL unchanged: native MCP/Network ports require their exact page
  // URL. Browser history uses only local state, never a relaxed sender check.
  history.replaceState(initialState || { moduleEngineSection: rootKey, position, anchor: '' }, '');
  function readState(state) {
    return state && Object.hasOwn(paths, state.moduleEngineSection) && Number.isSafeInteger(state.position) && state.position >= 0 &&
      typeof state.anchor === 'string' && (!state.anchor || /^#[A-Za-z][\w-]*$/.test(state.anchor)) ? state : null;
  }
  function route(href) {
    let url; try { url = new URL(href, location.href); } catch { return null; }
    const anchor = url.hash; url.hash = '';
    const key = urls.get(url.href);
    return key && (!anchor || /^#[A-Za-z][\w-]*$/.test(anchor)) ? { key, anchor } : null;
  }
  function publishTitle() {
    publishedTitle = active.title; if (document.title !== publishedTitle) document.title = publishedTitle;
  }
  function indicators() {
    const mcp = views.get('mcp')?.document, connected = Boolean(mcp?.getElementById('connectionBadge')?.classList.contains('active'));
    const pending = mcp?.querySelectorAll('#proposals > .proposal').length || 0;
    for (const view of views.values()) if (view.document) {
      for (const link of view.document.querySelectorAll('.rail-pages a')) {
        if (route(link.href)?.key !== 'mcp') continue;
        let label = link.querySelector('.me-nav-status');
        if (!label) { label = view.document.createElement('span'); label.className = 'me-nav-status'; link.append(label); }
        label.hidden = !connected;
        label.textContent = connected ? 'Connected' + (pending ? ' · ' + pending : '') : '';
        label.setAttribute('aria-label', 'MCP connected' + (pending ? '; ' + pending + ' changes waiting for review' : ''));
      }
    }
  }
  function bind(view) {
    const doc = view.document;
    doc.documentElement.dataset.meSectionActive = String(view === active);
    doc.addEventListener('click', event => {
      const link = event.target.closest?.('a[href]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.hasAttribute('download')) return;
      const destination = route(link.href);
      if (!destination) {
        // Ordinary links leave the whole tab, not an embedded privileged view.
        if (view.frame && (!link.target || link.target === '_self')) link.target = '_top';
        return;
      }
      event.preventDefault(); void show(destination, true);
    });
    const titleObserver = new MutationObserver(() => {
      if (view === rootView && document.title === publishedTitle) return;
      view.title = doc.title; publishTitle();
    });
    titleObserver.observe(doc.querySelector('title'), { childList: true, subtree: true, characterData: true });
    view.observers = [titleObserver];
    if (view.key === 'mcp') {
      const stateObserver = new MutationObserver(indicators);
      stateObserver.observe(doc.getElementById('connectionBadge'), { childList: true, attributes: true, subtree: true });
      stateObserver.observe(doc.getElementById('proposals'), { childList: true });
      view.observers.push(stateObserver);
    }
    indicators();
  }
  function load(key) {
    const existing = views.get(key); if (existing) return existing.ready || Promise.resolve(existing);
    const frame = document.createElement('iframe'), view = { key, frame, document: null };
    frame.className = 'me-section-frame'; frame.dataset.meSection = key; frame.title = { manager: 'Modules & scripts', lists: 'My lists', log: 'Activity log', network: 'Network', mcp: 'MCP', appearance: 'Appearance' }[key];
    frame.hidden = true; frame.inert = true; views.set(key, view);
    view.ready = new Promise((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled || views.get(key) !== view) return;
        settled = true;
        for (const observer of view.observers || []) observer.disconnect();
        clearTimeout(view.timer); frame.remove(); views.delete(key);
        reject(new Error('Could not open ' + frame.title + '. Try the section again.'));
      };
      view.cancel = fail;
      view.timer = setTimeout(fail, 20000);
      frame.addEventListener('error', fail, { once: true });
      frame.addEventListener('load', () => {
        if (closed || views.get(key) !== view) return;
        try {
          if (frame.contentWindow.location.href !== api.runtime.getURL(paths[key])) { fail(); return; }
          view.document = frame.contentDocument; view.title = view.document.title; bind(view);
          clearTimeout(view.timer); view.cancel = null; settled = true; resolve(view);
        } catch { fail(); }
      }, { once: true });
      frame.src = api.runtime.getURL(paths[key]); document.body.append(frame);
    });
    return view.ready;
  }
  function modalOpen() { return Boolean(active.document.querySelector('dialog[open]')); }
  async function show(destination, record, targetPosition = position) {
    if (closed || modalOpen()) return false;
    const request = ++sequence;
    let view;
    try { view = await load(destination.key); }
    catch (error) {
      if (request !== sequence || closed) return false;
      let notice = active.document.getElementById('sectionNavigationError');
      if (!notice) { notice = active.document.createElement('p'); notice.id = 'sectionNavigationError'; notice.className = 'notice error'; notice.setAttribute('role', 'alert'); active.document.querySelector('main').prepend(notice); }
      notice.textContent = error.message; return false;
    }
    if (closed || request !== sequence || modalOpen()) return false;
    active.scroll = { x: active.document.defaultView.scrollX, y: active.document.defaultView.scrollY };
    active.document.documentElement.dataset.meSectionActive = 'false';
    active.document.dispatchEvent(new Event('module-engine-section-change', { bubbles: true }));
    active = view;
    document.body.classList.toggle('me-section-away', view !== rootView);
    document.documentElement.classList.toggle('me-section-away', view !== rootView);
    document.querySelector('.shell').inert = view !== rootView;
    for (const entry of views.values()) if (entry.frame) { entry.frame.hidden = entry !== view; entry.frame.inert = entry !== view; }
    view.document.documentElement.dataset.meSectionActive = 'true';
    view.document.dispatchEvent(new Event('module-engine-section-change', { bubbles: true }));
    publishTitle();
    view.document.defaultView.scrollTo(view.scroll?.x || 0, view.scroll?.y || 0);
    const heading = destination.anchor ? view.document.getElementById(destination.anchor.slice(1)) : view.document.querySelector('h1');
    if (heading) { if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1; if (destination.anchor) heading.scrollIntoView(); heading.focus({ preventScroll: !destination.anchor }); }
    if (record) {
      const previous = readState(history.state);
      if (previous?.moduleEngineSection !== destination.key || previous.anchor !== destination.anchor) {
        position++; history.pushState({ moduleEngineSection: destination.key, anchor: destination.anchor, position }, '');
      }
    } else position = targetPosition;
    return true;
  }
  addEventListener('popstate', event => {
    const state = readState(event.state); if (!state) return;
    if (modalOpen()) { if (position !== state.position) history.go(position - state.position); return; }
    const previousPosition = position;
    void show({ key: state.moduleEngineSection, anchor: state.anchor }, false, state.position).then(shown => {
      if (!shown && !closed && position === previousPosition && readState(history.state)?.position === state.position && position !== state.position)
        history.go(position - state.position);
    });
  });
  addEventListener('pagehide', event => {
    if (!event.isTrusted) return;
    closed = true; sequence++;
    for (const view of views.values()) {
      clearTimeout(view.timer); view.cancel?.();
      if (!event.persisted) for (const observer of view.observers || []) observer.disconnect();
    }
    // The browser unloads the child documents and disconnects their native ports.
  });
  addEventListener('pageshow', event => { if (event.isTrusted && event.persisted) { closed = false; publishTitle(); indicators(); } });
  bind(rootView);
  if (initialState && initialState.moduleEngineSection !== rootKey) void show({ key: initialState.moduleEngineSection, anchor: initialState.anchor }, false, position);
})();
