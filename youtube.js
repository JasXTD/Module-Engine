/* Module Engine: YouTube player-response filter (page world).
 * YouTube serves video ads from the same hosts as the video itself, so network
 * rules cannot separate them. The player instead reads an ad schedule from its
 * player response; this removes that schedule before the player sees it.
 * background.js registers this file only while the ad layer is on and YouTube
 * is not paused. It has no extension API access and sends nothing anywhere.
 */
(() => {
  "use strict";
  const AD_KEYS = ["adPlacements", "adSlots", "playerAds"];

  function strip(object) {
    if (!object || typeof object !== "object") return;
    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(object, key)) delete object[key];
    }
  }

  // Player data arrives bare, wrapped in { playerResponse }, or as a short array
  // of such parts. Only those shapes are inspected, never a full deep walk.
  function prune(value) {
    try {
      const parts = Array.isArray(value) ? (value.length <= 10 ? value : []) : [value];
      for (const part of parts) {
        if (!part || typeof part !== "object") continue;
        strip(part);
        strip(part.playerResponse);
      }
    } catch {
      // A filter failure must never break the page's own parsing.
    }
    return value;
  }

  function wrap(owner, name, after) {
    const original = owner?.[name];
    if (typeof original !== "function") return;
    owner[name] = new Proxy(original, {
      apply: (target, self, args) => after(Reflect.apply(target, self, args))
    });
  }

  // Initial page load: `var ytInitialPlayerResponse = {...}` assigns through this setter.
  let initialResponse;
  try {
    Object.defineProperty(window, "ytInitialPlayerResponse", {
      configurable: true,
      enumerable: true,
      get: () => initialResponse,
      set: value => { initialResponse = prune(value); }
    });
  } catch {
    // Already defined by the page; the parse hooks below still apply.
  }

  // In-page navigation: /youtubei/v1/player responses via fetch or text + JSON.parse.
  wrap(JSON, "parse", prune);
  if (typeof Response === "function") wrap(Response.prototype, "json", result => result.then(prune));
})();
