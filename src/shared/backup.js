/* Portable data only. Never serialize native capabilities, approvals or logs. */
(() => {
  'use strict';
  const FORMAT = 'module-engine-backup', VERSION = 1, MAX_BYTES = 8 * 1024 * 1024;
  const core = globalThis.BlockAdsUserScriptCore;
  const fail = message => { throw new Error(message); };
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  function fields(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
        keys.some(key => !Object.hasOwn(value, key))) fail('Invalid ' + label + ' in the backup.');
  }
  const updatePreferences = state => Object.fromEntries(['interceptLinks', 'autoCheck', 'autoApply'].map(key => [key, state[key]]));
  const portableLibrary = library => ({ enabled: library.enabled, scripts: library.scripts.map(script =>
    Object.fromEntries(['source', 'values', 'assets', 'tags', 'sourceURL', 'enabled'].map(key => [key, script[key]]))) });
  // Fresh IDs and capabilities prevent old drafts, updates and live GM clients
  // from addressing restored scripts, even when restoring into the same profile.
  function restoredLibrary(portable, revision = 0) {
    return core.library({ schemaVersion: 1, revision, enabled: false, scripts: portable.scripts.map(script => ({ ...script,
      id: crypto.randomUUID(), revision: 1, enabled: false, autoPageApproved: false,
      token: (crypto.randomUUID() + crypto.randomUUID()).replaceAll('-', '') })) });
  }
  function validate(backup, { settingKeys, validateSettings }) {
    fields(backup, ['format', 'version', 'createdAt', 'extensionVersion', 'data'], 'backup header');
    if (backup.format !== FORMAT || backup.version !== VERSION) fail('This is not a supported Module Engine backup (version 1).');
    if (typeof backup.createdAt !== 'string' || backup.createdAt.length > 40 || !Number.isFinite(Date.parse(backup.createdAt)) ||
        typeof backup.extensionVersion !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(backup.extensionVersion)) fail('Invalid backup version or date.');
    const data = backup.data;
    fields(data, ['settings', 'appearance', 'updates', 'userscripts'], 'backup data');
    fields(data.settings, settingKeys, 'protection settings');
    fields(data.settings.rulesets, ['ads_ruleset', 'trackers_ruleset', 'threats_ruleset', 'community_ruleset'], 'filter layers');
    const settings = validateSettings(data.settings);
    fields(data.appearance, ['mode', 'accent', 'websites', 'websiteExceptions'], 'appearance');
    const appearance = ModuleEngineAppearance.normalize(data.appearance);
    if (canonical(appearance) !== canonical(data.appearance)) fail('Invalid appearance settings in the backup.');
    fields(data.updates, ['interceptLinks', 'autoCheck', 'autoApply'], 'script update settings');
    if (Object.values(data.updates).some(value => typeof value !== 'boolean')) fail('Invalid script update settings in the backup.');
    fields(data.userscripts, ['enabled', 'scripts'], 'script library');
    if (typeof data.userscripts.enabled !== 'boolean' || !Array.isArray(data.userscripts.scripts) ||
        data.userscripts.scripts.length > core.LIMITS.scripts) fail('Invalid or oversized script library in the backup.');
    for (const script of data.userscripts.scripts) {
      fields(script, ['source', 'values', 'assets', 'tags', 'sourceURL', 'enabled'], 'script');
      if (typeof script.enabled !== 'boolean') fail('Invalid script switch in the backup.');
    }
    const checked = portableLibrary(restoredLibrary(data.userscripts));
    // Retain saved on/off intent for the preview; it is never an execution approval.
    checked.enabled = data.userscripts.enabled;
    checked.scripts.forEach((script, index) => { script.enabled = data.userscripts.scripts[index].enabled; });
    return { ...backup, data: { settings, appearance, updates: updatePreferences(data.updates), userscripts: checked } };
  }
  function parse(text, options) {
    if (typeof text !== 'string' || core.bytes(text) > MAX_BYTES) fail('Choose a JSON backup no larger than 8 MiB.');
    let parsed;
    try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('The file is not valid JSON. Choose a Module Engine backup.'); }
    return validate(parsed, options);
  }
  function serialize(data, extensionVersion) {
    // Compact JSON keeps deeply nested, valid GM values inside the file budget.
    const text = JSON.stringify({ format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), extensionVersion, data }) + '\n';
    if (core.bytes(text) > MAX_BYTES) fail('The backup exceeds the 8 MiB file limit.');
    return text;
  }
  async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  function summary(data) {
    return { scripts: data.userscripts.scripts.map(script => ({ name: core.escapeBidi(core.parse(script.source).name),
      values: Object.keys(script.values).length, dependencies: script.assets?.length || 0, enabled: script.enabled })),
      domains: Object.values(data.settings).filter(Array.isArray).reduce((count, list) => count + list.length, 0),
      networkFilters: data.settings.customNetworkFilters.split('\n').filter(line => line.trim() && !line.trim().startsWith('!')).length,
      cosmeticFilters: data.settings.customCosmeticFilters.split('\n').filter(line => line.trim() && !line.trim().startsWith('!')).length,
      blocking: data.settings.enabled, userscripts: data.userscripts.enabled, mode: data.appearance.mode };
  }
  globalThis.ModuleEngineBackup = Object.freeze({ FORMAT, VERSION, MAX_BYTES, parse, serialize, digest,
    portableLibrary, restoredLibrary, updatePreferences, summary });
})();
