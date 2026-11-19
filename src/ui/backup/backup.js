/* The selected bytes stay in this page until a trusted Restore click. */
(() => {
  'use strict';
  const api = globalThis.browser || chrome, byId = id => document.getElementById(id);
  const status = byId('status'), fileInput = byId('backupFile'), review = byId('review');
  const confirm = byId('confirmRestore'), restore = byId('restoreBackup'), exportButton = byId('exportBackup');
  const MAX_BYTES = 8 * 1024 * 1024;
  const countLabel = (count, noun) => count + ' ' + noun + (count === 1 ? '' : 's');
  let selection = null, busy = false, sequence = 0, downloadURL = null;
  const notice = (text, kind = '') => { status.textContent = text; status.className = 'notice' + (kind ? ' ' + kind : ''); };
  async function send(message) {
    const response = await api.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || 'The extension did not answer. Reload this page and try again.');
    return response;
  }
  function controls() {
    exportButton.disabled = busy; fileInput.disabled = busy; confirm.disabled = busy;
    byId('cancelReview').disabled = busy;
    restore.disabled = busy || !selection || !confirm.checked;
    review.setAttribute('aria-busy', String(busy));
  }
  function clear() {
    sequence++; selection = null; review.hidden = true; confirm.checked = false; fileInput.value = ''; controls();
  }
  function show(result, filename) {
    byId('reviewHeading').textContent = 'Review ' + filename;
    byId('backupDetails').textContent = 'Created ' + new Date(result.createdAt).toLocaleString() + ' · Module Engine ' + result.extensionVersion;
    const rows = [
      ['Scripts', result.current.scripts.length, result.incoming.scripts.length],
      ['Saved script values', ...[result.current, result.incoming].map(summary => summary.scripts.reduce((sum, script) => sum + script.values, 0))],
      ['Cached dependencies', ...[result.current, result.incoming].map(summary => summary.scripts.reduce((sum, script) => sum + script.dependencies, 0))],
      ['Domain list entries', result.current.domains, result.incoming.domains],
      ['Custom request filter lines', result.current.networkFilters, result.incoming.networkFilters],
      ['Custom hiding filter lines', result.current.cosmeticFilters, result.incoming.cosmeticFilters],
      ['Ad blocking', result.current.blocking ? 'On' : 'Off', result.incoming.blocking ? 'On' : 'Off'],
      ['Theme', result.current.mode, result.incoming.mode]
    ];
    byId('reviewRows').replaceChildren(...rows.map(values => {
      const row = document.createElement('tr');
      values.forEach((value, index) => { const cell = document.createElement(index ? 'td' : 'th');
        if (!index) cell.scope = 'row'; cell.textContent = String(value); row.append(cell); });
      return row;
    }));
    byId('scriptNames').replaceChildren(...result.incoming.scripts.map(script => {
      const item = document.createElement('li');
      item.textContent = script.name + ' · ' + countLabel(script.values, 'saved value') + ' · ' +
        script.dependencies + (script.dependencies === 1 ? ' dependency' : ' dependencies') + ' · restored off';
      return item;
    }));
    byId('noScripts').hidden = result.incoming.scripts.length > 0;
    review.hidden = false; confirm.checked = false; controls();
    byId('reviewHeading').focus();
  }
  exportButton.addEventListener('click', async event => {
    if (!event.isTrusted || busy) return;
    const request = sequence;
    busy = true; controls(); notice('Preparing your backup…');
    try {
      const result = await send({ type: 'BACKUP_EXPORT' });
      if (request !== sequence) return;
      if (downloadURL) URL.revokeObjectURL(downloadURL);
      downloadURL = URL.createObjectURL(new Blob([result.text], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = downloadURL;
      link.download = 'module-engine-backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      document.body.append(link); link.click(); link.remove();
      notice('Backup download started. Keep the JSON file somewhere safe.', 'success');
    } catch (error) { notice(error.message, 'error'); }
    finally { busy = false; controls(); }
  });
  fileInput.addEventListener('change', async () => {
    if (busy) return;
    const file = fileInput.files?.[0];
    selection = null; review.hidden = true; confirm.checked = false;
    const request = ++sequence;
    if (!file) { controls(); return; }
    busy = true; controls(); notice('Checking the backup. Your saved data is unchanged…');
    try {
      if (file.size > MAX_BYTES) throw new Error('Choose a JSON backup no larger than 8 MiB.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
      catch { throw new Error('The backup could not be read as UTF-8 text. Choose a Module Engine JSON backup.'); }
      const result = await send({ type: 'BACKUP_PREVIEW', text });
      if (request !== sequence) return;
      selection = { text, baseline: result.baseline, checksum: result.checksum };
      show(result, file.name);
      notice('Backup checked. Review what will be replaced before restoring.');
    } catch (error) {
      if (request === sequence) { fileInput.value = ''; notice(error.message, 'error'); }
    }
    finally { busy = false; controls(); }
  });
  confirm.addEventListener('change', controls);
  byId('cancelReview').addEventListener('click', () => { if (!busy) { clear(); notice('Restore cancelled. Your saved data is unchanged.'); } });
  restore.addEventListener('click', async event => {
    if (!event.isTrusted || busy || !selection || !confirm.checked) return;
    busy = true; controls(); notice('Restoring and checking your saved data…');
    try {
      const result = await send({ type: 'BACKUP_RESTORE', ...selection });
      clear();
      notice('Backup restored. ' + countLabel(result.scripts, 'script') + ' restored off. Review them in Modules & scripts before enabling them, and reload affected website tabs.', 'success');
    } catch (error) {
      clear(); notice(error.message + ' Choose the backup again before retrying.', 'error');
    } finally { busy = false; controls(); }
  });
  addEventListener('pagehide', () => { sequence++; if (downloadURL) URL.revokeObjectURL(downloadURL); });
  controls();
})();
