/* Reddit app-promotion repair. Runs in the extension's isolated content world. */
(() => {
  'use strict';
  const isReddit = hostname => /(^|\.)reddit\.com$/i.test(String(hostname).replace(/\.$/, ''));
  const title = /^(get the best of reddit in the app|get the reddit app|reddit is better in the app)$/i;
  const action = /^(get (the )?reddit app|open( in)? (the )?(reddit )?app|continue in (the )?app)$/i;
  const protectedContent = 'main,[role="main"],article,shreddit-post,shreddit-comment,form,textarea,[contenteditable="true"]';
  const modalSelector = 'dialog[open],[role="dialog"],[aria-modal="true"],[popover]';
  const text = element => (element.textContent || '').slice(0, 4000).replace(/\s+/g, ' ').trim();
  const parentOf = element => element.parentElement || element.getRootNode().host;

  function create({ document: doc, hostname = doc.location.hostname, isAlive = () => true, onProblem = () => {} }) {
    // Do not allocate observers or inspect the DOM on other sites.
    if (!isReddit(hostname)) return Object.freeze({ setEnabled() {}, clear() {} });
    const win = doc.defaultView;
    const marker = 'data-module-engine-reddit-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
    const hidden = new Map(), styles = new Map(), inert = new Map(), sheets = new Map();
    let enabled = false, timer = null, failed = false, watchedRoots = [doc];
    const css = `[${marker}] { display: none !important; pointer-events: none !important; }`;
    const observer = new MutationObserver(() => schedule());
    const observe = () => {
      for (const root of watchedRoots) observer.observe(root, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['style', 'class', 'inert', 'open', 'hidden', 'popover', 'aria-modal', 'role', marker] });
    };
    const visible = element => {
      const style = win.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    };
    const contains = (outer, inner) => {
      for (let node = inner; node; node = parentOf(node)) if (node === outer) return true;
      return false;
    };
    const safe = element => element !== doc.documentElement && element !== doc.body && element !== doc.head &&
      !element.matches(protectedContent) && !element.querySelector(protectedContent);

    function scopes() {
      // Include open component roots without hooking attachShadow or page APIs.
      // Stop on unusually large documents instead of creating an unbounded scan.
      const result = [doc];
      let count = 0;
      for (let index = 0; index < result.length; index++) {
        const walker = doc.createTreeWalker(result[index], 1);
        let element;
        while ((element = walker.nextNode())) {
          if (++count > 20000) throw new Error('Reddit popup scan limit reached');
          if (element.shadowRoot) {
            if (result.length >= 64) throw new Error('Reddit popup root limit reached');
            result.push(element.shadowRoot);
          }
        }
      }
      return result;
    }

    function popupFor(anchor) {
      if (!title.test(text(anchor))) return null;
      let result = null;
      for (let node = anchor, depth = 0; node && depth < 10; node = parentOf(node), depth++) {
        if (!safe(node)) break;
        const scope = node.shadowRoot || node;
        if (![...scope.querySelectorAll('a,button,[role="button"]')].some(button => action.test(text(button)))) continue;
        const style = win.getComputedStyle(node), box = node.getBoundingClientRect();
        const overlay = node.matches('dialog,[role="dialog"],[popover]') || style.position === 'fixed' &&
          box.width >= win.innerWidth * 0.4 && box.height >= Math.min(200, win.innerHeight * 0.25);
        if (overlay && (visible(node) || hidden.has(node))) result = node;
      }
      return result;
    }

    function hide(element, owner = null) {
      let record = hidden.get(element);
      if (!record && hidden.size >= 64) throw new Error('Reddit popup element limit reached');
      if (!record) record = { modal: element.matches('dialog:modal'), open: element.localName === 'dialog' && element.open,
        popover: element.matches(':popover-open'), owner };
      // display:none alone leaves a modal dialog's native inertness active.
      if (element.localName === 'dialog' && element.open) element.close();
      if (element.matches(':popover-open')) element.hidePopover();
      const root = element.getRootNode();
      let sheet = sheets.get(root);
      if (!sheet?.isConnected) {
        sheet = doc.createElement('style'); sheet.textContent = css;
        (root === doc ? doc.head || doc.documentElement : root).append(sheet);
        sheets.set(root, sheet);
      }
      if (sheet.textContent !== css) sheet.textContent = css;
      element.setAttribute(marker, '');
      hidden.set(element, record);
    }

    function restoreHidden(element, record) {
      element.removeAttribute(marker);
      if (!element.isConnected) return;
      if (record.open && !element.open) {
        if (record.modal) element.showModal();
        else element.show();
      }
      if (record.popover && element.hasAttribute('popover') && !element.matches(':popover-open')) element.showPopover();
    }

    function setStyle(element, property, value) {
      let properties = styles.get(element);
      if (!properties) styles.set(element, properties = new Map());
      const saved = properties.get(property);
      const current = element.style.getPropertyValue(property), priority = element.style.getPropertyPriority(property);
      // A page edit after our last write becomes the new value to restore.
      if (!saved || current !== saved.value || priority !== 'important') properties.set(property, { before: current, priority, value });
      element.style.setProperty(property, value, 'important');
    }

    function restoreLocks(detached = false) {
      for (const [element, properties] of styles) {
        for (const [property, saved] of properties) {
          const owned = element.style.getPropertyValue(property) === saved.value && element.style.getPropertyPriority(property) === 'important';
          if (owned) {
            // Once the app prompt is removed, do not reinstall its orphaned lock.
            if (detached) element.style.removeProperty(property);
            else if (saved.before) element.style.setProperty(property, saved.before, saved.priority);
            else element.style.removeProperty(property);
          }
          const computed = detached && owned && element.isConnected ? win.getComputedStyle(element).getPropertyValue(property) : '';
          const classLock = property.startsWith('overflow-') ? /^(hidden|clip)$/.test(computed) :
            property === 'position' ? computed === 'fixed' : ['pointer-events', 'touch-action'].includes(property) && computed === 'none';
          if (classLock) {
            // A leftover class can still lock the page after the prompt leaves.
            // Keep our override until that class changes, another modal opens,
            // or page hiding is paused; never remove the page's own classes.
            element.style.setProperty(property, saved.value, 'important');
            saved.before = ''; saved.priority = '';
          } else properties.delete(property);
        }
        if (!properties.size) styles.delete(element);
      }
      for (const [element, value] of inert) if (!element.hasAttribute('inert') && !detached) element.setAttribute('inert', value);
      inert.clear();
    }

    function unlock(roots) {
      for (const element of [doc.documentElement, doc.body].filter(Boolean)) {
        const style = win.getComputedStyle(element);
        for (const axis of ['x', 'y']) if (/^(hidden|clip)$/.test(style.getPropertyValue('overflow-' + axis))) setStyle(element, 'overflow-' + axis, 'auto');
        if (style.pointerEvents === 'none') setStyle(element, 'pointer-events', 'auto');
        if (style.touchAction === 'none') setStyle(element, 'touch-action', 'auto');
        if (style.position === 'fixed') {
          const offset = /^-\d+(\.\d+)?px$/.test(style.top) ? -parseFloat(style.top) : win.scrollY;
          setStyle(element, 'position', 'static');
          setStyle(element, 'top', 'auto');
          win.scrollTo(win.scrollX, offset);
        }
      }
      // Only document roots and the main content's ancestors, never arbitrary
      // inert widgets. Some layouts have no semantic main element.
      const contentRoots = new Set([doc.documentElement, doc.body].filter(Boolean));
      for (const scope of roots) for (const main of scope.querySelectorAll('main,[role="main"]')) {
        for (let node = main; node; node = parentOf(node)) contentRoots.add(node);
      }
      for (const node of contentRoots) if (node.hasAttribute('inert')) { inert.set(node, node.getAttribute('inert')); node.removeAttribute('inert'); }
    }

    function scan() {
      timer = null;
      if (!enabled || failed) return;
      if (!isAlive()) { clear(); return; }
      observer.disconnect();
      try {
        const roots = scopes(), desired = new Set();
        watchedRoots = roots;
        for (const [element, properties] of styles) if (!element.isConnected) {
          for (const [property, saved] of properties) if (element.style.getPropertyValue(property) === saved.value && element.style.getPropertyPriority(property) === 'important') {
            if (saved.before) element.style.setProperty(property, saved.before, saved.priority);
            else element.style.removeProperty(property);
          }
          styles.delete(element);
        }
        for (const [element, value] of inert) if (!element.isConnected) {
          if (!element.hasAttribute('inert')) element.setAttribute('inert', value);
          inert.delete(element);
        }
        for (const [root, sheet] of sheets) if (root !== doc && !root.host.isConnected) { sheet.remove(); sheets.delete(root); }
        let matches = 0;
        for (const scope of roots) for (const heading of scope.querySelectorAll('h1,h2,h3,[role="heading"]')) {
          if (!title.test(text(heading))) continue;
          if (++matches > 16) throw new Error('Reddit popup candidate limit reached');
          const popup = popupFor(heading);
          if (popup) desired.add(popup);
        }
        // A closed modal has no rectangle after our first pass. Retain it only
        // while it still contains the app heading and action (not a reused dialog).
        for (const element of hidden.keys()) if (element.isConnected && safe(element) &&
          [...(element.shadowRoot || element).querySelectorAll('h1,h2,h3,[role="heading"]')].some(heading => title.test(text(heading))) &&
          [...(element.shadowRoot || element).querySelectorAll('a,button,[role="button"]')].some(button => action.test(text(button)))) desired.add(element);
        const otherModal = roots.some(scope => [...scope.querySelectorAll(modalSelector)].some(element =>
          ![...desired].some(popup => contains(popup, element)) && visible(element) &&
          (element.matches(':modal,:popover-open,[role="dialog"]') || element.getAttribute('aria-modal') === 'true')));
        // A separate adjacent scrim must be empty, explicitly decorative and
        // cover the viewport. Never sweep up generic overlays elsewhere.
        if (!otherModal) for (const popup of [...desired]) for (const sibling of [popup.previousElementSibling, popup.nextElementSibling]) {
          if (!sibling || sibling.getAttribute('aria-hidden') !== 'true' || text(sibling) || sibling.children.length) continue;
          const box = sibling.getBoundingClientRect();
          if (win.getComputedStyle(sibling).position === 'fixed' && box.width >= win.innerWidth * 0.9 && box.height >= win.innerHeight * 0.9) {
            hide(sibling, popup); desired.add(sibling);
          }
        }
        for (const [element, record] of hidden) if (record.owner && desired.has(record.owner) && element.isConnected && !otherModal &&
          element.getAttribute('aria-hidden') === 'true' && !text(element) && !element.children.length) desired.add(element);
        for (const element of hidden.keys()) if (!desired.has(element)) {
          // Reused dialogs belong to the page again; do not reopen old contents.
          element.removeAttribute(marker); hidden.delete(element);
        }
        if (!desired.size) {
          restoreLocks(!otherModal);
          for (const sheet of sheets.values()) sheet.remove();
          sheets.clear(); return;
        }
        for (const popup of desired) {
          // Close a nested native modal as well as hiding its fixed wrapper.
          for (const scope of roots) for (const dialog of scope.querySelectorAll('dialog[open],[popover]')) {
            if (contains(popup, dialog) && dialog !== popup) hide(dialog);
          }
          hide(popup);
        }
        if (otherModal) restoreLocks();
        else unlock(roots);
      } catch (error) {
        clear(); failed = true; onProblem(error);
      } finally { if (enabled && !failed) observe(); }
    }

    function schedule() {
      // One scan per mutation burst; no page polling or synthetic input events.
      if (enabled && !failed && timer === null) timer = setTimeout(scan, 50);
    }
    function clear() {
      enabled = false;
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      restoreLocks();
      for (const sheet of sheets.values()) sheet.remove();
      sheets.clear();
      for (const [element, record] of hidden) restoreHidden(element, record);
      hidden.clear();
      watchedRoots = [doc];
    }
    function setEnabled(value) {
      if (!value) { clear(); failed = false; return; }
      if (enabled || failed) return;
      enabled = true;
      scan();
    }
    return Object.freeze({ setEnabled, clear });
  }
  globalThis.BlockAdsReddit = Object.freeze({ create, isReddit });
})();
