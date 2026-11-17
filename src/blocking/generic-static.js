/* Registered with the bundled generic stylesheets: tells this frame's cosmetic
   content script that they were injected here. Browsers run it after the
   manifest content scripts (Firefox one task later), so it also notifies. */
(() => {
  globalThis.BlockAdsGenericStatic = true;
  globalThis.BlockAdsCosmeticShield?.staticReady();
})();
