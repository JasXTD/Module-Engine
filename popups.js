/* Module Engine: pop-up and redirect guard for selected sites (page world).
 * background.js registers this file on matching pages and injects it into their
 * cross-origin child frames. It refuses windows opened by script, synthetic
 * clicks on links to other hosts, and clicks on disguised links (invisible or
 * page-covering overlays) to other hosts. The top page also cancels script-made
 * document replacements, including same-host requests that could redirect at
 * the server. A companion response sandbox prevents frame takeovers. Ordinary
 * links and native form submissions still work. Page hooks can be tampered with.
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
  let linkIntent = null;
  window.addEventListener("click", event => {
    // A composed path also finds links inside open shadow roots. Remember the
    // href before page handlers can replace it with an unrelated destination.
    const anchor = event.composedPath().find(node =>
      (node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement) && node.hasAttribute("href"));
    const intent = event.isTrusted && anchor && !disguised(anchor) ? { anchor, href: anchor.href } : null;
    linkIntent = intent;
    if (intent) setTimeout(() => {
      // Permit a link's synchronous custom handler, never a later unrelated
      // redirect that happens to follow the click. A newer click owns its intent.
      if (linkIntent === intent) linkIntent = null;
    }, 0);
    if (!anchor || !otherSite(anchor.href)) return;
    if (!event.isTrusted || disguised(anchor)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  if (window === window.top && window.navigation) {
    window.navigation.addEventListener("navigate", event => {
      // Unlike Location's unforgeable setters, this browser event can cancel a
      // navigation before a request. Do not use canIntercept: it is false for
      // cross-origin URLs even when cancellation is allowed. Block the first
      // scripted document request, since its server's redirect target cannot be
      // known in advance. Same-document player routing, media requests, browser
      // history and iframe-local navigation stay intact. The response sandbox
      // separately stops frames whose top navigation does not fire this event.
      if (!event.isTrusted || !event.cancelable || event.navigationType === "traverse" ||
          (event.navigationType === "reload" && event.userInitiated) ||
          event.destination.sameDocument || !/^https?:/.test(event.destination.url)) return;
      if (linkIntent?.href === event.destination.url) return;
      const source = event.sourceElement;
      if (event.userInitiated) {
        // sourceElement arrived in Chromium 135; the manifest also supports
        // older engines. Their native action flag still distinguishes a real
        // form submission from script-only navigation. Keep an observed link's
        // exact-destination check even without that newer event property.
        if (!("sourceElement" in event) && !linkIntent) return;
        if ((source instanceof HTMLAnchorElement || source instanceof HTMLAreaElement) &&
            !disguised(source) && (linkIntent?.anchor === source ? linkIntent.href : source.href) === event.destination.url) return;
        if (source instanceof HTMLFormElement ||
            ((source instanceof HTMLButtonElement || source instanceof HTMLInputElement) && source.form)) return;
      }
      event.preventDefault();
    });
  }
})();
