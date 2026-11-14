/* Module Engine: YouTube player-response filter (page world).
 * YouTube serves video ads from the same hosts as the video itself, so network
 * rules cannot separate them. The player instead reads an ad schedule from its
 * player response; this removes that schedule before the player sees it.
 * src/background/background.js registers this file only while the ad layer is on and YouTube
 * is not paused. It has no extension API access and sends nothing anywhere.
 */
(() => {
  "use strict";
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds"];

  const own = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
  function strip(object, player) {
    if (!player && !["videoDetails", "streamingData", "playabilityStatus"].some(key => {
      const value = own(object, key);
      return value && typeof value === "object";
    })) return false;
    let changed = false;
    for (const key of AD_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor?.configurable && Reflect.deleteProperty(object, key)) changed = true;
    }
    return changed;
  }

  // Inspect nested envelopes/batches with finite work, without invoking page
  // getters. Only identifiable player records lose the three known ad fields.
  function prune(value, player = false) {
    const queue = [{ value, depth: 0, player }], seen = new WeakSet();
    let properties = 0, changed = false;
    for (let index = 0; index < queue.length && index < 512; index++) {
      const item = queue[index], object = item.value;
      if (!object || typeof object !== "object" || seen.has(object)) continue;
      seen.add(object);
      try {
        changed = strip(object, item.player) || changed;
        if (item.depth >= 8) continue;
        for (const key of Object.keys(object)) {
          if (++properties > 4096 || queue.length >= 512) break;
          const child = own(object, key);
          if (child && typeof child === "object") queue.push({ value: child, depth: item.depth + 1, player: key === "playerResponse" });
        }
      } catch {
        // A frozen/revoked/page-defined branch must not break parsing or prevent
        // filtering independent writable player records in the same response.
      }
    }
    return changed;
  }
  function filter(value) {
    prune(value);
    return value;
  }

  function wrap(owner, name, after) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (typeof descriptor?.value !== "function") return;
      Object.defineProperty(owner, name, { ...descriptor, value: new Proxy(descriptor.value, {
        apply: (target, self, args) => after(Reflect.apply(target, self, args), self)
      }) });
    } catch { /* An independently locked hook does not disable the others. */ }
  }

  // Initial page load: `var ytInitialPlayerResponse = {...}` assigns through this setter.
  try {
    const descriptor = Object.getOwnPropertyDescriptor(window, "ytInitialPlayerResponse");
    let initialResponse = descriptor?.value;
    prune(initialResponse, true);
    // Preserve page accessors and read-only globals. Existing non-configurable
    // data is still cleaned in place, even though future assignments cannot hook.
    if (!descriptor || descriptor.configurable && descriptor.writable) {
      Object.defineProperty(window, "ytInitialPlayerResponse", {
        configurable: true, enumerable: descriptor?.enumerable ?? true,
        get: () => initialResponse,
        set: value => { prune(value, true); initialResponse = value; }
      });
    }
  } catch {
    // Already defined by the page; the parse hooks below still apply.
  }

  // In-page navigation: /youtubei/v1/player responses via fetch or text + JSON.parse.
  const parse = JSON.parse, stringify = JSON.stringify;
  wrap(JSON, "parse", filter);
  if (typeof Response === "function") {
    wrap(Response.prototype, "json", result => result.then(filter));
    // A player request read as text may use an earlier captured JSON.parse or a
    // reviver. Filter before returning that text, only on same-origin player APIs.
    wrap(Response.prototype, "text", (result, response) => result.then(text => {
      if (typeof text !== "string" || text.length > 4 * 1024 * 1024 || !AD_KEYS.some(key => text.includes('"' + key + '"'))) return text;
      try {
        const url = new URL(response.url);
        if (url.origin !== location.origin || !/^\/youtubei\/v\d+\/(?:player|next)$/.test(url.pathname)) return text;
        const data = parse(text);
        return prune(data) ? stringify(data) : text;
      } catch { return text; } // Non-JSON responses retain their original bytes.
    }));
  }
})();
