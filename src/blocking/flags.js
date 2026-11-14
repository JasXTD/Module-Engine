/* Module Engine: ad-pattern scoring for "flag, don't block".
 * Pure functions over a request that already loaded (Module Engine did not block it).
 * A flag only asks the person to decide later; it never blocks anything.
 * Requires src/shared/shared.js (BlockAds.sameSite and BlockAds.siteOf). */
(() => {
  "use strict";
  const { sameSite, siteOf } = globalThis.BlockAds;

  // Fixed reason codes; page-reported signals may only use the last two.
  const REASONS = Object.freeze({
    "ad-path": "Ad-like address (ads, banner, popunder, prebid, VAST)",
    "ad-query": "Ad placement settings in the address (zone, placement, campaign)",
    "tracker": "Impression or click tracker",
    "network-script": "Known ad-network script shape",
    "obfuscated": "Long random-looking script address",
    "throwaway-domain": "Throwaway-looking domain loading scripts or frames",
    "ad-size-frame": "Frame in a standard ad size from another site",
    "ad-label": "Next to an \"Ad\" or \"Sponsored\" label"
  });
  const PAGE_REASONS = new Set(["ad-size-frame", "ad-label"]);

  // Words between separators, so "uploads" or "admin" do not match.
  const AD_PATH = /(?:^|[/_.-])(?:ads?|adserver|adservice|adsystem|adframe|adunit|adslot|advert|adverts|advertising|banners?|popunders?|sponsored|prebid|pagead|vast|vpaid|preroll|adx)(?:[/_.?=-]|$)/;
  const AD_QUERY = /[?&](?:zoneid|zone_id|adzone|ad_zone|placementid|placement_id|adunit|ad_unit|campaignid|campaign_id|clickid|click_id|bannerid|creativeid)=/;
  const TRACKER = /\/(?:imp|impression|impressions|pixel|beacon|clk|click|clicks)(?:\.gif|\.png|\.php|\/|$)/;
  const NETWORK_SCRIPT = [/\/[0-9a-f]{32}\/invoke\.js$/, /\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}\.js$/];
  const THROWAWAY = /^[a-z]{4,12}-[a-z]{4,12}\.(?:com|net|pro|top|xyz|site|online|click|link|live|space|fun|icu|cfd|sbs|store|shop)$/;
  // Browser type names differ; fold them into the Chrome names.
  const TYPES = { beacon: "ping", imageset: "image" };
  const SCORED = new Set(["script", "sub_frame", "image", "xmlhttprequest", "ping", "media", "websocket", "object", "other"]);

  // Mostly mixed-case segments in a long path, like political-effort.com's
  // /bjXWV.s/dRGOlb0/YtWndQi/... script addresses.
  function obfuscated(path) {
    const segments = path.split("/").filter(Boolean);
    if (path.length < 60 || segments.length < 4) return false;
    const mixed = segments.filter(segment => /[a-z]/.test(segment) && /[A-Z]/.test(segment)).length;
    return mixed >= Math.ceil(segments.length * 0.6);
  }

  // Reason codes for one loaded request; empty when it does not look like an ad
  // or is not third-party to the page that made it.
  function requestSignals({ url, type, pageHost }) {
    let parsed;
    try { parsed = new URL(url); } catch { return []; }
    const kind = TYPES[type] || type;
    if (!/^(https?|wss?):$/.test(parsed.protocol) || !SCORED.has(kind) || !pageHost) return [];
    const host = parsed.hostname.toLowerCase();
    if (sameSite(host, pageHost)) return [];
    const path = parsed.pathname.toLowerCase();
    const reasons = [];
    if (AD_PATH.test(path)) reasons.push("ad-path");
    if (AD_QUERY.test(parsed.search.toLowerCase())) reasons.push("ad-query");
    if (["image", "ping", "xmlhttprequest", "other"].includes(kind) && TRACKER.test(path)) reasons.push("tracker");
    if (kind === "script" && NETWORK_SCRIPT.some(pattern => pattern.test(path))) reasons.push("network-script");
    if (kind === "script" && obfuscated(parsed.pathname)) reasons.push("obfuscated");
    if ((kind === "script" || kind === "sub_frame") && THROWAWAY.test(siteOf(host))) reasons.push("throwaway-domain");
    return reasons;
  }

  globalThis.BlockAdsFlags = Object.freeze({ REASONS, PAGE_REASONS, requestSignals });
})();
