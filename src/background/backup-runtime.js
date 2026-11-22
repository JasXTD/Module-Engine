/* Full backups share the settings, update and userscript writers, in that order. */
(() => {
  'use strict';
  const backup = ModuleEngineBackup, appearance = ModuleEngineAppearance;
  function create(api, { userscripts, loadSettings, validateSettings, settingKeys, describeChanges, restoreSettings }) {
    const options = { settingKeys, validateSettings };
    const extraKeys = [appearance.KEY, BlockAdsUserScriptUpdates.KEY];
    async function checked(text) {
      const file = backup.parse(text, options);
      for (const script of file.data.userscripts.scripts) if (script.assets !== null) await BlockAdsUserScriptNetwork.verify(script);
      return file;
    }
    return Object.freeze({
      request: message => userscripts.withBackup(async transaction => {
        // Reject a bad file before touching native registrations or persistent data.
        const file = message.type === 'BACKUP_EXPORT' ? null : await checked(message.text);
        const { settings } = await loadSettings(), extra = await api.storage.local.get(extraKeys);
        const data = { settings, appearance: appearance.normalize(extra[appearance.KEY]),
          updates: backup.updatePreferences(BlockAdsUserScriptUpdates.state(extra[BlockAdsUserScriptUpdates.KEY])),
          userscripts: backup.portableLibrary(transaction.library) };
        if (message.type === 'BACKUP_EXPORT') {
          const text = backup.serialize(data, api.runtime.getManifest().version);
          await checked(text);
          return { ok: true, text };
        }
        const baseline = await backup.digest({ settings, extra, library: transaction.library });
        const checksum = await backup.digest(file);
        if (message.type === 'BACKUP_PREVIEW') {
          const changes = describeChanges(settings, file.data.settings, false);
          for (const [key, label] of Object.entries({ interceptLinks: 'Userscript link interception',
            autoCheck: 'Automatic userscript update checks', autoApply: 'Automatic userscript update installation' })) {
            if (data.updates[key] !== file.data.updates[key]) changes.push(label + ' turned ' + (file.data.updates[key] ? 'on' : 'off'));
          }
          const filters = [];
          for (const [key, label] of [['customNetworkFilters', 'Custom request filters'], ['customCosmeticFilters', 'Custom hiding and scriptlet filters']]) {
            if (settings[key] !== file.data.settings[key]) filters.push({ label,
              before: BlockAdsUserScriptCore.escapeBidi(settings[key]), after: BlockAdsUserScriptCore.escapeBidi(file.data.settings[key]) });
          }
          return { ok: true, baseline, checksum, createdAt: file.createdAt, extensionVersion: file.extensionVersion,
            changes, filters, incoming: backup.summary(file.data), current: backup.summary(data) };
        }
        if (message.baseline !== baseline || message.checksum !== checksum) {
          throw new Error('Saved data or the backup changed after the review. Choose the file again to review the latest state.');
        }
        const result = await restoreSettings({ settings: file.data.settings, extra: {
          [appearance.KEY]: file.data.appearance,
          [BlockAdsUserScriptUpdates.KEY]: { schemaVersion: 1, ...file.data.updates, scripts: {} }
        }, prepare: async () => ({ [BlockAdsUserScripts.KEY]: await transaction.prepare(file.data.userscripts) }),
        keys: [...extraKeys, BlockAdsUserScripts.KEY] });
        if (!result.ok) throw new Error(result.error);
        return { ok: true, scripts: file.data.userscripts.scripts.length };
      })
    });
  }
  globalThis.ModuleEngineBackupRuntime = Object.freeze({ create });
})();
