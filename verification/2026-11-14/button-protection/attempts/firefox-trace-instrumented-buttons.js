/* Conservative, local protection for deceptive play/download controls. */
(() => {
  'use strict';

  const ACTION = 'a[href],button,[role="button"],input[type="button"],input[type="submit"],[onclick]';
  const BOUNDARY = 'html,body,main,article,nav,header,footer,form';
  const AD_MARK = /^(?:ad|advertisement|sponsored)$/i;
  const AD_TOKEN = /(?:^|\s)(?:ad-slot|ad-container|advertisement|sponsored-ad)(?:\s|$)/i;
  const INSTALLER = /\.(?:exe|msi|msix|msixbundle|appx|appxbundle|dmg|pkg|apk|crx|xpi|scr|bat|cmd|ps1|vbs|jar)$/i;
  const MESSAGES = Object.freeze({
    'ad-button': 'Module Engine blocked a play/download action inside an ad placement.',
    'player-overlay': 'Module Engine blocked an outside link covering the video player.',
    'play-installer': 'Module Engine blocked a Play button linking to an installer or script.'
  });

  function actionKind(label) {
    if (typeof label !== 'string' || label.length > 160) return '';
    const text = label.replace(/[\uFE0E\uFE0F]/g, '').replace(/\s+/g, ' ').trim();
    if (/^[▶►⏵]$/.test(text) || /^(?:click to )?(?:play(?: video| movie| now)?|watch (?:video|movie|now)|start video)[.!]?$/i.test(text)) return 'play';
    if (/^(?:(?:click to |start |free )?download)(?:$|[ !.:]| for\b)/i.test(text)) return 'download';
    return '';
  }

  function installerDestination(href, base, filename = '') {
    if (typeof href !== 'string' || href.length > 4096 || typeof filename !== 'string' || filename.length > 256) return false;
    let url;
    try { url = new URL(href, base); } catch { return false; }
    if (!['http:', 'https:', 'blob:', 'data:'].includes(url.protocol)) return false;
    if (INSTALLER.test(filename.trim())) return true;
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    let name = url.pathname.split('/').at(-1);
    try { name = decodeURIComponent(name); } catch { return false; }
    return INSTALLER.test(name.trim());
  }

  function reasonFor({ kind, ad, external, overPlayer, installer }) {
    if (kind && ad) return 'ad-button';
    if (external && overPlayer) return 'player-overlay';
    if (kind === 'play' && installer) return 'play-installer';
    return '';
  }

  // Never read a whole page's text for a clicked control or nearby ad label.
  function shortText(node, limit = 160) {
    const walker = node.ownerDocument.createTreeWalker(node, 5);
    let result = '', next, count = 0;
    while ((next = walker.nextNode())) {
      if (++count > 64) return '';
      if (next.nodeType !== 3) continue;
      if (next.textContent.length + result.length > limit) return '';
      if (!next.parentElement?.closest('script,style,noscript')) result += ` ${next.textContent}`;
    }
    return result.trim();
  }

  function create({ document: doc, isAlive = () => true, onProblem = () => {} }) {
    const win = doc.defaultView;
    let enabled = false, failed = false, notice = null, noticeText = null, noticeTimer = null;

    function clearNotice() {
      if (noticeTimer !== null) win.clearTimeout(noticeTimer);
      noticeTimer = null;
      notice?.remove();
      notice = noticeText = null;
    }

    function clear() { enabled = false; clearNotice(); }

    function showNotice(reason) {
      if (!doc.documentElement) return;
      if (!notice?.isConnected) {
        clearNotice();
        notice = doc.createElement('div');
        notice.setAttribute('data-module-engine-button-notice', '');
        // No click capture, modal, focus move, scroll lock or destination replay.
        notice.style.cssText = 'all:initial!important;position:fixed!important;inset:auto 16px 16px auto!important;z-index:2147483647!important;pointer-events:none!important;max-width:calc(100vw - 32px)!important;display:block!important';
        const shadow = notice.attachShadow({ mode: 'closed' });
        const style = doc.createElement('style');
        style.textContent = ':host{color-scheme:dark}p{box-sizing:border-box;margin:0;max-width:400px;padding:14px 16px;border:1px solid #bde55b;border-radius:12px;background:#172023;color:#f2f4ed;box-shadow:0 4px 20px #0005;font:14px/1.5 system-ui;overflow-wrap:anywhere}';
        noticeText = doc.createElement('p');
        noticeText.setAttribute('role', 'status');
        noticeText.setAttribute('aria-live', 'polite');
        shadow.append(style, noticeText);
        doc.documentElement.append(notice);
      }
      const text = `${MESSAGES[reason]} You can allow it using “Prompt & button protection” for this site in the extension.`;
      if (noticeText.textContent !== text) noticeText.textContent = text;
      notice.setAttribute('data-module-engine-button-notice', reason);
      if (noticeTimer !== null) win.clearTimeout(noticeTimer);
      noticeTimer = win.setTimeout(clearNotice, 6000);
    }

    function kindOf(action) {
      for (const value of [action.getAttribute('aria-label'), action.getAttribute('title'),
        action.matches('input') ? action.value : null, shortText(action)]) {
        const kind = actionKind(value);
        if (kind) return kind;
      }
      // Image-only buttons are common; inspect only a few direct children.
      for (let index = 0; index < Math.min(action.children.length, 8); index++) {
        const child = action.children[index];
        const kind = actionKind(child.getAttribute('alt'));
        if (kind) return kind;
      }
      return '';
    }

    function inAdPlacement(action) {
      let node = action;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        if (node.matches(BOUNDARY) || node.isContentEditable) break;
        if (node.matches('ins.adsbygoogle,[data-ad-slot],[data-ad-client],[data-ad-unit],[data-ad-container]') ||
            AD_MARK.test(node.getAttribute('aria-label') || '') ||
            AD_TOKEN.test(`${node.id.slice(0, 256)} ${(node.getAttribute('class') || '').slice(0, 256)}`)) return true;
        if (node !== action && node.childElementCount <= 16) {
          for (const label of node.children) {
            if (label === action || label.contains(action) || label.childElementCount > 2 || !AD_MARK.test(shortText(label, 32))) continue;
            const box = label.getBoundingClientRect(), style = win.getComputedStyle(label);
            if (box.width > 0 && box.height > 0 && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) > 0) return true;
          }
        }
      }
      return false;
    }

    function overPlayer(action, event) {
      const box = action.getBoundingClientRect();
      const keyboard = event.type.startsWith('key') || event.type === 'click' && event.detail === 0;
      const touch = event.changedTouches?.[0];
      const x = keyboard ? box.x + box.width / 2 : touch?.clientX ?? event.clientX;
      const y = keyboard ? box.y + box.height / 2 : touch?.clientY ?? event.clientY;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      for (const root of new Set([action.getRootNode(), doc])) {
        for (const node of (root.elementsFromPoint?.(x, y) || []).slice(0, 24)) {
          if (node.localName !== 'video' || action.contains(node)) continue;
          const rect = node.getBoundingClientRect();
          if (rect.width >= 80 && rect.height >= 45) return true;
        }
      }
      return false;
    }

    function reasonAt(event) {
      const path = event.composedPath().slice(0, 32);
      if (path.some(node => node.nodeType === 1 && node.isContentEditable)) return '';
      const action = path.find(node => node.nodeType === 1 && node.matches(ACTION));
      if (!action || action.disabled) return '';
      const kind = kindOf(action);
      const link = path.find(node => node.nodeType === 1 && node.matches('a[href]'));
      let external = false, installer = false;
      if (link) {
        const href = link.getAttribute('href');
        if (href.length <= 4096) {
          let url;
          try { url = new URL(href, doc.baseURI); } catch { /* Invalid link has no destination signal. */ }
          external = Boolean(url && ['http:', 'https:'].includes(url.protocol) && !BlockAds.sameSite(url.hostname, doc.location.hostname));
          if (kind === 'play') installer = installerDestination(href, doc.baseURI, link.getAttribute('download') || '');
        }
      }
      return reasonFor({ kind, ad: Boolean(kind && inAdPlacement(action)), external,
        overPlayer: external && overPlayer(action, event), installer });
    }

    function intercept(event) {
      if (!enabled) return;
      try {
        if (!isAlive()) { clear(); return; }
        if (event.type.startsWith('key') && !['Enter', ' ', 'Spacebar'].includes(event.key)) return;
        if ('button' in event && event.button !== 0 && event.button !== 1) return;
        const reason = reasonAt(event);
        const trace = stage => doc.dispatchEvent(new win.CustomEvent('__buttonTrace',{detail:JSON.stringify({stage,type:event.type,detail:event.detail,button:event.button,cancelable:event.cancelable,prevented:event.defaultPrevented,x:event.clientX,y:event.clientY,reason,
          path:event.composedPath().slice(0,8).map(node=>node.id||node.localName||node.nodeName),stack:Number.isFinite(event.clientX)?doc.elementsFromPoint(event.clientX,event.clientY).slice(0,12).map(node=>node.id||node.localName):[]})}));
        trace('before');
        if (!reason) return;
        event.stopImmediatePropagation();
        // Touch can still pan the page; the eventual activation is cancelled.
        if (!event.type.startsWith('touch') && event.cancelable) event.preventDefault();
        trace('after'); if (event.isTrusted) showNotice(reason);
      } catch (error) {
        failed = true;
        clear();
        onProblem(error);
      }
    }

    // Register synchronously at document_start, ahead of ordinary page handlers.
    // Keep the cheap disabled listeners for this document's lifetime so toggling
    // protection back on cannot move us behind those handlers. No DOM observer.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick', 'keydown', 'keyup', 'touchstart', 'touchend']) {
      win.addEventListener(type, intercept, { capture: true, passive: false });
    }
    return Object.freeze({ setEnabled(value) { enabled = value === true && !failed; if (!enabled) clearNotice(); }, clear });
  }

  globalThis.BlockAdsButtons = Object.freeze({ create, actionKind, installerDestination, reasonFor });
})();
