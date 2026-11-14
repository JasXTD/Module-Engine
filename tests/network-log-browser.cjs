/* Native metadata capture against owned loopback fixtures only. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function networkLogFixture(request, response, state) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (!url.pathname.startsWith('/net/')) return false;
  (state.networkHits ||= []).push({ path: url.pathname, method: request.method, host: request.headers.host });
  if (url.pathname === '/net/fail') { request.socket.destroy(); return true; }
  if (url.pathname === '/net/slow') { (state.networkPending ||= []).push(response); return true; }
  const headers = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', 'X-Fixture-Secret': 'private-response-header' };
  if (['/net/page','/net/other','/net/script'].includes(url.pathname)) {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><head><title>Owned network fixture</title></head><body><h1>Local network fixture</h1></body></html>');
  } else if (url.pathname === '/net/redirect') {
    response.writeHead(302, { ...headers, Location: '/net/final?private-redirect-query=yes#private-fragment' }); response.end();
  } else {
    request.resume(); response.writeHead(url.pathname === '/net/http-error' ? 418 : 201, headers);
    response.end(JSON.stringify({ fixture: true, body: 'private-response-body' }));
  }
  return true;
}
async function runNetworkLog({ b, manager, send, check, until, browse, scriptSource, evidence, temp, port, fixtureState }) {
  const base = 'http://127.0.0.1:' + port, pages = [], scriptIds = [];
  const open = async url => { const page = await b.open(url); pages.push(page); return page; };
  const close = async page => { await b.closePage(page); pages.splice(pages.indexOf(page), 1); };
  const get = (expression, page) => b.evaluate(expression, page);
  const click = async (id, page) => {
    await b.front(page);
    const point = await until(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`, page);
    await b.clickAt(point.x, point.y, page);
  };
  const field = (id, value, page) => get(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event(${JSON.stringify(id==='textFilter'?'input':'change')},{bubbles:true}));return e.value;})()`, page);
  const fetchFrom = (page, url, init = {}) => get(`fetch(${JSON.stringify(url)},${JSON.stringify(init)}).then(r=>r.text().then(()=>r.status),()=>0)`, page);
  const ready = page => until("state?.available && !busy && !reading && !document.getElementById('startCapture').disabled", page);
  const refresh = page => get('refresh()', page);
  const readRows = page => get('latest', page);
  const captureURL = await get("(globalThis.browser||chrome).runtime.getURL('src/ui/network/network.html')", manager);
  const tabId = url => get(`(globalThis.browser||chrome).tabs.query({}).then(tabs=>tabs.find(tab=>tab.url===${JSON.stringify(url)})?.id)`, manager);
  async function shot(page, name) {
    await get('(scrollTo(0,0),document.getAnimations().forEach(a=>a.finish()),true)', page);
    if (b.send) {
      const capture=await b.send('Page.captureScreenshot',{format:'png'},page);
      await fs.writeFile(path.join(temp,name+'.png'),Buffer.from(capture.data,'base64'));
    } else await b.screenshot(path.join(temp, name + '.png'), page);
  }
  let logger;
  try {
    logger = await open(captureURL); await ready(logger);
    check('Network page starts with capture off and an empty log', await get('!state.active && entries.length===0', logger));
    const page = await open(base + '/net/page'), other = await open(base + '/net/other');
    await fetchFrom(page, '/net/before'); await refresh(logger);
    check('Traffic before Start is not retained', (await readRows(logger)).length === 0);
    check('Manager links the Network page', await get("Boolean(document.querySelector('a[href=\"../network/network.html\"]'))", manager));
    await shot(logger, 'network-empty');
    check('Other extension pages cannot acquire the capture channel', await get(`new Promise(resolve=>{const p=(globalThis.browser||chrome).runtime.connect({name:'ME_NETWORK_LOG'});const timer=setTimeout(()=>{p.disconnect();resolve(false)},3000);p.onDisconnect.addListener(()=>{clearTimeout(timer);resolve(true)});p.postMessage({id:1,type:'read'});})`, manager));
    await click('startCapture', logger); await until('state.active && !busy', logger);
    check('Capture starts only after the native Start click', await get('state.ownsCapture', logger));
    await fetchFrom(page, '/net/json?private-query=yes#private-fragment');
    await fetchFrom(page, '/net/post?private-query=yes', { method: 'POST', headers: { 'X-Fixture-Secret': 'private-request-header' }, body: 'private-request-body' });
    await fetchFrom(page, '/net/redirect'); await fetchFrom(page, '/net/http-error'); await fetchFrom(page, '/net/fail');
    const blocked = await fetchFrom(page, 'http://localhost:' + port + '/net/ad.js');
    check('Ad blocker still prevents the owned localhost canary request', blocked === 0 && !fixtureState.networkHits.some(hit => hit.path === '/net/ad.js'));
    await until("latest.some(row=>row.url.endsWith('/net/post')&&row.state==='complete') && latest.some(row=>row.url.endsWith('/net/fail')&&row.state==='error')", logger);
    let rows = await readRows(logger);
    check('Native GET response has status, resource type and observed timing', rows.some(r=>r.url===base+'/net/json' && r.method==='GET' && r.statusCode===201 && r.type==='xmlhttprequest' && r.endedAt>=r.startedAt && r.startedAt!==null));
    check('Native POST metadata is captured', rows.some(r=>r.url===base+'/net/post' && r.method==='POST' && r.statusCode===201));
    const hop = rows.find(r=>r.url===base+'/net/redirect'), final = rows.find(r=>r.url===base+'/net/final');
    check('Redirect hops correlate while keeping their separate status and timing', hop?.state==='redirect' && hop.statusCode===302 && hop.redirectTo===base+'/net/final' && final?.statusCode===201 && final.requestId===hop.requestId);
    check('HTTP error statuses remain distinguishable from failed requests', rows.some(r=>r.statusCode===418 && r.state==='complete') && rows.some(r=>r.url.endsWith('/net/fail') && r.state==='error' && r.error));
    evidence.networkBlockedEvents = rows.filter(r=>r.url==='http://localhost:'+port+'/net/ad.js');
    check('Blocked events never invent status or block ownership', evidence.networkBlockedEvents.every(r=>r.state==='error' && r.statusCode===null && !('layer' in r)));
    check('Captured native data contains no query, fragment, headers or bodies', !/private-|requestHeaders|responseHeaders|requestBody/.test(JSON.stringify(rows)));
    await field('outcomeFilter', 'http-error', logger);
    check('HTTP failure filter shows only the observed 418', await get("filtered().length===1 && filtered()[0].statusCode===418 && document.querySelectorAll('#requestTable tbody tr').length===1", logger));
    await field('outcomeFilter', '', logger); await field('textFilter', '/net/json', logger);
    check('Text filtering selects the requested URL', await get("filtered().length===1 && filtered()[0].url.endsWith('/net/json')", logger));
    await get("document.querySelector('.request-url').focus()", logger); await b.pressKey('Enter', logger);
    check('Request details open using the keyboard', await get("!document.getElementById('requestDetails').hidden && document.getElementById('detailsFields').textContent.includes('Request sent')", logger));
    await click('closeDetails', logger);
    check('Closing details returns focus to the request', await get("document.activeElement.classList.contains('request-url')", logger));
    await click('exportLog', logger);
    let exported;
    for (let i=0;i<100;i++) {
      const names=await fs.readdir(path.join(temp,'exports')), name=names.find(n=>/^module-engine-network-.*\.json$/.test(n));
      // Firefox creates an empty destination while the actual download is .part.
      if(name && !names.some(n=>/\.(?:part|crdownload)$/.test(n))) {
        const data=await fs.readFile(path.join(temp,'exports',name),'utf8');
        if(data){exported=JSON.parse(data);break;}
      }
      await pause(50);
    }
    check('Native JSON export includes only filtered, sanitized metadata', exported?.entries.length===1 && exported.entries[0].url===base+'/net/json' && !/private-/.test(JSON.stringify(exported)));
    await field('textFilter', 'no-such-fixture', logger); await refresh(logger);
    check('Empty filters retain the empty state and disable Export after polling', await get("!document.getElementById('emptyState').hidden && document.getElementById('exportLog').disabled", logger));
    await field('textFilter', '', logger);
    await click('liveView', logger); const frozen = await get('entries.length', logger);
    await fetchFrom(page, '/net/paused-view');
    await until("latest.some(r=>r.url.endsWith('/net/paused-view'))", logger);
    check('Pausing Live view freezes the table while capture continues', await get(`state.active && entries.length===${frozen} && latest.length>entries.length`, logger));
    await click('liveView', logger);
    check('Resuming Live view displays captured entries', await get('entries.length===latest.length', logger));
    const grants = '// @grant GM.setValue\n// @grant GM.getValue\n// @grant GM.xmlHttpRequest\n';
    const source = scriptSource('Network capture coexistence', grants, `
      (async()=>{try{await GM.setValue('network-fixture',42);const r=await GM.xmlHttpRequest({url:location.origin+'/net/gm',method:'GET'});
      document.body.dataset.networkGM=String(await GM.getValue('network-fixture'))+':'+r.status;}catch(e){document.body.dataset.networkGM='error:'+e.message}})();`, '// @connect 127.0.0.1\n// @run-at document-end\n').replace('// @match http://127.0.0.1/*','// @match http://127.0.0.1/net/script');
    const saved = await send({type:'US_SAVE',source}); check('Coexistence userscript saves',saved.ok); scriptIds.push(saved.selectedId);
    const script=saved.scripts.find(s=>s.id===saved.selectedId);check('Coexistence userscript enables', (await send({type:'US_ENABLE',id:script.id,revision:script.revision,enabled:true})).ok);
    const scriptPage = await open(base+'/net/script');
    await until("document.body.dataset.networkGM==='42:201'",scriptPage);
    check('Native GM storage and HTTP work during capture',await get("document.body.dataset.networkGM==='42:201'",scriptPage));
    await until("latest.some(r=>r.url.endsWith('/net/gm')&&r.state==='complete')",logger);
    check('Background userscript HTTP traffic is observable in all-browser scope', (await readRows(logger)).some(r=>r.url.endsWith('/net/gm')));
    // Keep a native response in flight across Clear; completing it must not repopulate the log.
    await get("(()=>{globalThis.slowDone=false;fetch('/net/slow').then(r=>r.text()).then(()=>slowDone=true);return true;})()",page);
    await until("latest.some(r=>r.url.endsWith('/net/slow'))",logger);
    await click('clearLog',logger);await until('!busy && state.count===0',logger);
    for(const response of fixtureState.networkPending.splice(0)){response.writeHead(200);response.end('released');}
    await until('slowDone',page);await fetchFrom(page,'/net/after-clear');
    await until("latest.some(r=>r.url.endsWith('/net/after-clear')&&r.state==='complete')",logger);
    check('Clearing in-flight entries does not resurrect their late responses',!(await readRows(logger)).some(r=>r.url.endsWith('/net/slow')));
    // Populate multiple pages without fetching anything outside loopback.
    await get("Promise.all(Array.from({length:105},(_,i)=>fetch('/net/batch/'+i).then(r=>r.text())))",page);
    await until("latest.filter(r=>r.url.includes('/net/batch/')&&r.state==='complete').length===105",logger);
    check('Table paginates at 100 rows',await get("document.querySelectorAll('#requestTable tbody tr').length===100 && !document.getElementById('nextPage').disabled",logger));
    await click('nextPage',logger);check('Next page displays remaining rows',await get("document.querySelectorAll('#requestTable tbody tr').length>0 && document.querySelectorAll('#requestTable tbody tr').length<100 && !document.getElementById('previousPage').disabled",logger));
    await click('previousPage',logger);
    await click('stopCapture',logger);await ready(logger);const count=await get('state.count',logger);
    await fetchFrom(page,'/net/after-stop');await refresh(logger);
    check('Stop freezes capture despite subsequent native traffic',await get(`!state.active && state.count===${count}`,logger));
    await get("globalThis.savedNetworkRow=document.querySelector('#requestTable tbody tr')",logger);await refresh(logger);
    check('Unchanged polls preserve existing table nodes',await get("savedNetworkRow===document.querySelector('#requestTable tbody tr')",logger));
    evidence.networkEntries=await readRows(logger);
    check('Only sanitized metadata is retained in session storage',await get("(globalThis.browser||chrome).storage.session.get('moduleEngineNetworkLog').then(data=>!(/private-|requestHeaders|responseHeaders|requestBody/.test(JSON.stringify(data)))&&data.moduleEngineNetworkLog.entries.length>0)",manager));
    check('Network capture writes nothing to persistent local storage',await get("(globalThis.browser||chrome).storage.local.get(null).then(data=>!('moduleEngineNetworkLog' in data))",manager));
    await field('textFilter','/net/after-clear',logger);
    for(const scheme of ['light','dark']) {
      if(b.send) {
        await b.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]},logger);
        for(const width of [1280,390]) {
          await b.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},logger);
          check(`Network ${scheme} layout fits ${width}px`,await get('document.documentElement.scrollWidth<=document.documentElement.clientWidth',logger));
          await shot(logger,`network-${scheme}-${width}`);
        }
      } else { await b.setColorScheme(scheme);check('Firefox Network '+scheme+' layout fits',await get('document.documentElement.scrollWidth<=document.documentElement.clientWidth',logger));await shot(logger,'network-'+scheme+'-firefox'); }
    }
    if(b.send)await b.send('Emulation.clearDeviceMetricsOverride',{},logger);
    // Firefox cannot resize extension viewports; a same-origin frame exercises narrow layout.
    if(!b.send) {
      await get(`(()=>{const f=document.createElement('iframe');f.id='networkNarrow';f.src=${JSON.stringify(captureURL)};f.style='width:390px;height:1100px';document.body.append(f);})()`,manager);
      await until("document.getElementById('networkNarrow').contentDocument?.getElementById('startCapture')?.disabled===false",manager);
      check('Firefox narrow Network layout fits 390px',await get("(()=>{const d=document.getElementById('networkNarrow').contentDocument;return d.documentElement.scrollWidth<=d.documentElement.clientWidth})()",manager));
      await get("document.getElementById('networkNarrow').remove()",manager);
    }
    await field('textFilter','',logger);await click('refreshTabs',logger);
    const selected=await tabId(base+'/net/page');await field('captureScope',selected,logger);
    await click('startCapture',logger);await until('state.active && !busy',logger);
    await fetchFrom(other,'/net/other-scope');await fetchFrom(page,'/net/selected-scope');
    await until("latest.some(r=>r.url.endsWith('/net/selected-scope')&&r.state==='complete')",logger);
    check('Selected-tab capture excludes other tabs',await get(`state.tabId===${selected} && latest.every(r=>r.tabId===${selected}) && !latest.some(r=>r.url.endsWith('/net/other-scope'))`,logger));
    await field('typeFilter','xmlhttprequest',logger);await field('tabFilter',selected,logger);
    check('Tab and resource-type filters combine',await get(`filtered().length>0 && filtered().every(r=>r.tabId===${selected}&&r.type==='xmlhttprequest')`,logger));
    await close(page);await ready(logger);check('Closing the selected tab stops capture',await get("state.reason.includes('selected tab closed')",logger));
    await field('captureScope','all',logger);await click('startCapture',logger);await until('state.active && !busy',logger);
    await fetchFrom(other,'/net/owner');await until("latest.some(r=>r.url.endsWith('/net/owner')&&r.state==='complete')",logger);
    const viewer=await open(captureURL);await until('state?.active && !state.ownsCapture',viewer);
    await close(logger);logger=viewer;await ready(viewer);
    check('Closing the capturing page stops recording and retains entries for another viewer',await get("!state.active && state.reason.includes('Network page closed') && latest.some(r=>r.url.endsWith('/net/owner'))",viewer));
    await get('port.disconnect()',viewer);await refresh(viewer);
    check('A disconnected native port disables capture and stops polling',await get("disconnected && document.getElementById('startCapture').disabled && document.getElementById('captureBadge').textContent==='Disconnected'",viewer));
    await shot(viewer,'network-disconnected');
    check('Deny proxy has no unexpected socket errors during network capture',evidence.proxyErrors.length===0);
    const errors=b.consoleErrors?await b.consoleErrors():b.events.filter(e=>e.method==='Runtime.exceptionThrown').map(e=>e.params.exceptionDetails);
    evidence.networkRuntimeErrors=errors;
    const unloaded=e=>e.source==='moz-extension://'+b.id+'/src/blocking/content.js' && /^(?:Promise resolved after context unloaded|Promise rejected after context unloaded: Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved)\s*$/.test(e.text);
    check('Network capture has no unexpected uncaught runtime errors',errors.filter(e=>!unloaded(e)).length===0);
  } catch(error) {
    if(logger)evidence.networkFailure=await get('({state,entries,latest,notice:document.getElementById("notice").textContent})',logger).catch(()=>null);
    throw error;
  } finally {
    for(const response of fixtureState.networkPending||[])response.destroy();
    for(const id of scriptIds){const script=(await send({type:'US_LIST'})).scripts.find(s=>s.id===id);if(script)await send({type:'US_DELETE',id,revision:script.revision});}
    for(const page of pages)await b.closePage(page);
  }
}
module.exports={networkLogFixture,runNetworkLog};
