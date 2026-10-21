/**
 * BlockAds Shield — Cosmetic Filter & Malvertising Overlay Blocker
 * Hides leftover ad containers, sponsored widgets, and deceptive ad overlays.
 * Respects per-site whitelist and global toggle immediately.
 */

(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const STYLE_ID = "blockads-cosmetic-shield";
  let evaluation = 0;

  // Site-specific selectors apply only on their own site, so another site's
  // similarly named content is safe.
  const hostname = location.hostname.toLowerCase().replace(/\.$/, "");
  const onSite = domain => hostname === domain || hostname.endsWith(`.${domain}`);
  const onYouTube = onSite("youtube.com") || onSite("youtube-nocookie.com");

  // Fandom keeps these empty wrappers after its ad requests are blocked.
  const FANDOM_CSS = ".fandom-ad-wrapper { display: none !important; }";

  // YouTube serves these slots from its own hosts, so network rules leave them.
  const YOUTUBE_CSS = `
    #masthead-ad,
    #player-ads,
    ytd-ad-slot-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-reel-video-renderer:has(ytd-ad-slot-renderer),
    ytd-in-feed-ad-layout-renderer,
    ytd-banner-promo-renderer,
    ytd-video-masthead-ad-v3-renderer,
    ytd-primetime-promo-renderer,
    ytd-display-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-action-companion-ad-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-promoted-sparkles-text-search-renderer,
    ytd-promoted-video-renderer,
    ytd-search-pyv-renderer,
    ytd-player-legacy-desktop-watch-ads-renderer,
    ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"],
    .ytp-ad-overlay-container,
    .ytp-ad-overlay-slot,
    ad-slot-renderer,
    ytm-promoted-sparkles-web-renderer,
    ytm-promoted-video-renderer,
    ytm-companion-ad-renderer,
    ytm-rich-item-renderer:has(ad-slot-renderer) {
      display: none !important;
    }
  `;
  const SITE_COSMETIC_CSS = onSite("fandom.com") ? FANDOM_CSS : onYouTube ? YOUTUBE_CSS : "";

  const COSMETIC_CSS = `
    /* Google & Programmatic Ad Containers */
    ins.adsbygoogle,
    [id^="div-gpt-ad"],
    [id^="google_ads_iframe"],
    [id^="google_ads_frame"],
    [data-google-query-id],
    [data-ad-slot],
    [data-ad-client],
    iframe[src*="doubleclick.net"],
    iframe[src*="googlesyndication.com"],
    iframe[src*="adnxs.com"],
    iframe[src*="criteo.com"],
    iframe[src*="amazon-adsystem.com"],
    iframe[src*="exoclick.com"],
    iframe[src*="propellerads.com"],
    iframe[src*="adsterra.com"],

    /* Sponsored Content & Chumbox Widgets */
    [id^="taboola-"],
    .trc_rbox_container,
    .OUTBRAIN,
    [data-widget-id^="outbrain"],
    [id^="mgid_"],
    [class*="mgid-widget"],
    .rc-wc,
    [id^="rc-widget-"],
    .zergnet-widget,

    /* Common Ad Placeholder Classes & Deceptive Malvertising Links */
    .ad-slot,
    .ad-leaderboard,
    .ad-sky,
    .pub_300x250,
    .pub_300x250m,
    .pub_728x90,
    .text-ad,
    .textAd,
    .text_ad,
    .text_ads,
    a[href*="propellerads.com"],
    a[href*="popads.net"],
    a[href*="adsterra.com"],
    a[href*="hilltopads.net"],
    a[href*="clickadu.com"],
    a[href*="adf.ly"] {
      display: none !important;
      visibility: hidden !important;
      height: 0 !important;
      min-height: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }
  `;

  // Community list rules for this site. The builder already refused braces and
  // comments; a selector this browser cannot parse would void the whole rule, so
  // each is parsed first (querySelector also accepts "a, b" selector lists).
  // The result is cached: the same list arrives on every settings refresh.
  const probe = document.createDocumentFragment();
  let lastSelectors = null;
  let lastCss = "";
  function siteListCss(selectors) {
    const list = Array.isArray(selectors) ? selectors : [];
    const key = list.join("\n");
    if (key === lastSelectors) return lastCss;
    const valid = list.filter(selector => {
      try { probe.querySelector(selector); return typeof selector === "string"; } catch { return false; }
    });
    lastSelectors = key;
    lastCss = valid.length ? `\n${valid.join(",\n")} { display: none !important; }` : "";
    return lastCss;
  }

  function applyCosmeticShield(shouldEnable, selectors) {
    const existing = document.getElementById(STYLE_ID);
    if (!shouldEnable) {
      existing?.remove();
      return;
    }
    const css = COSMETIC_CSS + SITE_COSMETIC_CSS + siteListCss(selectors);
    if (existing) {
      if (existing.textContent !== css) existing.textContent = css;
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = css;
    const parent = document.head || document.documentElement;
    if (parent) parent.appendChild(style);
  }

  // Fallback for YouTube video ads that still reach the player (for example if
  // YouTube changes its player data): mute the ad and jump to its end. The
  // player marks ad playback with these classes on .html5-video-player.
  let skipAds = false;
  const restore = new Map();
  function skipVideoAd(video) {
    const player = video.closest(".html5-video-player");
    const adShowing = skipAds && player &&
      (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting"));
    if (adShowing) {
      if (!restore.has(video)) {
        restore.set(video, { muted: video.muted, rate: video.playbackRate });
        // Once per ad, for the activity log. Ignore an invalidated extension context.
        try { api.runtime.sendMessage({ type: "LOG_EVENT", event: "youtube-ad-skipped" }).catch(() => {}); } catch {}
      }
      video.muted = true;
      video.playbackRate = 16;
      if (Number.isFinite(video.duration) && video.currentTime < video.duration - 0.1) video.currentTime = video.duration;
      player.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern")?.click();
    } else if (restore.has(video)) {
      // Leave anything the player or the person changed since the ad started.
      const saved = restore.get(video);
      if (video.playbackRate === 16) video.playbackRate = saved.rate;
      if (video.muted && !saved.muted) video.muted = false;
      restore.delete(video);
    }
  }
  const onMediaEvent = event => { if (event.target instanceof HTMLVideoElement) skipVideoAd(event.target); };
  function setVideoAdSkipping(enabled) {
    if (!onYouTube || enabled === skipAds) return;
    skipAds = enabled;
    // Media events do not bubble; capture them for every player video.
    for (const type of ["loadedmetadata", "durationchange", "playing", "timeupdate"]) {
      if (enabled) document.addEventListener(type, onMediaEvent, true);
      else document.removeEventListener(type, onMediaEvent, true);
    }
    for (const video of new Set([...document.querySelectorAll(".html5-video-player video"), ...restore.keys()])) skipVideoAd(video);
  }

  async function evaluateAndApply() {
    const version = ++evaluation;
    try {
      const state = await api.runtime.sendMessage({ type: "GET_COSMETIC_STATE" });
      if (version !== evaluation) return;
      if (!state?.ok) throw new Error(state?.error || "No cosmetic filtering state returned.");
      applyCosmeticShield(state.enabled, state.siteSelectors);
      setVideoAdSkipping(Boolean(state.ads));
    } catch (error) {
      // Existing tabs may retain an invalidated context after extension reload.
      // Leave their current style intact and make the unavailable refresh visible.
      console.warn("[BlockAds] Cosmetic settings unavailable; reload this page:", error.message);
    }
  }

  // popups.js (page world, only on sites with pop-up blocking) reports each block
  // as a hostname. Forward a limited number to the activity log; the background
  // ignores reports from sites without pop-up blocking.
  let popupReports = 0;
  let lastPopupReport = 0;
  document.addEventListener("blockads-popup-blocked", event => {
    const now = Date.now();
    if (popupReports >= 20 || now - lastPopupReport < 1000) return;
    popupReports++;
    lastPopupReport = now;
    const host = typeof event.detail === "string" ? event.detail.slice(0, 253) : "";
    try { api.runtime.sendMessage({ type: "LOG_EVENT", event: "popup-blocked", host }).catch(() => {}); } catch {}
  });

  evaluateAndApply();
  document.addEventListener("DOMContentLoaded", evaluateAndApply, { once: true });

  // React immediately when user toggles settings in the popup
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && ["enabled", "rulesets", "cosmeticFiltering", "whitelistedDomains"].some(key => key in changes)) evaluateAndApply();
    });
  }
})();
