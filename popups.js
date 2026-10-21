/* BlockAds Shield: pop-up blocker for sites the person selected (page world).
 * background.js registers this file only for those sites. It refuses windows
 * opened by script, synthetic clicks on links to other sites, and clicks on
 * disguised links (invisible or page-covering overlays) to other sites.
 * Ordinary visible links still work. Each block is reported to the isolated
 * content script as a hostname only; nothing leaves the browser.
 */
(() => {
  "use strict";
  const patched = new WeakSet();

  function report(url) {
    let host = "";
    try { host = new URL(String(url ?? ""), location.href).hostname; } catch {}
    try { document.dispatchEvent(new CustomEvent("blockads-popup-blocked", { detail: host })); } catch {}
  }

  // Same site: the registrable name, approximated without a public suffix list.
  // Two-part suffixes such as com.tw, com.cn, co.uk need a third label.
  const siteOf = host => {
    const labels = host.split(".");
    const twoPart = labels.length > 2 && /^(com|net|org|edu|gov|co|ac|or|ne|go|gob|mil|idv)$/.test(labels.at(-2)) && labels.at(-1).length === 2;
    return labels.slice(twoPart ? -3 : -2).join(".");
  };
  function otherSite(href) {
    try {
      const url = new URL(href, location.href);
      return /^https?:$/.test(url.protocol) && siteOf(url.hostname) !== siteOf(location.hostname);
    } catch {
      return false;
    }
  }

  function blockOpen(win) {
    try {
      if (!win || patched.has(win) || typeof win.open !== "function") return;
      win.open = new Proxy(win.open, { apply: (_target, _self, args) => { report(args[0]); return null; } });
      patched.add(win);
    } catch {
      // Cross-origin frames cannot be patched (or used by this page's scripts).
    }
  }
  blockOpen(window);

  // Ad scripts often take a fresh window.open from a new same-origin frame.
  for (const [proto, name, toWindow] of [
    [HTMLIFrameElement.prototype, "contentWindow", value => value],
    [HTMLIFrameElement.prototype, "contentDocument", value => value?.defaultView]
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor?.get) continue;
    Object.defineProperty(proto, name, { ...descriptor, get() {
      const value = descriptor.get.call(this);
      blockOpen(toWindow(value));
      return value;
    } });
  }

  // Script-made clicks on links to another site (link.click() or dispatchEvent).
  HTMLElement.prototype.click = new Proxy(HTMLElement.prototype.click, { apply(target, self, args) {
    if (self instanceof HTMLAnchorElement && otherSite(self.href)) { report(self.href); return undefined; }
    return Reflect.apply(target, self, args);
  } });
  EventTarget.prototype.dispatchEvent = new Proxy(EventTarget.prototype.dispatchEvent, { apply(target, self, args) {
    const event = args[0];
    if (self instanceof HTMLAnchorElement && event?.type === "click" && otherSite(self.href)) { report(self.href); return false; }
    return Reflect.apply(target, self, args);
  } });

  // Real clicks that land on a disguised link to another site: invisible, a
  // fixed overlay over much of the window, or an empty link covering most of it.
  // Absolutely positioned "stretched" card links stay usable.
  function disguised(anchor) {
    const style = getComputedStyle(anchor);
    const box = anchor.getBoundingClientRect();
    const share = box.width * box.height / (innerWidth * innerHeight);
    return Number(style.opacity) < 0.1 || style.visibility === "hidden" ||
      (share >= 0.3 && style.position === "fixed") ||
      (share >= 0.6 && !anchor.textContent.trim() && !anchor.querySelector("img, picture, video, svg, canvas"));
  }
  window.addEventListener("click", event => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || !otherSite(anchor.href)) return;
    if (!event.isTrusted || disguised(anchor)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      report(anchor.href);
    }
  }, true);
})();
