/* Shared native fixtures: only owned loopback URLs and locally authored scripts. */
const fs = require('node:fs/promises');
const path = require('node:path');
const files = ['manifest.json','shared.js','cosmetic.js','network.js','evidence.js','procedural.js', 'reddit.js','picker-core.js','picker.js',
  'background.js','content.js','youtube.js','popups.js','flags.js','popup.js','popup.html','popup.css','ui.css','log.html','log.js','log.css',
  'lists.html','lists.js','modules.js','userscripts-core.js', 'userscripts-network.js', 'userscripts-offscreen.js', 'userscripts-xhr.js','clipboard.html', 'clipboard.js', 'userscripts-actions.js', 'userscripts-runtime.js','manager.html','manager.js', 'userscripts-editor.js', 'userscripts-editor-worker.js', 'userscripts-lint.js', 'vendor/acorn/acorn.js', 'vendor/acorn/LICENSE','manager.css','rules','icons'];
function scriptSource(name, grants = '// @grant none\n', body = '', metadata = '') {
  return '// ==UserScript==\n// @name ' + name + '\n// @namespace offline.blockads\n// @version 1.0\n// @match http://127.0.0.1/*\n' +
    grants + metadata + '// ==/UserScript==\n' + body;
}
async function runCompatibility({ b, manager, send, check, until, browse, scriptSource, temp, evidence }) {
  const savedIds = [], pages = [];
  const install = async (name, grants, body, metadata = '', scope = '/compat/*') => {
    const source = scriptSource(name, grants.map(name => '// @grant ' + name + '\n').join(''), body, metadata)
      .replace('// @match http://127.0.0.1/*', scope === null ? '' : '// @match http://127.0.0.1' + scope);
    const saved = await send({ type: 'US_SAVE', source });
    check('Compatibility source saved: ' + name, saved.ok);
    savedIds.push(saved.selectedId);
    const script = saved.scripts.find(item => item.id === saved.selectedId);
    const enabled = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true });
    if (!enabled.ok) evidence.installFailure = { name, error: enabled.error };
    check('Compatibility source enabled: ' + name, enabled.ok);
    return script.id;
  };
  const page = async pathname => { const target = await browse(pathname); pages.push(target); return target; };
  const grants = ['GM_getValue', 'GM_setValue', 'GM_listValues', 'GM_getValues', 'GM_deleteValue', 'GM_addValueChangeListener',
    'GM_removeValueChangeListener', 'GM_registerMenuCommand', 'GM_unregisterMenuCommand', 'GM.setValues', 'GM.getValues', 'GM.deleteValues', 'GM.getValue'];
  const main = await install('Offline legacy and menus', grants, `
    const data=document.body.dataset;
    data.compatRuns=String(Number(data.compatRuns||0)+1);
    data.count=String(GM_getValue('count',0));
    data.syncRead=String(!(GM_getValue('count',0) instanceof Promise));
    const listener=GM_addValueChangeListener('count',(key,oldValue,value,remote)=>{
      data.count=String(value); data.remote=String(remote);
      data.changes=JSON.stringify([...(JSON.parse(data.changes||'[]')),{key,oldValue,value,remote}]);
    });
    GM_registerMenuCommand('Increment <local>',()=>{
      const next=GM_getValue('count',0)+1;
      data.writeReturn=String(GM_setValue('count',next));
      data.immediate=String(GM_getValue('count'));
      GM.getValue('count').then(value=>{data.persisted=String(value);});
    },{id:'increment',autoClose:false,title:'Change this script’s local value',accessKey:'i'});
    GM_registerMenuCommand('Bulk values',async()=>{
      try {
        await GM.setValues({first:1,second:false});
        data.bulk=JSON.stringify(await GM.getValues({first:0,second:true,missing:'default'}));
        await GM.deleteValues(['first','second']);
        data.bulkDeleted=String(!GM_listValues().includes('first')&&!GM_listValues().includes('second'));
      } catch(error) {data.failure=error.message;}
    },{id:'bulk',autoClose:false});
    GM_registerMenuCommand('Remove this command',()=>{
      GM_removeValueChangeListener(listener); GM_unregisterMenuCommand('remove'); data.removed='true';
    },{id:'remove',autoClose:false});
    document.addEventListener('compat-probe',()=>{GM.getValue('count').then(()=>data.probe='accepted',()=>data.probe='rejected');});
    data.compatReady='true';
  `, '// @noframes\n');
  const first = await page('/compat/a'), second = await page('/compat/b');
  for (const target of [first, second]) await until("document.body.dataset.compatReady==='true'", target);
  check('Legacy getters return values synchronously in native worlds', await b.evaluate("document.body.dataset.syncRead==='true'", first));
  check('Script globals remain isolated from the page', await b.evaluate("typeof GM==='undefined'&&typeof GM_getValue==='undefined'", first));
  check('Ad blocking remains active beside native GM scripts', await b.evaluate('window.fixtureAd===undefined', first));
  const firstTab = await b.evaluate("(globalThis.browser||chrome).tabs.query({}).then(tabs=>tabs.find(tab=>tab.url?.endsWith('/compat/a')).id)", manager);
  const menuList = () => send({ type: 'US_MENU_LIST', tabId: firstTab });
  await until('(globalThis.browser||chrome).runtime.sendMessage({type:"US_MENU_LIST",tabId:' + firstTab + '}).then(r=>r.commands?.length===3)', manager);
  check('Menus are scoped to the native page tab', (await menuList()).commands.length === 3);
  // This extension document acts as a popup for the owned fixture. The normal
  // popup is opened as a tab by the browser harness, so select that fixture ID.
  const popup = b.popup;
  await b.evaluate('(activeTabId=' + firstTab + ',activeHostname="127.0.0.1",currentDomainEl.textContent=activeHostname,renderUI(),refreshScriptCommands())', popup);
  const clickMenu = async caption => {
    await b.evaluate('refreshScriptCommands()', popup);
    const expression = '(()=>{const button=[...document.querySelectorAll("#scriptCommandList button")].find(b=>b.querySelector("span").textContent===' + JSON.stringify(caption) + ');if(!button||button.disabled)return null;button.scrollIntoView({block:"center",behavior:"instant"});const r=button.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()';
    const point = await until(expression, popup); await b.clickAt(point.x, point.y, popup);
  };
  check('Menu labels render as text', await b.evaluate('!document.querySelector("#scriptCommandList img")&&document.querySelector("#scriptCommandList").textContent.includes("<local>")', popup));
  await clickMenu('Increment <local>'); await until("document.body.dataset.persisted==='1'", first);
  await until("document.body.dataset.count==='1'", second);
  check('Legacy writes return void with immediate reads', await b.evaluate("document.body.dataset.writeReturn==='undefined'&&document.body.dataset.immediate==='1'", first));
  check('Value listener identifies its local writer', await b.evaluate("document.body.dataset.remote==='false'", first));
  check('Native cross-tab listener updates the second cache', await b.evaluate("document.body.dataset.remote==='true'", second));
  await b.evaluate('document.querySelector("#scriptCommandList button").focus()', popup);
  await b.pressKey('Tab', popup);
  check('Keyboard Tab reaches the next script command', await b.evaluate('document.activeElement.querySelector("span")?.textContent==="Bulk values"', popup));
  await b.evaluate('(()=>{window.compatibilityInput=[];["keydown","keypress","keyup","click"].forEach(type=>document.addEventListener(type,event=>window.compatibilityInput.push({type,key:event.key,code:event.code,trusted:event.isTrusted,prevented:event.defaultPrevented,target:event.target.textContent?.slice(0,100)})));})()', popup);
  await b.pressKey('Enter', popup);
  try { await until("document.body.dataset.bulkDeleted==='true'", first); }
  catch (error) {
    evidence.keyboardFailure = { dataset: await b.evaluate('({...document.body.dataset})', first),
      popup: await b.evaluate('({active:document.activeElement.outerHTML,error:document.getElementById("scriptCommandError").textContent,input:window.compatibilityInput})', popup) };
    throw error;
  }
  check('Bulk defaults and deletion work in the browser', await b.evaluate('document.body.dataset.bulk===JSON.stringify({first:1,second:false,missing:"default"})', first));
  const reloaded = await page('/compat/reload'); await until("document.body.dataset.compatReady==='true'", reloaded);
  check('New documents hydrate the latest persisted values', await b.evaluate("document.body.dataset.count==='1'", reloaded));
  await clickMenu('Remove this command'); await until("document.body.dataset.removed==='true'", first);
  await until('(globalThis.browser||chrome).runtime.sendMessage({type:"US_MENU_LIST",tabId:' + firstTab + '}).then(r=>r.commands?.length===2)', manager);
  check('Unregister removes the live menu command', (await menuList()).commands.length === 2);
  await b.evaluate('refreshScriptCommands()', popup);
  if (b.send) {
    await b.send('Emulation.setDeviceMetricsOverride', { width: 350, height: 900, deviceScaleFactor: 1, mobile: false }, popup);
    check('Menu popup fits a narrow viewport', await b.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth', popup));
    await b.screenshot(path.join(temp, 'compatibility-popup.png'));
    await b.send('ServiceWorker.enable', {}, manager);
    const version = await (async () => {
      for (let i = 0; i < 100; i++) {
        const found = b.events.filter(e => e.method === 'ServiceWorker.workerVersionUpdated').flatMap(e => e.params.versions)
          .find(v => v.scriptURL === 'chrome-extension://' + b.id + '/background.js' && v.runningStatus === 'running');
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('Owned worker not found');
    })();
    await b.send('ServiceWorker.stopWorker', { versionId: version.versionId }, manager);
    await until('(globalThis.browser||chrome).runtime.sendMessage({type:"US_MENU_LIST",tabId:' + firstTab + '}).then(r=>r.commands?.length===2)', manager);
    check('Native worker restart restores menus without rerunning source', await b.evaluate("document.body.dataset.compatRuns==='1'", first));
    // This listener was deliberately removed above; the second page still has it.
    await clickMenu('Increment <local>'); await until("document.body.dataset.persisted==='2'", first);
    await until("document.body.dataset.count==='2'", second);
    check('Value changes continue after native worker restart', await b.evaluate("document.body.dataset.remote==='true'", second));
  } else {
    await b.screenshot(path.join(temp, 'compatibility-popup.png'), popup);
  }
  const legacy = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === main);
  check('Legacy script disables successfully', (await send({ type: 'US_ENABLE', id: main, revision: legacy.revision, enabled: false })).ok);
  check('Disabling removes existing document menus', !(await menuList()).commands.length);
  await b.evaluate("document.dispatchEvent(new Event('compat-probe'))", first);
  await until("document.body.dataset.probe==='rejected'", first);
  check('Old documents lose storage access after disable', true);

  for (const [name, timing, body] of [
    ['Start', 'document-start', "document.documentElement.dataset.startMarker='compat';"],
    ['Body', 'document-body', "document.body.dataset.bodyTiming=String(!!document.body);"],
    ['End', 'document-end', "document.body.dataset.endTiming=document.readyState;"],
    ['Idle', 'document-idle', "document.body.dataset.idleTiming='true';"]
  ]) await install('Offline timing ' + name, ['none'], body, '// @run-at ' + timing + '\n', '/compat-timing');
  const timing = await page('/compat-timing');
  await until("document.body.dataset.idleTiming==='true'", timing);
  check('Native document-start precedes the fixture head script', await b.evaluate("window.startObserved==='compat'", timing));
  check('Native document-body runs once a body exists', await b.evaluate("document.body.dataset.bodyTiming==='true'", timing));
  check('Native document-end and idle run after parsing', await b.evaluate("['interactive','complete'].includes(document.body.dataset.endTiming)&&document.body.dataset.idleTiming==='true'", timing));

  const globId = await install('Offline glob union', ['none'], "document.body.dataset.glob='true';",
    '// @include http://127.0.0.1:*/compat-glob*\n// @exclude *private*\n', '/compat-match');
  for (const [route, expected] of [['/compat-glob', true], ['/COMPAT-GlOb', true], ['/compat-match', true], ['/compat-glob-private', false], ['/compat-GLOB-PRIVATE', false], ['/compat-outside', false]]) {
    const target = await page(route);
    if (expected) await until("document.body.dataset.glob==='true'", target);
    check('Native match/include union and exclusion: ' + route, await b.evaluate("(document.body.dataset.glob==='true')===" + expected, target));
  }
  const globScript = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === globId);
  check('Case-insensitive glob fixture disabled before native capacity checks', (await send({ type: 'US_ENABLE', id: globId, revision: globScript.revision, enabled: false })).ok);
  await install('Offline include-only fragment', ['none'], "document.body.dataset.includeOnly='true';",
    '// @include http://127.0.0.1:*/compat-include?mode=one#kept\n', null);
  for (const [route, expected] of [['/compat-include?mode=one#kept', true], ['/compat-include?mode=one#other', false], ['/compat-includeXmode=one#kept', false]]) {
    const target = await page(route);
    if (expected) await until("document.body.dataset.includeOnly==='true'", target);
    check('Include-only literal query/fragment: ' + route, await b.evaluate("(document.body.dataset.includeOnly==='true')===" + expected, target));
  }
  await install('Offline top frame', ['none'], "document.body.dataset.topOnly='true';", '// @noframes\n');
  const frames = await page('/compat/frames'); await until("document.querySelector('iframe')?.contentDocument?.readyState==='complete'", frames);
  check('noframes prevents child execution', await b.evaluate("document.body.dataset.topOnly==='true'&&!document.querySelector('iframe').contentDocument.body.dataset.topOnly", frames));
  const denied = await send({ type: 'US_SAVE', source: scriptSource('Unsupported directive', '// @grant none\n', '', '// @top-level-await\n') });
  check('Unsupported directives are rejected without execution', !denied.ok && /Unsupported metadata/.test(denied.error));
  for (let i = 0; i < 10; i++) await install('Offline simultaneous cache ' + i, ['GM_getValue', 'GM_registerMenuCommand'],
    'document.body.dataset.cache' + i + '=String(GM_getValue("saved",42)); GM_registerMenuCommand("Ready ' + i + '",()=>{});', '// @noframes\n', '/compat-many');
  const many = await page('/compat-many');
  try { await until('Array.from({length:10},(_,i)=>document.body.dataset["cache"+i]).every(value=>value==="42")', many); }
  catch (error) {
    evidence.simultaneousCache = { dataset: await b.evaluate('({...document.body.dataset})', many),
      registrations: await b.evaluate('(globalThis.browser||chrome).userScripts.getScripts().then(scripts=>scripts.map(({id,matches,world,worldId})=>({id,matches,world,worldId})))', manager),
      events: b.events.slice(-80) };
    throw error;
  }
  check('Ten matching legacy scripts hydrate together', true);
  const manyTab = await b.evaluate('(globalThis.browser||chrome).tabs.query({}).then(tabs=>tabs.find(tab=>tab.url?.endsWith("/compat-many")).id)', manager);
  await until('(globalThis.browser||chrome).runtime.sendMessage({type:"US_MENU_LIST",tabId:' + manyTab + '}).then(r=>r.commands?.length===10)', manager);
  check('Ten simultaneous scripts publish all menus without consuming value slots', true);
  await until('!document.getElementById("worldLimitWarning").hidden', manager);
  check('Manager explains the limit when many isolated scripts are enabled', true);
  if (b.send) {
    for (let i = 10; i < 12; i++) await install('Offline world overflow ' + i, ['GM_getValue'],
      'document.body.dataset.cache' + i + '=String(GM_getValue("saved",42));', '// @noframes\n', '/compat-many');
    const overflow = await page('/compat-many');
    await until('Array.from({length:10},(_,i)=>document.body.dataset["cache"+i]).every(value=>value==="42")', overflow);
    check('Chromium world overflow does not execute privileged script bodies', await b.evaluate('!document.body.dataset.cache10&&!document.body.dataset.cache11', overflow));
    const messages = b.events.filter(event => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
      .flatMap(event => event.params.args.map(arg => arg.description || arg.value || '')).filter(text => text.includes('10 isolated script worlds'));
    check('Chromium world exhaustion reports an actionable error', messages.length >= 2);
    evidence.worldLimit = { perDocument: 10, overflowBodiesRan: false, messages: messages.slice(-2) };
  }
  const blocker = await send({ type: 'GET_STATE' });
  check('Blocker remains enabled after compatibility exercises', blocker.ok && blocker.settings.enabled);
  check('Local ad remains blocked after compatibility exercises', await b.evaluate('window.fixtureAd===undefined', frames));
  for (const id of savedIds) {
    const script = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === id);
    check('Fixture script deleted: ' + script.metadata.name, (await send({ type: 'US_DELETE', id, revision: script.revision })).ok);
  }
  await b.evaluate('refreshScriptCommands()', popup);
  check('Enabled module has a useful empty command state', await b.evaluate('document.getElementById("scriptCommandError").textContent==="No script commands on this page."', popup));
  check('Fixture module can be paused', (await send({ type: 'MODULE_SET', id: 'userscripts', enabled: false })).ok);
  await b.evaluate('refreshScriptCommands()', popup);
  check('Disabled userscript module leaves the blocker popup uncluttered', await b.evaluate('document.getElementById("scriptCommands").hidden', popup));
  check('Fixture module can be restored', (await send({ type: 'MODULE_SET', id: 'userscripts', enabled: true })).ok);
  for (const target of pages) await b.closePage(target);
  evidence.compatibilityCompleted = true;
}
module.exports = { runCompatibility, files, scriptSource };
