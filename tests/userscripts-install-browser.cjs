/* Locally authored URL installation/update fixtures; no remote script downloads. */
const fs = require('node:fs/promises'), path = require('node:path');
async function runInstallation({ b, manager, send, check, until, browse, temp, evidence, base, fixtureState }) {
  const pages = [], ids = [];
  const url = base + '/usnet/install.user.js';
  const source = (version, extra = '', body = '') => '// ==UserScript==\n// @name Offline URL install\n// @namespace module-engine-offline\n// @version ' + version +
    '\n// @match http://127.0.0.1/install-page*\n// @grant GM.getValue\n// @grant GM.setValue\n' + extra + '// ==/UserScript==\n' + body;
  const v1 = source('1.0', '// @downloadURL https://never-contacted.invalid/ignored.user.js\n',
    'GM.getValue("visits",0).then(async n=>{await GM.setValue("visits",n+1);document.body.dataset.installed="1.0";});');
  const v2 = source('1.1', '// @grant GM.addStyle\n// @match https://additional.invalid/*\n// @connect 127.0.0.1\n// @require ' + base + '/usnet/first.js\n',
    'GM.getValue("visits",0).then(n=>{document.body.dataset.installed="1.1";document.body.dataset.kept=String(n);});');
  fixtureState.sources ||= {}; fixtureState.sources['/usnet/install.user.js'] = { body: v1 };
  const front = async () => b.front ? b.front(manager) : b.send('Target.activateTarget', { targetId: manager.id });
  const click = async id => {
    await front();
    for (let attempt = 1; attempt <= 5; attempt++) {
      const point = await until(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)return null;
        e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect(),p={x:r.x+r.width/2,y:r.y+r.height/2};
        if(!r.width||!r.height||!e.contains(document.elementFromPoint(p.x,p.y)))return null;
        globalThis.__installClickProbe?.abort();const probe=new AbortController();globalThis.__installClickProbe=probe;globalThis.__installClicked=false;
        e.addEventListener('click',()=>{globalThis.__installClicked=true;probe.abort();},{capture:true,signal:probe.signal});return p;})()`, manager);
      await b.clickAt(point.x, point.y, manager);
      if (await b.evaluate('globalThis.__installClicked', manager)) return;
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
        f.onload=async()=>{const d=f.contentDocument;await Promise.all(['ui.css','manager.css'].map(name=>new Promise(loaded=>{const link=d.createElement('link');link.rel='stylesheet';link.href=new URL(name,location.href).href;link.onload=loaded;d.head.append(link);})));const original=document.getElementById('installDialog');const copy=d.importNode(original,true);copy.querySelector('#installNarrow')?.remove();copy.removeAttribute('open');d.body.append(copy);copy.showModal();resolve();};
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
    check('A metadata download URL was never requested', fixtureState.hits.filter(hit => hit.url === '/usnet/install.user.js').length === 2);
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
          .find(item => item.scriptURL === 'chrome-extension://' + b.id + '/background.js' && item.runningStatus === 'running');
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
    const other = await b.open((b.send ? 'chrome-extension://' : 'moz-extension://') + b.id + '/manager.html'); pages.push(other);
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
    check('Ad blocking remains enabled after all install/update failure paths', (await send({ type: 'GET_STATE' })).settings.enabled);
    evidence.installationCompleted = true;
  } finally {
    for (const id of ids) { const script = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === id); if (script) await send({ type: 'US_DELETE', id, revision: script.revision }); }
    for (const page of pages) await b.closePage(page);
    delete fixtureState.sources['/usnet/install.user.js'];
  }
}
module.exports = { runInstallation };
