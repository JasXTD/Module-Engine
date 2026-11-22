/* Disposable profiles, owned script/value fixtures, and the real backup page. */
'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function runBackup({ b, manager, send, check, until, browse, scriptSource, evidence, temp, port }) {
  const pages = [], open = async url => { const page = await b.open(url); pages.push(page); return page; };
  const get = (code, page = manager) => b.evaluate(code, page);
  const message = (value, page) => get('(globalThis.browser||chrome).runtime.sendMessage(' + JSON.stringify(value) + ')', page);
  const click = async (id, page) => {
    await b.front(page);
    const point = await until(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled||!e.getClientRects().length)return null;
      e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`, page);
    await b.clickAt(point.x, point.y, page);
  };
  const backupURL = await get("(globalThis.browser||chrome).runtime.getURL('src/ui/backup/backup.html')");
  let backupPage;
  async function choose(text, name = 'fixture-backup.json') {
    const file = path.join(temp, name); await fs.writeFile(file, text);
    await until("!document.getElementById('backupFile').disabled", backupPage);
    if (b.send) {
      const { root } = await b.send('DOM.getDocument', {}, backupPage);
      const { nodeId } = await b.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#backupFile' }, backupPage);
      // Clear so choosing the same file produces another native change event.
      await get("(document.getElementById('backupFile').value='',true)", backupPage);
      await b.send('DOM.setFileInputFiles', { nodeId, files: [file] }, backupPage);
    } else {
      // Firefox's existing adapter has no native file-picker operation. Exercise
      // the real File reader with authored bytes; restore still needs native input.
      await get(`(()=>{const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)},{type:'application/json'}));
        const input=document.getElementById('backupFile');input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`, backupPage);
    }
    await until("!document.getElementById('backupFile').disabled", backupPage);
  }
  async function shot(name) {
    await get('(document.getAnimations().forEach(a=>a.finish()),true)', backupPage);
    if (b.send) {
      const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, backupPage);
      await fs.writeFile(path.join(temp, name + '.png'), Buffer.from(shot.data, 'base64'));
    } else await b.screenshot(path.join(temp, name + '.png'), backupPage);
  }
  try {
    check('Backup appears in the shared navigation', await get("Boolean(document.querySelector('a[href=\"../backup/backup.html\"]'))"));
    backupPage = await open(backupURL);
    await until("document.getElementById('exportBackup')&&!document.getElementById('exportBackup').disabled", backupPage);
    check('A manager page cannot read full backups', !(await send({ type: 'BACKUP_EXPORT' })).ok);
    const source = scriptSource('Backup <fixture> ✓', '// @grant GM.getValue\n// @grant GM.setValue\n', `
      (async()=>{let answer=await GM.getValue('answer',null);if(answer===null){answer={count:42,text:'你好'};await GM.setValue('answer',answer);}
      document.body.dataset.backupAnswer=JSON.stringify(answer);})();
      document.addEventListener('backup-probe',()=>GM.setValue('late',true).then(()=>document.body.dataset.backupProbe='accepted',()=>document.body.dataset.backupProbe='revoked'));
    `, '// @resource style http://127.0.0.1:' + port + '/usnet/style.css\n');
    let saved = await send({ type: 'US_SAVE', source }); check('Backup fixture saves', saved.ok);
    let script = saved.scripts.find(item => item.id === saved.selectedId);
    let prepared = await send({ type: 'US_PREPARE_ASSETS', id: script.id, revision: script.revision });
    check('Fixture cached resource prepares before backup', prepared.ok);
    script = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === script.id);
    const tagged = await send({ type: 'US_TAGS', id: script.id, revision: script.revision, tags: ['backup', 'local'] });
    check('Fixture local tags save', tagged.ok); script = tagged.scripts.find(item => item.id === script.id);
    check('Fixture enables before backup', (await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true })).ok);
    const live = await browse('/backup-fixture'); pages.push(live);
    await until("document.body.dataset.backupAnswer?.includes('42')", live);
    const original = await get("(globalThis.browser||chrome).storage.local.get('userscriptManager').then(r=>r.userscriptManager)");
    check('Fixture stores values through its native GM channel', original.scripts.find(item => item.id === script.id).values.answer.count === 42);
    await click('exportBackup', backupPage);
    let text;
    for (let attempt = 0; attempt < 160; attempt++) {
      const names = await fs.readdir(path.join(temp, 'exports')), name = names.find(name => /^module-engine-backup-.*\.json$/.test(name));
      if (name && !names.some(name => /\.(?:part|crdownload)$/.test(name))) {
        const content = await fs.readFile(path.join(temp, 'exports', name), 'utf8'); if (content) { text = content; break; }
      }
      await pause(50);
    }
    check('Native JSON download completes', Boolean(text));
    const file = JSON.parse(text);
    check('Download contains source, tags, saved values and cached bytes', file.data.userscripts.scripts[0].source === source &&
      file.data.userscripts.scripts[0].values.answer.count === 42 && file.data.userscripts.scripts[0].tags.join() === 'backup,local' &&
      file.data.userscripts.scripts[0].assets[0].body.length > 0);
    check('Download contains no native execution capabilities', !text.includes(original.scripts[0].token) && !text.includes(original.scripts[0].id));
    await choose('{broken', 'invalid.json');
    check('Malformed import shows an error and keeps Restore disabled', await get("document.getElementById('status').classList.contains('error')&&document.getElementById('restoreBackup').disabled&&document.getElementById('review').hidden", backupPage));
    await shot('backup-error');
    const reviewFile = JSON.parse(text);
    reviewFile.data.settings.allowedDomains.push('review.example');
    reviewFile.data.settings.rulesets.threats_ruleset = !file.data.settings.rulesets.threats_ruleset;
    reviewFile.data.settings.customNetworkFilters = '||review.example^';
    reviewFile.data.updates.autoApply = !file.data.updates.autoApply;
    await choose(JSON.stringify(reviewFile));
    check('Review names the changed threat layer, allowed domain and update policy', await get(
      "['Reported threat layer turned','Always allowed review.example','Automatic userscript update installation turned'].every(s=>document.getElementById('protectionChanges').textContent.includes(s))", backupPage));
    check('Review shows the exact replacement request filter', await get("document.querySelector('#filterChanges pre:last-child').textContent==='||review.example^'", backupPage));
    check('Review displays escaped script names without executing markup', await get("document.getElementById('scriptNames').textContent.includes('Backup <fixture> ✓')&&!document.querySelector('#scriptNames fixture')", backupPage));
    check('Restore requires acknowledgment', await get("!document.getElementById('review').hidden&&document.getElementById('restoreBackup').disabled&&document.activeElement.id==='reviewHeading'", backupPage));
    check('Review leaves the current library unchanged', JSON.stringify(await get("(globalThis.browser||chrome).storage.local.get('userscriptManager').then(r=>r.userscriptManager)")) === JSON.stringify(original));
    for (const scheme of ['light', 'dark']) {
      if (b.send) {
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, backupPage);
        for (const width of [1100, 380]) {
          await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, backupPage);
          await get('(scrollTo(0,0),true)', backupPage);
          await shot('backup-' + scheme + '-' + width);
          const fits = await get('document.documentElement.scrollWidth<=document.documentElement.clientWidth', backupPage);
          if (!fits) evidence.backupOverflow = await get(`({width:innerWidth,scroll:document.documentElement.scrollWidth,
            elements:[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>({tag:e.tagName,id:e.id,width:e.getBoundingClientRect().width,text:e.textContent.slice(0,70)}))})`, backupPage);
          check('Backup ' + scheme + ' fits ' + width + 'px', fits);
        }
      } else {
        await b.setColorScheme(scheme); await get('(scrollTo(0,0),true)', backupPage);
        check('Firefox backup ' + scheme + ' fits', await get('document.documentElement.scrollWidth<=document.documentElement.clientWidth', backupPage));
        await shot('backup-' + scheme + '-firefox');
      }
    }
    if (b.send) await b.send('Emulation.clearDeviceMetricsOverride', {}, backupPage);
    else {
      await get(`(()=>{const frame=document.createElement('iframe');frame.id='backupNarrow';frame.src=${JSON.stringify(backupURL)};
        frame.style='position:fixed;left:0;top:0;width:380px;height:950px;z-index:9999;border:0';document.body.append(frame);return true;})()`);
      await until("document.getElementById('backupNarrow')?.contentDocument?.getElementById('backupFile')", manager);
      check('Firefox backup fits a 380px section frame', await get("(()=>{const d=document.getElementById('backupNarrow').contentDocument;return d.documentElement.scrollWidth<=d.documentElement.clientWidth;})()"));
      await b.screenshot(path.join(temp, 'backup-firefox-380.png'), manager);
      await get("(document.getElementById('backupNarrow').remove(),true)");
    }
    await click('cancelReview', backupPage);
    check('Cancel hides the review and keeps saved data', await get("document.getElementById('review').hidden", backupPage));
    await choose(text);
    check('An intervening settings change saves', (await send({ type: 'ADD_CUSTOM_DOMAIN', domain: 'later.example' })).ok);
    await click('confirmRestore', backupPage); await click('restoreBackup', backupPage);
    await until("!document.getElementById('backupFile').disabled", backupPage);
    check('A stale review refuses restore and retains the new setting', await get("document.getElementById('status').textContent.includes('after the review')", backupPage) &&
      (await send({ type: 'GET_STATE' })).settings.customBlockedDomains.includes('later.example'));
    await choose(text);
    await click('confirmRestore', backupPage);
    await get("(document.getElementById('restoreBackup').click(),true)", backupPage);
    check('Script-dispatched restore clicks have no effect', (await send({ type: 'US_LIST' })).enabled);
    await click('restoreBackup', backupPage);
    await until("document.getElementById('status').textContent.startsWith('Backup restored.')", backupPage);
    const restored = await get("(globalThis.browser||chrome).storage.local.get('userscriptManager').then(r=>r.userscriptManager)");
    check('Restore pauses the module and all scripts, with fresh credentials', !restored.enabled && restored.scripts.every(item => !item.enabled) &&
      restored.scripts[0].token !== original.scripts[0].token && restored.scripts[0].id !== original.scripts[0].id);
    check('Restore preserves saved values, cached resources and tags', restored.scripts[0].values.answer.count === 42 && restored.scripts[0].assets[0].body === file.data.userscripts.scripts[0].assets[0].body && restored.scripts[0].tags.join() === 'backup,local');
    check('Restore removes intervening custom-list changes', !(await send({ type: 'GET_STATE' })).settings.customBlockedDomains.includes('later.example'));
    await get("(document.dispatchEvent(new Event('backup-probe')),true)", live);
    await until("document.body.dataset.backupProbe==='revoked'", live);
    check('Restore revokes the old document GM capability', true);
    const off = await browse('/backup-off'); pages.push(off);
    check('Restored scripts do not run on new pages', await get("document.readyState==='complete'&&!document.body.dataset.backupAnswer", off));
    check('Ad blocking still rejects the local canary', await get("fetch('http://localhost:' + location.port + '/ad.js').then(()=>false,()=>true)", off));
    check('The restored module can be enabled explicitly', (await send({ type: 'MODULE_SET', id: 'userscripts', enabled: true })).ok);
    const restoredScript = (await send({ type: 'US_LIST' })).scripts[0];
    check('The restored script can be enabled explicitly', (await send({ type: 'US_ENABLE', id: restoredScript.id, revision: restoredScript.revision, enabled: true })).ok);
    const on = await browse('/backup-on'); pages.push(on);
    await until("document.body.dataset.backupAnswer?.includes('42')", on);
    check('An explicitly enabled restored script reads its original saved values', true);
    await shot('backup-success');
    const empty = structuredClone(file); empty.data.userscripts = { enabled: false, scripts: [] };
    await choose(JSON.stringify(empty), 'empty-backup.json');
    check('An empty backup explicitly warns that it removes the current library', await get("!document.getElementById('noScripts').hidden", backupPage));
    await click('confirmRestore', backupPage); await click('restoreBackup', backupPage);
    await until("document.getElementById('status').textContent.startsWith('Backup restored.')", backupPage);
    const emptyLibrary = await send({ type: 'US_LIST' });
    check('Restoring an empty backup removes scripts and their saved values', !emptyLibrary.enabled && emptyLibrary.scripts.length === 0 &&
      await get("(globalThis.browser||chrome).storage.local.get('userscriptManager').then(r=>r.userscriptManager.scripts.length===0)"));
    check('Backup deny proxy has no unexpected socket errors', evidence.proxyErrors.length === 0);
    const errors = b.consoleErrors ? await b.consoleErrors() : b.events.filter(event => event.method === 'Runtime.exceptionThrown').map(event => event.params.exceptionDetails);
    const unloaded = error => ['/src/blocking/content.js', '/src/blocking/generic-static.js', '/src/appearance/website-theme.js'].some(file => error.source === 'moz-extension://' + b.id + file) &&
      /^(?:Promise resolved after context unloaded|Promise rejected after context unloaded: Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved)\s*$/.test(error.text);
    evidence.backupRuntimeErrors = errors;
    check('Backup has no unexpected uncaught runtime errors', errors.filter(error => !unloaded(error)).length === 0);
    evidence.backupDownloadBytes = Buffer.byteLength(text); evidence.backupFileInput = b.send ? 'native file input' : 'File/DataTransfer fixture';
  } finally {
    for (const page of pages) await b.closePage(page).catch(() => {});
  }
}
module.exports = { runBackup };
