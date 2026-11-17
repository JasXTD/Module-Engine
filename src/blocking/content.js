/**
 * Module Engine — Cosmetic Filter & Malvertising Overlay Blocker
 * Hides leftover ad containers, sponsored widgets, and deceptive ad overlays.
 * Respects per-site whitelist and global toggle immediately.
 */

(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const STYLE_ID = "blockads-cosmetic-shield";
  let evaluation = 0;
  let pageSuspended = false;
  let popupGuardRequested = false;
  let popupGuardRequesting = false;
  const proceduralShield = BlockAdsProcedural.create({
    document,
    isAlive: () => { try { return Boolean(api.runtime.id); } catch { return false; } },
    onProblem: (kind, error) => {
      if (kind === 'error') console.error('[Module Engine] Advanced page hiding failed:', error);
      else console.warn('[Module Engine] Advanced page hiding:', kind === 'limit' ? 'Stopped for this page after reaching a scan limit; ordinary CSS and network filtering remain active.' : 'Some filters are unsupported by this browser.');
      try { api.runtime.sendMessage({ type: 'LOG_EVENT', event: `procedural-filter-${kind}` }).catch(() => {}); } catch {}
    }
  });
  const redditPolicy = BlockAdsReddit.policyFor({ document });
  const buttonShield = BlockAdsButtons.create({ document,
    isAlive: () => { try { return Boolean(api.runtime.id); } catch { return false; } },
    onProblem: error => console.warn('[Module Engine] Button protection stopped:', error.message)
  });
  const overlayShield = BlockAdsOverlays.create({ document,
    isAlive: () => { try { return Boolean(api.runtime.id); } catch { return false; } },
    onProblem: error => console.warn('[Module Engine] Prompt repair stopped:', error.message)
  });

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

  // Community list rules for this site, plus any generic selectors the bundled
  // stylesheets do not cover here. The builder already refused braces and
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
    lastCss = valid.length ? `\n${BlockAdsCosmetic.hidingCss(valid)}` : "";
    return lastCss;
  }

  // Bundled generic hiding arrives as registered stylesheets. Their companion
  // script runs after this one, so the first request is sent before this frame
  // knows whether they are here; all document-start scripts have run by
  // DOMContentLoaded, whose request states it. The sheets cannot be removed from
  // a loaded page, so a root attribute revokes them when a pause, switch or
  // exception now excludes this frame, and the reply then carries the generic
  // selectors that still apply. As with the style element, page code can undo
  // this until the next refresh.
  const GENERIC_OFF = BlockAdsCosmetic.GENERIC_OFF_ATTRIBUTE;
  let staticSheets = globalThis.BlockAdsGenericStatic === true;
  let domReady = document.readyState !== "loading";
  let staticKnown = staticSheets || domReady;
  let staticAllowed = true;
  let staticAssumed = null;
  function syncStaticSheets() {
    const root = document.documentElement;
    if (root && staticSheets && !staticAllowed) { if (!root.hasAttribute(GENERIC_OFF)) root.setAttribute(GENERIC_OFF, ""); }
    else root?.removeAttribute(GENERIC_OFF);
    // A reply judged for the other case lacks, or repeats, the sheets' selectors.
    // Before DOMContentLoaded, its request corrects that; afterwards, ask once.
    if (domReady && staticKnown && staticAssumed !== null && staticAssumed !== staticSheets) {
      staticAssumed = null;
      void evaluateAndApply();
    }
  }
  globalThis.BlockAdsCosmeticShield = Object.freeze({
    staticReady() { staticSheets = staticKnown = true; syncStaticSheets(); }
  });

  function applyCosmeticShield(state) {
    const existing = document.getElementById(STYLE_ID);
    if (!state.enabled) {
      existing?.remove();
      return;
    }
    const exceptions = new Set(state.exceptions || []);
    // These bundled CSS blocks contain only a selector list and one declaration
    // block. Split the lists so site exceptions also cover our built-in selectors.
    const selectorsOf = css => css.replace(/\/\*[\s\S]*?\*\//g, "").split("{")[0].split(",").map(s => s.trim()).filter(Boolean);
    const base = state.disableGeneric ? [] : selectorsOf(COSMETIC_CSS).filter(selector => !exceptions.has(selector));
    // Retain the built-in visibility/size/pointer protections as well as display.
    // A site's own display rule must not undo the existing extra safeguards.
    const baseCss = base.length ? base.join(",\n") + COSMETIC_CSS.slice(COSMETIC_CSS.indexOf("{")) : "";
    const selectors = [...selectorsOf(SITE_COSMETIC_CSS), ...state.siteSelectors || [], ...state.genericSelectors || []];
    const css = baseCss + siteListCss([...new Set(selectors)].filter(selector => !exceptions.has(selector)));
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

  const youtubeFallback = onYouTube ? BlockAdsYouTube.create({ document, onSkipped: () => {
    // Report only after an attempted skip/seek is followed by the ad state ending.
    try { api.runtime.sendMessage({ type: 'LOG_EVENT', event: 'youtube-ad-skipped' }).catch(() => {}); } catch {}
  } }) : null;

  async function evaluateAndApply() {
    if (pageSuspended) return;
    const version = ++evaluation;
    const installPopupGuard = !popupGuardRequested && !popupGuardRequesting;
    if (installPopupGuard) popupGuardRequesting = true;
    try {
      const state = await api.runtime.sendMessage({
        type: "GET_COSMETIC_STATE", installPopupGuard, staticGeneric: staticSheets || (staticKnown ? false : null)
      });
      if (state?.popupGuard) popupGuardRequested = true;
      if (version !== evaluation) return;
      if (!state?.ok) throw new Error(state?.error || "No cosmetic filtering state returned.");
      youtubeFallback?.setEnabled(Boolean(state.ads));
      applyCosmeticShield(state);
      buttonShield.setEnabled(state.deceptiveButtons);
      overlayShield.setRules([
        state.enabled && !state.disableAll ? redditPolicy : null,
        state.notificationPrompts ? BlockAdsPrompts.notification : null,
        state.installPrompts ? BlockAdsPrompts.install : null
      ].filter(Boolean));
      proceduralShield.setRules(state.enabled && !state.disableAll && state.procedural !== false ? state.proceduralRules || [] : []);
      setAdSignScanning(Boolean(state.flag));
      staticAllowed = Boolean(state.enabled && state.genericStatic);
      staticAssumed = typeof state.staticAssumed === "boolean" ? state.staticAssumed : null;
      syncStaticSheets();
    } catch (error) {
      // Existing tabs may retain an invalidated context after extension reload.
      // Leave their current style intact and make the unavailable refresh visible.
      console.warn("[Module Engine] Cosmetic settings unavailable; reload this page:", error.message);
    } finally {
      if (installPopupGuard) popupGuardRequesting = false;
    }
  }

  // Flagging: report ad-looking page elements that were not hidden or blocked.
  // Runs once per page, in the top frame, a few seconds after load. The background
  // keeps only third-party addresses and decides nothing is blocked.
  const AD_SIZES = [[300, 250], [336, 280], [728, 90], [970, 90], [970, 250], [160, 600], [120, 600],
    [300, 600], [320, 50], [320, 100], [300, 50], [468, 60], [250, 250], [200, 200]];
  const AD_LABEL = /^(ad|ads|advertisement|sponsored|promoted|广告|廣告|赞助|贊助|推广|推廣)$/i;
  let flagScanDone = false;
  function scanForAdSigns() {
    if (flagScanDone || window !== window.top || !document.body) return;
    flagScanDone = true;
    const items = [];
    for (const frame of document.querySelectorAll("iframe[src]")) {
      const { width, height } = frame.getBoundingClientRect();
      if (AD_SIZES.some(([w, h]) => Math.abs(width - w) <= 2 && Math.abs(height - h) <= 2)) items.push({ url: frame.src, reason: "ad-size-frame" });
    }
    let checked = 0;
    for (const element of document.body.querySelectorAll("span, div, p, small, a, b, i, em, strong, label, ins")) {
      if (++checked > 3000 || items.length >= 20) break;
      if (element.childElementCount || !AD_LABEL.test(element.textContent.trim())) continue;
      // The labelled ad is usually a frame, link or image within a few levels.
      let box = element.parentElement;
      for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
        const target = box.querySelector("iframe[src], a[href^='http'], img[src^='http']");
        if (target) { items.push({ url: target.src || target.href, reason: "ad-label" }); break; }
      }
    }
    if (items.length) {
      try { api.runtime.sendMessage({ type: "FLAG_CANDIDATES", items: items.slice(0, 20) }).catch(() => {}); } catch {}
    }
  }
  let flagScanScheduled = false;
  let flagScanTimer = null;
  let flagScanLoadListener = null;
  function armAdSignScan() {
    flagScanLoadListener = null;
    flagScanTimer = setTimeout(() => {
      flagScanTimer = null;
      flagScanScheduled = false;
      scanForAdSigns();
    }, 3000);
  }
  function scheduleAdSignScan() {
    // Settings are re-evaluated several times per page; schedule the scan once.
    if (flagScanDone || flagScanScheduled) return;
    flagScanScheduled = true;
    if (document.readyState === "complete") armAdSignScan();
    else {
      flagScanLoadListener = armAdSignScan;
      window.addEventListener("load", flagScanLoadListener, { once: true });
    }
  }
  function cancelAdSignScan() {
    if (flagScanTimer !== null) clearTimeout(flagScanTimer);
    if (flagScanLoadListener) window.removeEventListener("load", flagScanLoadListener);
    flagScanTimer = null;
    flagScanLoadListener = null;
    flagScanScheduled = false;
  }
  function setAdSignScanning(enabled) {
    if (enabled) scheduleAdSignScan();
    else cancelAdSignScan();
  }

  evaluateAndApply();
  // Ask again once the document has parsed. A frame's document-start request can
  // see stale tab details (Firefox may still report the tab's blank or previous
  // URL), which the top page's pauses, prompt exceptions and the cross-origin
  // pop-up guard depend on. This also retries a failed request.
  document.addEventListener("DOMContentLoaded", () => {
    domReady = staticKnown = true;
    void evaluateAndApply();
  }, { once: true });
  window.addEventListener('pagehide', event => {
    if (event.isTrusted) { pageSuspended = true; evaluation++; youtubeFallback?.setEnabled(false); proceduralShield.clear(); overlayShield.clear(); buttonShield.clear(); }
  });
  window.addEventListener('pageshow', event => { if (event.isTrusted) { pageSuspended = false; void evaluateAndApply(); } });

  // React immediately when user toggles settings in the popup
  if (api.storage && api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && ["enabled", "rulesets", "cosmeticFiltering", "flagSuspects",
        "whitelistedDomains", "popupBlockedDomains", "genericCosmeticFiltering", "proceduralFiltering", "customCosmeticFilters", "cosmeticPausedDomains",
        "notificationPromptBlocking", "deceptivePromptBlocking", "deceptiveButtonBlocking", "promptAllowedDomains"].some(key => key in changes)) evaluateAndApply();
    });
  }
})();
