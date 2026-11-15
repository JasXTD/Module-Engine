/* Locally authored URL installation/update fixtures; no remote script downloads. */
const fs = require('node:fs/promises'), path = require('node:path');
async function runInstallation({ b, manager, send, check, until, browse, temp, evidence, base, fixtureState }) {
  const pages = [], ids = [];
  const url = base + '/usnet/install.user.js';
  const source = (version, extra = '', body = '') => '// ==UserScript==\n// @name Offline URL install\n// @namespace module-engine-offline\n// @version ' + version +
    '\n// @match http://127.0.0.1/install-page*\n// @grant GM.getValue\n// @grant GM.setValue\n' + extra + '// ==/UserScript==\n' + body;
  const v1 = source('1.0', '',
    'GM.getValue("visits",0).then(async n=>{await GM.setValue("visits",n+1);document.body.dataset.installed="1.0";});');
  const v2 = source('1.1', '// @grant GM.addStyle\n// @match https://additional.invalid/*\n// @connect 127.0.0.1\n// @require ' + base + '/usnet/first.js\n',
    'GM.getValue("visits",0).then(n=>{document.body.dataset.installed="1.1";document.body.dataset.kept=String(n);});');
  fixtureState.sources ||= {}; fixtureState.sources['/usnet/install.user.js'] = { body: v1 };
  const front = async (target = manager) => b.front ? b.front(target) : b.send('Target.activateTarget', { targetId: target.id });
  const click = async (id, target = manager) => {
    await front(target);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const point = await until(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)return null;
        e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),p={x:r.x+r.width/2,y:r.y+r.height/2};
        if(!r.width||!r.height||!e.contains(document.elementFromPoint(p.x,p.y)))return null;
        globalThis.__installClickProbe?.abort();const probe=new AbortController();globalThis.__installClickProbe=probe;globalThis.__installClicked=false;
        e.addEventListener('click',()=>{globalThis.__installClicked=true;probe.abort();},{capture:true,signal:probe.signal});return p;})()`, target);
      await b.clickAt(point.x, point.y, target);
      if (await b.evaluate('globalThis.__installClicked', target)) return;
      (evidence.lostInstallClicks ||= []).push({ id, attempt });
    }
    throw new Error('Pointer click did not reach ' + id);
  };
  const status = () => b.evaluate('document.getElementById("installStatus").textContent', manager);
  const ready = () => until('!document.getElementById("refresh").disabled', manager);
  const dialogReady = () => until('document.getElementById("installDialog").open&&!document.getElementById("fetchSource").disabled', manager);
  const setURL = value => b.evaluate('(()=>{const e=document.getElementById("sourceURL");e.value=' + JSON.stringify(value) + ';e.dispatchEvent(new Event("input",{bubbles:true}));})()', manager);
  const openURL = async (keyboard = false) => {
    await ready(); await click('installURL'); await setURL(url);
    if (keyboard) {
      check('Install dialog focuses the URL field', await b.evaluate('document.activeElement.id==="sourceURL"', manager));
      await b.pressKey('Enter', manager);
    } else await click('fetchSource');
    await dialogReady();
  };
  const update = async () => { await ready(); await click('checkUpdate'); await dialogReady(); };
  const cancel = async () => { await click('cancelSource'); await ready(); };
  const current = async () => (await send({ type: 'US_LIST' })).scripts.find(script => script.id === ids[0]);
  const select = async () => {
    await click('refresh'); await ready();
    await b.evaluate('document.querySelector(\'.script-item[data-id="' + ids[0] + '"]\').id="installSelection"', manager);
    await click('installSelection');
  };
  const capture = async (name, width, bottom = false) => {
    if (b.send) await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
    else if (width === 390) {
      // Firefox BiDi has no viewport command in this harness. A same-origin
      // iframe exercises the actual dialog CSS at a narrow document width.
      await b.evaluate(`new Promise(resolve=>{const f=document.createElement('iframe');f.id='installNarrow';f.style='position:fixed;left:0;top:0;width:390px;height:900px;z-index:99999';
        f.onload=async()=>{const d=f.contentDocument;await Promise.all(['src/ui/shared/ui.css','src/ui/manager/manager.css'].map(name=>new Promise(loaded=>{const link=d.createElement('link');link.rel='stylesheet';link.href=(globalThis.browser||chrome).runtime.getURL(name);link.onload=loaded;d.head.append(link);})));const original=document.getElementById('installDialog');const copy=d.importNode(original,true);copy.querySelector('#installNarrow')?.remove();copy.removeAttribute('open');d.body.append(copy);copy.showModal();resolve();};
        f.src='about:blank';document.getElementById('installDialog').append(f);})`, manager);
    }
    if (b.send || width !== 390) await b.evaluate('document.getElementById("installDialog").scrollTop=' + (bottom ? 'document.getElementById("installDialog").scrollHeight' : '0'), manager);
    const metrics = await b.evaluate(`(()=>{const d=document.getElementById('installNarrow')?.contentDocument||document,dialog=[...d.querySelectorAll('#installDialog')].find(e=>e.open);
      return {width:d.documentElement.clientWidth,page:d.documentElement.scrollWidth,dialog:dialog.clientWidth,content:dialog.scrollWidth};})()`, manager);
    check('Install review has no horizontal overflow: ' + width + (bottom ? ' code' : ' access'), metrics.page <= metrics.width + 1 && metrics.content <= metrics.dialog + 1);
    (evidence.installLayouts ||= []).push(metrics);
    if (b.send) { const shot = await b.send('Page.captureScreenshot', { format: 'png' }, manager); await fs.writeFile(path.join(temp, name), Buffer.from(shot.data, 'base64')); }
    else await b.screenshot(path.join(temp, name), manager);
    if (!b.send && width === 390) await b.evaluate('document.getElementById("installNarrow").remove()', manager);
  };
  // Link interception, staged updates and @downloadURL/@updateURL. Scheduled
  // runs use the same check as Check all now; the alarm itself is verified.
  const extensionOrigin = (b.send ? 'chrome-extension://' : 'moz-extension://') + b.id;
  const linkURL = base + '/usnet/link.user.js', nextURL = base + '/usnet/link-next.user.js', metaURL = base + '/usnet/link.meta.js';
  const linked = (version, body = '') => '// ==UserScript==\n// @name Offline linked updates\n// @namespace module-engine-offline\n// @version ' + version +
    '\n// @match http://127.0.0.1/linked-page*\n// @downloadURL ' + nextURL + '\n// @updateURL ' + metaURL + '\n// @grant none\n// ==/UserScript==\n' + body;
  const hitCount = pathname => fixtureState.hits.filter(hit => hit.url === pathname).length;
  // Polls a tab across its own navigations; only navigation races are retried.
  const settle = async (expression, target, label) => {
    for (let i = 0; i < 200; i++) {
      try { if (await b.evaluate(expression, target)) return; }
      catch (error) { if (!/context|destroyed|navigat|no such|discarded|unload/i.test(error.message)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for ' + label + ': ' + await b.evaluate('location.href', target).catch(error => error.message));
  };
  const visit = async url => {
    const tab = await browse('/linked-origin'); pages.push(tab);
    await b.evaluate('location.href=' + JSON.stringify(url) + ',true', tab);
    return tab;
  };
  const closeTab = async tab => { await b.closePage(tab); pages.splice(pages.indexOf(tab), 1); };
  async function linkedUpdates() {
    fixtureState.sources['/usnet/link.user.js'] = { body: linked('1.0') };
    fixtureState.sources['/usnet/view.user.js'] = { body: '<!doctype html><title>File view</title><p id="fileView">Rendered file view</p>', mime: 'text/html; charset=utf-8' };
    check('Userscripts are on for link interception', (await send({ type: 'US_LIST' })).enabled);
    const defaults = await send({ type: 'US_UPDATE_STATE' });
    check('Link review and daily checks default to on', defaults.interceptLinks && defaults.autoCheck && !defaults.error);
    const alarm = await b.evaluate('(globalThis.browser||chrome).alarms.get("userscriptUpdateCheck")', manager);
    check('Daily checks are scheduled by an hourly alarm', alarm?.periodInMinutes === 60);
    check('Manager shows both update switches on', await b.evaluate('document.getElementById("interceptLinks").checked&&document.getElementById("autoCheck").checked', manager));

    const tab = await visit(linkURL);
    await settle('location.href.startsWith(' + JSON.stringify(extensionOrigin) + ')&&document.getElementById("installDialog")?.open&&!document.getElementById("applySource")?.disabled', tab, 'intercepted review');
    tab.extensionPage = true;
    check('A .user.js link opens a literal, read-only review in the same tab', await b.evaluate('document.getElementById("installTitle").textContent==="Install from link"&&document.getElementById("reviewAfter").readOnly&&document.getElementById("reviewAfter").value===' + JSON.stringify(linked('1.0')) + '&&!location.hash', tab));
    check('Opening a link installs nothing by itself', !(await send({ type: 'US_LIST' })).scripts.some(script => script.metadata.name === 'Offline linked updates'));
    check('The review shows the declared download and version URLs', await b.evaluate('document.getElementById("reviewChanges").textContent.includes(' + JSON.stringify('Downloads: ' + nextURL + '\nVersion check: ' + metaURL) + ')', tab));
    await click('applySource', tab);
    await settle('!document.getElementById("installDialog").open&&!document.getElementById("refresh").disabled', tab, 'install from link');
    let script = (await send({ type: 'US_LIST' })).scripts.find(item => item.metadata.name === 'Offline linked updates'); if (script) ids.push(script.id);
    check('Approval saves the linked script paused, linked to the clicked URL', script && !script.enabled && script.sourceURL === linkURL && script.source === linked('1.0'));
    await closeTab(tab);

    // The page may render briefly before interception replaces it, so wait for
    // the review's own fetch, then for the file view to return and stay.
    const viewURL = base + '/usnet/view.user.js', shown = 'document.getElementById("fileView")?.textContent==="Rendered file view"&&location.href===' + JSON.stringify(viewURL);
    const view = await visit(viewURL);
    for (let i = 0; i < 200 && hitCount('/usnet/view.user.js') < 2; i++) await new Promise(resolve => setTimeout(resolve, 50));
    await settle(shown, view, 'file view handed back');
    await new Promise(resolve => setTimeout(resolve, 700));
    check('An HTML file view is handed back to the browser after its review fetch', hitCount('/usnet/view.user.js') >= 2 && await b.evaluate(shown, view));
    await closeTab(view);

    await ready(); await click('interceptLinks'); await ready();
    check('The link switch saves its setting', !(await send({ type: 'US_UPDATE_STATE' })).interceptLinks);
    const raw = await visit(linkURL);
    await settle('location.href===' + JSON.stringify(linkURL) + '&&document.readyState==="complete"', raw, 'raw file');
    await new Promise(resolve => setTimeout(resolve, 500));
    check('With link review off, a .user.js link opens normally', await b.evaluate('location.href===' + JSON.stringify(linkURL) + '&&document.body.textContent.includes("Offline linked updates")', raw));
    await closeTab(raw);
    await click('interceptLinks'); await ready();
    check('The link switch turns back on', (await send({ type: 'US_UPDATE_STATE' })).interceptLinks);

    const next = linked('2.0', 'void "next";');
    fixtureState.sources['/usnet/link.meta.js'] = { body: '// ==UserScript==\n// @name Offline linked updates\n// @version 2.0\n// @antifeature none\n// ==/UserScript==\n' };
    fixtureState.sources['/usnet/link-next.user.js'] = { body: next };
    await click('refresh'); await ready();
    const before = fixtureState.hits.length;
    await click('checkAll');
    await until('!document.getElementById("checkAll").disabled&&document.getElementById("updateSummary").textContent.includes("ready to review")');
    const traffic = fixtureState.hits.slice(before).map(hit => hit.url);
    check('Version metadata is read from @updateURL before downloading @downloadURL', traffic.indexOf('/usnet/link.meta.js') >= 0 && traffic.indexOf('/usnet/link.meta.js') < traffic.indexOf('/usnet/link-next.user.js'));
    check('Update checks omit cookies and referrers', fixtureState.hits.slice(before).every(hit => !hit.cookie && !hit.referer));
    check('A staged update leaves the installed script unchanged', (await send({ type: 'US_LIST' })).scripts.find(item => item.id === script.id).source === linked('1.0'));
    check('The library marks the script with a pending update', await b.evaluate('Boolean(document.querySelector(\'.script-item[data-id="' + script.id + '"] .script-state.update\'))', manager));
    await b.evaluate('document.querySelector(\'.script-item[data-id="' + script.id + '"]\').id="linkedSelection"', manager);
    await click('linkedSelection');
    await until('!document.getElementById("reviewUpdate").hidden&&document.getElementById("updateResult").textContent.includes("1.0 → 2.0")');
    for (const [name, selector] of [['update-pane', '#scriptUpdates'], ['update-settings', '.update-settings']]) {
      if (b.send) for (const width of [1280, 390]) {
        await b.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, manager);
        await b.evaluate('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center",behavior:"instant"})', manager);
        const metrics = await b.evaluate('({width:document.documentElement.clientWidth,page:document.documentElement.scrollWidth})', manager);
        check('Update controls have no horizontal overflow: ' + name + ' ' + width, metrics.page <= metrics.width + 1);
        const shot = await b.send('Page.captureScreenshot', { format: 'png' }, manager);
        await fs.writeFile(path.join(temp, name + '-' + width + '.png'), Buffer.from(shot.data, 'base64'));
      } else {
        await b.evaluate('document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center",behavior:"instant"})', manager);
        await b.screenshot(path.join(temp, name + '.png'), manager);
      }
    }
    if (b.send) await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
    const hits = fixtureState.hits.length;
    await click('reviewUpdate'); await dialogReady();
    check('Review update opens the downloaded bytes without another download', /^Downloaded /.test(await status()) && fixtureState.hits.length === hits &&
      await b.evaluate('document.getElementById("reviewAfter").value===' + JSON.stringify(next) + '&&document.getElementById("applySource").textContent==="Apply update"', manager));
    await click('applySource'); await ready();
    script = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === script.id);
    check('Applying the staged update uses those bytes, pauses the script and links @downloadURL', script.source === next && !script.enabled && script.sourceURL === nextURL && fixtureState.hits.length === hits);
    check('Applying clears the pending marker', await b.evaluate('!document.querySelector(\'.script-item[data-id="' + script.id + '"] .script-state.update\')&&document.getElementById("reviewUpdate").hidden', manager));
    evidence.linkedUpdates = { traffic, alarm };
  }
  try {
    const cookie = await b.open(base + '/usnet/cookie'); pages.push(cookie);
    await openURL(true);
    check('URL fetch opens a source review without adding a script', !(await send({ type: 'US_LIST' })).scripts.some(script => script.metadata.name === 'Offline URL install'));
    check('Fetched code stays literal and read-only', await b.evaluate('document.getElementById("reviewAfter").readOnly&&document.getElementById("reviewAfter").value===' + JSON.stringify(v1), manager));
    check('Fetch omits cookies and referrer even with an existing site cookie', fixtureState.hits.filter(hit => hit.url === '/usnet/install.user.js').every(hit => !hit.cookie && !hit.referer));
    await front(); await b.pressKey('Escape', manager); await ready();
    check('Escape cancels the review and restores keyboard focus', await b.evaluate('!document.getElementById("installDialog").open&&document.activeElement.id==="installURL"', manager));
    check('Cancelling an install leaves the library unchanged', !(await send({ type: 'US_LIST' })).scripts.some(script => script.metadata.name === 'Offline URL install'));
    await openURL(); await click('applySource'); await ready();
    let script = (await send({ type: 'US_LIST' })).scripts.find(script => script.metadata.name === 'Offline URL install'); ids.push(script.id);
    check('Approval installs a paused script and remembers only the supplied URL', !script.enabled && script.source === v1 && script.sourceURL === url);
    check('Fetching for review requested only the entered URL', fixtureState.hits.filter(hit => hit.url === '/usnet/install.user.js').length === 2);
    const inactive = await browse('/install-page-before-enable'); pages.push(inactive);
    check('Installed scripts do not run before enabling', await b.evaluate('!document.body.dataset.installed&&window.fixtureAd===undefined', inactive));
    await click('scriptEnabled'); await ready();
    const first = await browse('/install-page-v1'); pages.push(first); await until('document.body.dataset.installed==="1.0"', first);
    check('Enabled URL script runs through native userScripts while the ad is blocked', await b.evaluate('window.fixtureAd===undefined', first));
    await update(); check('Identical source has no actionable update', /identical/.test(await status()) && await b.evaluate('document.getElementById("applySource").disabled', manager)); await cancel();

    fixtureState.sources['/usnet/install.user.js'].body = v2; await update();
    check('Newer version and changed site/API/dependency access are shown', /1.0 → 1.1/.test(await status()) && await b.evaluate('document.querySelectorAll("#reviewChanges .changed").length>=4', manager));
    check('Review preserves the current enabled version until approval', (await current()).enabled && (await current()).source === v1);
    for (const width of [1280, 390]) {
      await capture('install-review-' + width + '.png', width);
      if (b.send) await capture('install-code-' + width + '.png', width, true);
    }
    if (b.send) await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
    await cancel(); check('Cancelling an update retains the running version', (await current()).source === v1 && (await current()).enabled);
    await update();
    // Change the remote response after review. Approval must use those exact
    // displayed bytes, including after a real Chromium worker shutdown.
    fixtureState.sources['/usnet/install.user.js'].body = source('9.0');
    const hits = fixtureState.hits.length;
    if (b.send) {
      await b.send('ServiceWorker.enable', {}, manager);
      let version;
      for (let i = 0; i < 100 && !version; i++) {
        version = b.events.filter(event => event.method === 'ServiceWorker.workerVersionUpdated').flatMap(event => event.params.versions)
          .find(item => item.scriptURL === 'chrome-extension://' + b.id + '/src/background/background.js' && item.runningStatus === 'running');
        if (!version) await new Promise(resolve => setTimeout(resolve, 50));
      }
      check('Found the native worker before update approval', Boolean(version));
      const offset = b.events.length; await b.send('ServiceWorker.stopWorker', { versionId: version.versionId }, manager);
      let stopped = false;
      for (let i = 0; i < 100 && !stopped; i++) {
        stopped = b.events.slice(offset).some(event => event.method === 'ServiceWorker.workerVersionUpdated' && event.params.versions.some(item => item.versionId === version.versionId && item.runningStatus === 'stopped'));
        if (!stopped) await new Promise(resolve => setTimeout(resolve, 50));
      }
      check('Review stays open across a confirmed worker stop', stopped && await b.evaluate('document.getElementById("installDialog").open', manager));
    }
    await click('applySource'); await ready(); script = await current();
    check('Approval uses reviewed bytes without a second fetch and pauses the update', script.source === v2 && !script.enabled && fixtureState.hits.length === hits);
    check('New dependencies must be prepared before enabling', await b.evaluate('document.getElementById("scriptEnabled").disabled', manager));
    await click('prepareAssets'); await until('!document.getElementById("scriptEnabled").disabled');
    await click('scriptEnabled'); await ready();
    const second = await browse('/install-page-v2'); pages.push(second); await until('document.body.dataset.installed==="1.1"', second);
    check('Updated native script retains GM values and the blocker stays active', await b.evaluate('document.body.dataset.kept==="1"&&window.fixtureAd===undefined', second));

    fixtureState.sources['/usnet/install.user.js'].body = v2 + '\n// same version changed'; await update();
    check('Same-version edits are disclosed for explicit review', /without a newer version/.test(await status()));
    const other = await b.open((b.send ? 'chrome-extension://' : 'moz-extension://') + b.id + '/src/ui/manager/manager.html'); pages.push(other);
    await until('!document.getElementById("refresh").disabled', other);
    script = await current();
    const edited = await b.evaluate('(globalThis.browser||chrome).runtime.sendMessage(' + JSON.stringify({ type: 'US_SAVE', id: script.id, revision: script.revision, source: v2 + '\n// local edit' }) + ')', other);
    check('A second manager can edit while review is open', edited.ok);
    await until('document.getElementById("applySource").disabled&&document.getElementById("installStatus").textContent.includes("changed in another window")', manager);
    check('Stale review disables approval instead of overwriting the other edit', true);
    await until('!document.getElementById("refresh").disabled', other); await b.closePage(other); pages.splice(pages.indexOf(other), 1);
    await cancel(); await select();
    fixtureState.sources['/usnet/install.user.js'].body = source('0.9'); await update();
    check('Downgrades are visible and cannot be applied', /older/.test(await status()) && await b.evaluate('document.getElementById("applySource").disabled', manager)); await cancel();
    fixtureState.sources['/usnet/install.user.js'].body = source('2.0').replace('@name Offline URL install', '@name Different identity'); await update();
    check('An update cannot change script identity', /@name or @namespace/.test(await status())); await cancel();
    fixtureState.sources['/usnet/install.user.js'] = { body: '<h1>Not JavaScript</h1>', mime: 'text/html' }; await update();
    check('HTML download errors remain visible in the review dialog', /HTML/.test(await status())); await cancel();
    fixtureState.sources['/usnet/install.user.js'] = { body: v2, delay: 10000 };
    await ready(); await click('checkUpdate'); await until('document.getElementById("cancelSource").textContent==="Cancel download"');
    await cancel(); check('Cancelling a slow source fetch restores manager controls', await b.evaluate('!document.getElementById("installDialog").open&&!document.getElementById("blockingEnabled").disabled', manager));
    fixtureState.sources['/usnet/install.user.js'] = { body: v2 };
    await openURL();
    check('Reinstalling an existing identity reviews replacement without duplicating it', await b.evaluate('!document.getElementById("previousCode").hidden&&document.getElementById("applySource").textContent==="Apply update"', manager));
    await setURL(base + '/usnet/other.user.js');
    check('Changing the entered URL invalidates its earlier review', await b.evaluate('document.getElementById("installReview").hidden&&document.getElementById("applySource").disabled', manager));
    await cancel();
    await linkedUpdates();
    check('Ad blocking remains enabled after all install/update failure paths', (await send({ type: 'GET_STATE' })).settings.enabled);
    evidence.installationCompleted = true;
  } finally {
    for (const id of ids) { const script = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === id); if (script) await send({ type: 'US_DELETE', id, revision: script.revision }); }
    for (const page of pages) await b.closePage(page);
    await send({ type: 'US_UPDATE_SETTINGS', settings: { interceptLinks: true, autoCheck: true } }).catch(() => {});
    for (const name of ['install', 'link', 'link-next', 'view']) delete fixtureState.sources['/usnet/' + name + '.user.js'];
    delete fixtureState.sources['/usnet/link.meta.js'];
  }
}
module.exports = { runInstallation };
