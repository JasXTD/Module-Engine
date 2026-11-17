/* Native GM DOM/tab helpers on owned loopback pages only. */
async function runHelpers({ b, manager, send, check, until, browse, scriptSource, evidence }) {
  const api = '(globalThis.browser||chrome)', ids = [], pages = [];
  const tabs = () => b.evaluate(api + '.tabs.query({})', manager);
  const get = async id => (await send({ type: 'US_LIST' })).scripts.find(script => script.id === id);
  const save = async (name, metadata, body) => {
    const result = await send({ type: 'US_SAVE', source: scriptSource(name, metadata, body).replace('http://127.0.0.1/*', 'http://127.0.0.1/helper-page*') });
    check('Saved helper fixture: ' + name, result.ok); ids.push(result.selectedId);
    const script = result.scripts.find(item => item.id === result.selectedId);
    check('Enabled helper fixture: ' + name, (await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true })).ok);
    return script.id;
  };
  const body = `
    const data=document.documentElement.dataset;
    const card=GM_addElement('section',{id:'helper-card','data-literal':'<b>literal</b>',textContent:'Local helper'});
    const child=GM.addElement(card,'span',{id:'helper-span',textContent:' child'});
    const style=GM_addStyle('#helper-card {color:rgb(17, 34, 51)}');
    const root=GM_addElement(card,'div',{id:'helper-shadow'}).attachShadow({mode:'open'});
    GM.addElement(root,'span',{id:'shadow-value',textContent:'Shadow child'});
    data.elementSync=String(child.nodeType===1 && style.nodeType===1);
    child.then(element=>{data.elementThen=String(element===child && !element.then);});
    Promise.resolve(style).then(element=>{data.styleThen=String(element===style && !element.then);});
    data.invalidAttributes=String((()=>{try{GM.addElement('div',{id:123});return false;}catch{return true;}})());
    let first,second,early,last,blocked;
    document.addEventListener('helper-open',()=>{
      first=GM_openInTab('/helper-child-a',true);
      data.tabSync=String(typeof first.close==='function' && first.then===undefined && first.closed===false);
      first.onclose=()=>{data.firstClosed=String(first.closed);data.closeCount=String(Number(data.closeCount||0)+1);};
    });
    document.addEventListener('helper-close',()=>{first.close();first.close();});
    document.addEventListener('helper-modern',()=>{
      second=GM.openInTab('/helper-child-b',{active:false,insert:false,pinned:true});
      data.modernSync=String(typeof second.close==='function' && second.then===undefined);
      second.onclose=()=>data.secondClosed=String(second.closed);
    });
    document.addEventListener('helper-early',()=>{early=GM.openInTab('/helper-child-early',{active:false});early.onclose=()=>data.earlyClosed='yes';early.close();});
    document.addEventListener('helper-blocked',()=>{const url=new URL('/helper-blocked',location.href);url.hostname='localhost';blocked=GM_openInTab(url.href,true);blocked.onclose=()=>data.blockedClosed=String(blocked.closed);});
    document.addEventListener('helper-close-blocked',()=>blocked.close());
    document.addEventListener('helper-invalid',()=>{
      data.invalidUrls=String(['javascript:alert(1)','data:text/html,test','file:///private','chrome://settings'].every(url=>{try{GM.openInTab(url);return false;}catch{return true;}}));
      data.invalidOptions=String([{container:-1},{container:'1'},{tabId:7}].every(options=>{try{GM_openInTab('/never',options);return false;}catch{return true;}}));
    });
    document.addEventListener('helper-last',()=>{last=GM.openInTab('/helper-child-kept',{active:false});});
    document.addEventListener('helper-revoked',()=>{
      try{last.close();data.revokedClose='no';}catch{data.revokedClose='yes';}
      try{GM.openInTab('/helper-child-denied');data.revokedOpen='no';}catch{data.revokedOpen='yes';}
      data.lastClosed=String(last.closed);
    });
    data.helperReady='yes';
  `;
  let origin;
  try {
    const id = await save('Offline DOM and tab helpers', '// @run-at document-start\n// @grant GM_addElement\n// @grant GM.addElement\n// @grant GM_addStyle\n// @grant GM_openInTab\n// @grant GM.openInTab\n', body);
    const page = await browse('/helper-page'); pages.push(page);
    const evaluate = expression => b.evaluate(expression, page);
    const wait = expression => until(expression, page);
    const event = name => evaluate('(document.dispatchEvent(new Event(' + JSON.stringify(name) + ')),true)');
    await wait('document.documentElement.dataset.helperReady==="yes" && document.documentElement.dataset.styleThen==="true"');
    origin = await evaluate('location.origin');
    check('GM_addElement and GM.addElement return real synchronous elements at document-start', await evaluate('document.documentElement.dataset.elementSync==="true" && document.documentElement.dataset.elementThen==="true"'));
    check('DOM helpers preserve literal attributes, explicit parents and text', await evaluate('document.getElementById("helper-span").parentNode.id==="helper-card" && document.getElementById("helper-card").getAttribute("data-literal")==="<b>literal</b>" && !document.querySelector("#helper-card b")'));
    check('DOM helpers append into an explicit shadow root', await evaluate('document.getElementById("helper-shadow").shadowRoot.getElementById("shadow-value").textContent==="Shadow child"'));
    check('GM_addStyle retains CSS behavior and its one-use then callback', await evaluate('getComputedStyle(document.getElementById("helper-card")).color==="rgb(17, 34, 51)"'));
    check('Invalid element attributes fail without inserting a partial element', await evaluate('document.documentElement.dataset.invalidAttributes==="true" && !document.getElementById("123")'));
    const parent = (await tabs()).find(tab => tab.url === origin + '/helper-page');
    await event('helper-open');
    await until(api + '.tabs.query({}).then(t=>t.some(x=>x.url===' + JSON.stringify(origin + '/helper-child-a') + '))', manager);
    const first = (await tabs()).find(tab => tab.url === origin + '/helper-child-a');
    check('Legacy GM_openInTab immediately returns a handle and honors background mode', await evaluate('document.documentElement.dataset.tabSync==="true"') && !first.active);
    check('Default insertion uses the originating window and opener', first.windowId === parent.windowId && first.openerTabId === parent.id && first.index === parent.index + 1);
    await event('helper-close'); await wait('document.documentElement.dataset.firstClosed==="true"');
    check('A handle closes only its own tab and fires onclose once', !(await tabs()).some(tab => tab.id === first.id) && await evaluate('document.documentElement.dataset.closeCount==="1"'));
    await event('helper-modern');
    await until(api + '.tabs.query({}).then(t=>t.some(x=>x.url===' + JSON.stringify(origin + '/helper-child-b') + '))', manager);
    const second = (await tabs()).find(tab => tab.url === origin + '/helper-child-b');
    check('Modern GM.openInTab returns a synchronous control and supports pinned background tabs', await evaluate('document.documentElement.dataset.modernSync==="true"') && second.pinned && !second.active);
    check('insert:false does not assign the source as opener', second.openerTabId !== parent.id);
    await b.evaluate(api + '.tabs.remove(' + second.id + ')', manager);
    await wait('document.documentElement.dataset.secondClosed==="true"');
    check('Native tab removal updates closed and invokes the script callback', true);
    await event('helper-early'); await wait('document.documentElement.dataset.earlyClosed==="yes"');
    check('Closing a handle before browser creation completes leaves no child tab', !(await tabs()).some(tab => tab.url === origin + '/helper-child-early'));
    await b.evaluate(`(()=>{const api=${api};globalThis.helperTabEvents=[];
      globalThis.helperCreated=tab=>helperTabEvents.push({type:'created',tab});
      globalThis.helperRemoved=id=>helperTabEvents.push({type:'removed',id});
      globalThis.helperFailed=details=>helperTabEvents.push({type:'error',details});
      api.tabs.onCreated.addListener(helperCreated);api.tabs.onRemoved.addListener(helperRemoved);
      api.webRequest.onErrorOccurred.addListener(helperFailed,{urls:['http://localhost/*'],types:['main_frame']});
    })()`, manager);
    await event('helper-blocked');
    const failure = await until('helperTabEvents.find(e=>e.type==="error"&&e.details.url.endsWith("/helper-blocked"))?.details', manager);
    check('DNR still blocks an owned loopback destination opened through a userscript', ['net::ERR_BLOCKED_BY_CLIENT', 'NS_ERROR_ABORT'].includes(failure.error));
    // Popup cleanup tracks a tab only when its creation event names an opener, then
    // closes it asynchronously once the block is confirmed, so a tab listed right
    // after the error may be about to close. Decide from the same creation event.
    const created = await until('helperTabEvents.find(e=>e.type==="created"&&e.tab.id===' + failure.tabId + ')?.tab', manager);
    if (Number.isInteger(created.openerTabId)) {
      await until('helperTabEvents.some(e=>e.type==="removed"&&e.id===' + failure.tabId + ')', manager);
      check('Popup cleanup closes a blocked API tab that had an opener at creation', true);
    } else {
      // Chrome can publish tabs.create's onCreated event before it assigns the
      // opener. Conservative popup cleanup correctly preserves that uncertain
      // tab; its script still has an explicit, owned close capability.
      check('A blocked API tab without an opener at creation is retained', (await tabs()).some(tab => tab.id === failure.tabId));
      await event('helper-close-blocked');
    }
    await wait('document.documentElement.dataset.blockedClosed==="true"');
    check('Blocked userscript tabs report closure and keep the source tab intact', !(await tabs()).some(tab => tab.id === failure.tabId) && (await tabs()).some(tab => tab.id === parent.id));
    const count = (await tabs()).length; await event('helper-invalid');
    check('Disallowed schemes and invalid tab options are rejected before opening', await evaluate('document.documentElement.dataset.invalidUrls==="true" && document.documentElement.dataset.invalidOptions==="true"') && (await tabs()).length === count);
    await event('helper-last');
    await until(api + '.tabs.query({}).then(t=>t.some(x=>x.url===' + JSON.stringify(origin + '/helper-child-kept') + '))', manager);
    const script = await get(id);
    check('Helper script can be disabled without changing blocker state', (await send({ type: 'US_ENABLE', id, revision: script.revision, enabled: false })).ok);
    // Storage-backed native registration removal is confirmed before probing the old realm.
    await wait('(document.dispatchEvent(new Event("helper-revoked")),document.documentElement.dataset.revokedOpen==="yes")');
    check('Disable revokes close/open capabilities without pretending an existing tab closed', await evaluate('document.documentElement.dataset.revokedClose==="yes" && document.documentElement.dataset.lastClosed==="false"') && (await tabs()).some(tab => tab.url === origin + '/helper-child-kept'));
    check('The ordinary page ad canary stays blocked while helper APIs run', await evaluate('window.fixtureAd===undefined') && (await send({ type: 'GET_STATE' })).settings.enabled);
    await save('Offline helper grants absent', '// @grant none\n', 'document.documentElement.dataset.helpersAbsent=String(typeof GM_openInTab==="undefined" && typeof GM_addElement==="undefined" && !GM.openInTab && !GM.addElement);');
    const unprivileged = await browse('/helper-page-none'); pages.push(unprivileged);
    await until('document.documentElement.dataset.helpersAbsent==="true"', unprivileged);
    check('Scripts without the exact grants receive neither helper', true);
  } finally {
    evidence.helperTabEvents = await b.evaluate('globalThis.helperTabEvents||[]', manager);
    await b.evaluate(`(()=>{const api=${api};if(globalThis.helperCreated){api.tabs.onCreated.removeListener(helperCreated);api.tabs.onRemoved.removeListener(helperRemoved);api.webRequest.onErrorOccurred.removeListener(helperFailed);}})()`, manager);
    for (const id of ids) {
      const script = await get(id);
      if (script) check('Deleted helper fixture: ' + script.metadata.name, (await send({ type: 'US_DELETE', id, revision: script.revision })).ok);
    }
    if (origin) for (const tab of await tabs()) if (tab.url?.startsWith(origin + '/helper-child-')) await b.evaluate(api + '.tabs.remove(' + tab.id + ')', manager);
    for (const page of pages) await b.closePage(page);
  }
}
module.exports = { runHelpers };
