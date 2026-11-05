/* Only bundled, reviewed adapters may join this registry. User code is data. */
(() => {
  'use strict';
  function create(adBlocking, userscripts) {
    const modules = new Map([['blocking', adBlocking], ['userscripts', userscripts]]);
    return Object.freeze({
      async state() {
        const entries = await Promise.all([...modules].map(async ([id, adapter]) => {
          try { return { id, ...(await adapter.state()) }; }
          catch (error) { return { id, enabled: null, active: false, error: error.message }; }
        }));
        return { ok: true, modules: entries };
      },
      async set(id, enabled) {
        if (!modules.has(id) || typeof enabled !== 'boolean') throw new Error('Unknown module or invalid module switch.');
        return modules.get(id).setEnabled(enabled);
      }
    });
  }
  globalThis.BlockAdsModules = Object.freeze({ create });
})();
