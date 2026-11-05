/* Module Engine: pop-up blocker for sites the person selected (page world).
 * background.js registers this file on matching pages and injects it into their
 * cross-origin child frames. It refuses windows opened by script, synthetic
 * clicks on links to other hosts, and clicks on disguised links (invisible or
 * page-covering overlays) to other hosts. Ordinary visible links still work.
 */
(() => {
  "use strict";
  const patched = new WeakSet();

  // Without a bundled public-suffix list, only an exact host and its parents or
  // children share a trusted scope. Independent sibling tenants on github.io,
  // pages.dev and similar platforms must remain separate.
  const cleanHost = host => String(host).toLowerCase().replace(/\.$/, "");
  const within = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  const sameSite = (left, right) => {
    const first = cleanHost(left);
    const second = cleanHost(right);
    return Boolean(first && second && (within(first, second) || within(second, first)));
  };
  function otherSite(href) {
    try {
      const url = new URL(href, location.href);
      return /^https?:$/.test(url.protocol) && !sameSite(url.hostname, location.hostname);
    } catch {
      return false;
    }
  }

  function blockOpen(win) {
    try {
      if (!win || patched.has(win) || typeof win.open !== "function") return;
      win.open = new Proxy(win.open, { apply: () => null });
      patched.add(win);
    } catch {
      // Inaccessible window-like objects are ignored. Cross-origin frames receive
      // their own copy from the extension background.
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
    if (self instanceof HTMLAnchorElement && otherSite(self.href)) return undefined;
    return Reflect.apply(target, self, args);
  } });
  EventTarget.prototype.dispatchEvent = new Proxy(EventTarget.prototype.dispatchEvent, { apply(target, self, args) {
    const event = args[0];
    if (self instanceof HTMLAnchorElement && event?.type === "click" && otherSite(self.href)) return false;
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
    }
  }, true);
})();
