/* Owned desktop helper fixtures. Clipboard writes are intercepted at execCommand;
 * actual browser downloads go only into this run's disposable directory. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const bytes = Buffer.from([0, 1, 127, 128, 255]);
const hash = data => createHash('sha256').update(data).digest('hex');
const { transferFixture, runTransfers } = require('./userscripts-transfer-browser.cjs');
async function installClipboardSink(extension, evidence) {
  const capture = `/* OFFLINE TEST ONLY: never invoke the operating system clipboard. */
if (typeof document !== 'undefined') document.execCommand = command => {
  if (command !== 'copy') throw new Error('Unexpected clipboard command');
  if (!document.queryCommandEnabled('copy')) throw new Error('Native copy command is disabled before the isolated clipboard write.');
  const copied = {}, event = new Event('copy', {cancelable:true});
  Object.defineProperty(event, 'clipboardData', {value:{setData:(type,data)=>{copied[type]=data;}}});
  document.dispatchEvent(event);
  const api=globalThis.browser||chrome;
  if(api.storage) globalThis.__offlineCopyTail=(globalThis.__offlineCopyTail||Promise.resolve()).then(async()=>{
    const value=await api.storage.local.get('__offlineClipboard');await api.storage.local.set({__offlineClipboard:[...(value.__offlineClipboard||[]),copied]});});
  else void api.runtime.sendMessage({type:'OFFLINE_CLIPBOARD_CAPTURE',copied});
  return event.defaultPrevented;
};
`;
  const listener = `/* OFFLINE TEST ONLY: sink for the disposable clipboard document. */
(() => { const api=globalThis.browser||chrome; let tail=Promise.resolve();
api.runtime.onMessage.addListener((message,sender) => {
  if(message?.type!=='OFFLINE_CLIPBOARD_CAPTURE'||sender.id!==api.runtime.id||sender.tab)return false;
  tail=tail.then(async()=>{const value=await api.storage.local.get('__offlineClipboard');
    await api.storage.local.set({__offlineClipboard:[...(value.__offlineClipboard||[]),message.copied]});});
  return false;
}); })();
`;
  for (const [name, prefix] of [['src/userscripts/clipboard.js', capture], ['src/background/background.js', listener]]) {
    const file = path.join(extension, name), original = await fs.readFile(file), fixture = Buffer.concat([Buffer.from(prefix), original]);
    await fs.writeFile(file, fixture);
    (evidence.fixtureOverrides ||= {})[name] = { sourceHash: hash(original), fixtureHash: hash(fixture), reason: 'Intercept clipboard writes without changing native permissions or the userscript bridge.' };
  }
}

async function runDesktop({ b, manager, send, check, until, browse, scriptSource, evidence, temp, base, fixtureState, click }) {
  const api = '(globalThis.browser||chrome)', ids = [], pages = [];
  const permissions = ['clipboardWrite', 'notifications', 'downloads', ...(evidence.browser === 'firefox' ? ['webRequestBlocking'] : ['offscreen'])];
  const get = async id => (await send({ type: 'US_LIST' })).scripts.find(script => script.id === id);
  const body = `
    const d=document.documentElement.dataset;
    const fail=error=>{d.desktopError=error.message;};
    let notification, legacyNotification, pending;
    document.addEventListener('desktop-denied',()=>{
      Promise.all([GM.setClipboard('denied').then(()=>false,()=>true),GM.download('/usnet/bytes.bin','denied.bin').then(()=>false,()=>true)])
        .then(results=>{d.denied=String(results.every(Boolean));}).catch(fail);
    });
    document.addEventListener('desktop-copy',()=>{
      d.clipboardLegacy=String(GM_setClipboard('Module Engine offline fixture')===undefined);
      GM.setClipboard('<b>literal offline HTML</b>','html').then(()=>GM.setClipboard('')).then(()=>{d.copied='yes';},fail);
    });
    document.addEventListener('desktop-notify',()=>{
      notification=GM.notification({text:'Harmless local test; removed automatically.',title:'Offline fixture',silent:true,ondone:()=>{d.done=String(Number(d.done||0)+1);}});
      d.notificationSync=String(typeof notification.remove==='function'&&notification.then===undefined);
    });
    document.addEventListener('desktop-remove',()=>notification.remove().then(()=>{d.removed='yes';},fail));
    document.addEventListener('desktop-legacy-notify',()=>{
      legacyNotification=GM_notification({text:'Legacy offline fixture',silent:true,ondone:()=>{d.legacyDone='yes';}});
      d.legacyNotification=String(typeof legacyNotification.remove==='function'&&legacyNotification.then===undefined);
    });
    document.addEventListener('desktop-remove-legacy',()=>legacyNotification.remove().then(()=>{d.legacyRemoved='yes';},fail));
    document.addEventListener('desktop-download',()=>{
      const promise=GM.download({url:'/usnet/bytes.bin',name:'desktop-modern.bin',anonymous:true});
      d.downloadPromise=String(typeof promise.then==='function'&&typeof promise.abort==='function');
      promise.then(async result=>{d.downloadBytes=JSON.stringify([...new Uint8Array(await result.response.arrayBuffer())]);},fail);
    });
    document.addEventListener('desktop-legacy-download',()=>{
      const handle=GM_download({url:'/usnet/bytes.bin',name:'desktop-legacy.bin',anonymous:true,onload:()=>{d.legacyDownloaded='yes';},onerror:fail});
      d.downloadLegacy=String(typeof handle.abort==='function'&&handle.then===undefined);
    });
    document.addEventListener('desktop-download-again',()=>GM.download('/usnet/bytes.bin','desktop-modern.bin').then(()=>{d.downloadAgain='yes';},fail));
    document.addEventListener('desktop-overwrite',()=>GM.download({url:'/usnet/bytes.bin',name:'desktop-overwrite.bin',conflictAction:'overwrite'})
      .then(()=>GM.download({url:'/usnet/json?overwrite',name:'desktop-overwrite.bin',conflictAction:'overwrite',user:'desktop',password:'secret'}))
      .then(()=>{d.overwritten='yes';},fail));
    document.addEventListener('desktop-prompt',()=>GM.download({url:'/usnet/bytes.bin',name:'desktop-prompt.bin',conflictAction:'prompt'})
      .then(()=>{d.prompted='saved';},error=>{d.prompted='rejected: '+error.message;}));
    document.addEventListener('desktop-abort',()=>{
      const handle=GM_download({url:'/usnet/slow?desktop-abort',name:'must-not-exist.bin',onabort:()=>{d.aborted=String(Number(d.aborted||0)+1);},onerror:fail});
      document.addEventListener('desktop-abort-now',()=>{handle.abort();handle.abort();},{once:true});
    });
    document.addEventListener('desktop-invalid',()=>{
      d.badFilename=String((()=>{try{GM_download('/usnet/bytes.bin','../escape.bin');return false;}catch{return true;}})());
      Promise.all(['missing','redirect','oversize'].map(name=>GM.download({url:'/usnet/'+name,name:name+'.bin',redirect:'error'}).then(()=>false,()=>true)))
        .then(results=>{d.invalidDownloads=String(results.every(Boolean));}).catch(fail);
    });
    document.addEventListener('desktop-revoke-download',()=>{
      pending=GM.download('/usnet/slow?desktop-revoke','revoked.bin');pending.then(()=>{d.revokedDownload='accepted';},()=>{d.revokedDownload='rejected';});
    });
    document.addEventListener('desktop-permission-probe',()=>GM.download('/usnet/bytes.bin','revoked-permission.bin').then(()=>{d.deniedAgain='no';},()=>{d.deniedAgain='yes';}));
    d.desktopReady='yes';
  `;
  const source = scriptSource('Desktop helper offline fixture', ['setClipboard','notification','download'].flatMap(name => ['// @grant GM_'+name,'// @grant GM.'+name]).join('\n')+'\n// @grant GM.xmlHttpRequest\n', body + '\n(' + transferFixture.toString() + ')(GM);', '// @connect 127.0.0.1\n// @noframes\n')
    .replace('http://127.0.0.1/*', 'http://127.0.0.1/desktop-page*');
  const event = (name, page) => b.evaluate('document.dispatchEvent(new Event('+JSON.stringify(name)+'))', page);
  const readCopies = () => b.evaluate(api+'.storage.local.get("__offlineClipboard").then(r=>r.__offlineClipboard||[])', manager);
  const notifications = () => b.evaluate(api+'.notifications.getAll().then(r=>Object.keys(r).filter(id=>id.startsWith("me-us-")))', manager);
  try {
    check('Desktop helper permissions are optional and initially absent', !(await b.evaluate(api+'.permissions.contains({permissions:'+JSON.stringify(permissions)+'})',manager)));
    let result = await send({type:'US_SAVE',source}); check('Desktop helper fixture is saved disabled', result.ok); ids.push(result.selectedId);
    let script = await get(result.selectedId);
    check('Desktop helper fixture enables with exact grants', (await send({type:'US_ENABLE',id:script.id,revision:script.revision,enabled:true})).ok);
    const page = await browse('/desktop-page'); pages.push(page); await until('document.documentElement.dataset.desktopReady',page);
    await event('desktop-denied',page); await until('document.documentElement.dataset.denied',page);
    check('Missing native permissions reject helpers without clipboard writes or files', await b.evaluate('document.documentElement.dataset.denied==="true"',page) && (await readCopies()).length===0);
    await click('refresh');
    await until('!document.getElementById("refresh").disabled');
    await b.evaluate('document.querySelector('+JSON.stringify('button[data-id="'+script.id+'"]')+').id="selectDesktopFixture"',manager);
    await click('selectDesktopFixture');
    check('Manager explains helper access before granting it', await until('!document.getElementById("helperAccess").hidden&&!document.getElementById("grantHelpers").hidden'));
    if(evidence.browser!=='firefox') {
      for(const width of [1280,390]) {
        await b.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},manager);
        check('Helper permission panel fits width '+width,await b.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth&&document.getElementById("helperAccess").getBoundingClientRect().right<=innerWidth',manager));
        const height=await b.evaluate('document.documentElement.scrollHeight+1',manager);
        await b.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false},manager);
        const shot=await b.send('Page.captureScreenshot',{format:'png'},manager);
        await fs.writeFile(path.join(temp,'helper-permissions-'+width+'.png'),Buffer.from(shot.data,'base64'));
      }
      await b.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false},manager);
    } else await b.screenshot(path.join(temp,'helper-permissions.png'),manager);
    await click('grantHelpers');
    if(evidence.browser!=='firefox'&&process.argv.includes('--native-helper-prompt')) {
      console.log(JSON.stringify({awaiting:'Native helper permission prompt in disposable '+evidence.browser,profile:path.join(temp,'profile'),extensionId:await b.evaluate(api+'.runtime.id',manager)}));
      const deadline=Date.now()+300000;
      while(Date.now()<deadline&&!await b.evaluate(api+'.permissions.contains({permissions:'+JSON.stringify(permissions)+'})',manager))await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(evidence.browser==='firefox') for(let i=0;i<100;i++) {
      if(await b.evaluate(api+'.permissions.contains({permissions:'+JSON.stringify(permissions)+'})',manager))break;
      const prompt=await b.userscriptPermissionPrompt(true,'helpers'); evidence.helperPermissionPrompt=prompt;
      if(prompt.accepted)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await until(api+'.permissions.contains({permissions:'+JSON.stringify(permissions)+'})');
    check('Manager button grants native helper permissions', true);
    await event('desktop-copy',page); await until('document.documentElement.dataset.copied||document.documentElement.dataset.desktopError',page);
    check('Both clipboard spellings complete through the native bridge', await b.evaluate('document.documentElement.dataset.copied==="yes"&&document.documentElement.dataset.clipboardLegacy==="true"&&!document.documentElement.dataset.desktopError',page));
    await until(api+'.storage.local.get("__offlineClipboard").then(r=>r.__offlineClipboard?.length===3)');
    evidence.clipboardSink=await readCopies();
    check('Clipboard sink receives literal text, HTML and empty text in order', JSON.stringify(evidence.clipboardSink)===JSON.stringify([{'text/plain':'Module Engine offline fixture'},{'text/html':'<b>literal offline HTML</b>'},{'text/plain':''}]));
    await event('desktop-notify',page); await until(api+'.notifications.getAll().then(r=>Object.keys(r).some(id=>id.startsWith("me-us-")))');
    check('Native notification is visible to the browser and returns an immediate handle', (await notifications()).length===1 && await b.evaluate('document.documentElement.dataset.notificationSync==="true"',page));
    await event('desktop-remove',page); await until('document.documentElement.dataset.removed',page);
    check('Notification removal clears the native object and invokes ondone once', (await notifications()).length===0 && await b.evaluate('document.documentElement.dataset.done==="1"',page));
    await event('desktop-legacy-notify',page); await until(api+'.notifications.getAll().then(r=>Object.keys(r).some(id=>id.startsWith("me-us-")))');
    await event('desktop-remove-legacy',page); await until('document.documentElement.dataset.legacyRemoved',page);
    check('Legacy notification has the same owned remove lifecycle', (await notifications()).length===0 && await b.evaluate('document.documentElement.dataset.legacyDone==="yes"&&document.documentElement.dataset.legacyNotification==="true"',page));
    await event('desktop-download',page); await until('document.documentElement.dataset.downloadBytes||document.documentElement.dataset.desktopError',page);
    check('Modern download resolves after native completion with unchanged bytes', await b.evaluate('document.documentElement.dataset.downloadBytes==="[0,1,127,128,255]"&&document.documentElement.dataset.downloadPromise==="true"&&!document.documentElement.dataset.desktopError',page));
    await event('desktop-legacy-download',page); await until('document.documentElement.dataset.legacyDownloaded||document.documentElement.dataset.desktopError',page);
    check('Legacy download callbacks complete through the native download API', await b.evaluate('document.documentElement.dataset.legacyDownloaded==="yes"&&document.documentElement.dataset.downloadLegacy==="true"&&!document.documentElement.dataset.desktopError',page));
    await event('desktop-download-again',page); await until('document.documentElement.dataset.downloadAgain||document.documentElement.dataset.desktopError',page);
    const records = await b.evaluate(api+'.downloads.search({}).then(items=>items.filter(item=>/desktop-(modern|legacy)/.test(item.filename)).map(({filename,state,exists})=>({filename,state,exists})))',manager);
    evidence.desktopDownloads=[];
    for(const record of records){
      check('Native fixture file stays in the disposable output directory', path.dirname(record.filename).toLowerCase()===path.join(temp,'exports').toLowerCase());
      const content=await fs.readFile(record.filename);
      check('Native fixture file has the exact harmless bytes', content.equals(bytes)&&record.state==='complete'&&record.exists);
      evidence.desktopDownloads.push({...record,sha256:hash(content)});
    }
    check('Repeated filename uses a separate file without overwriting', records.length===3 && new Set(records.map(record=>record.filename)).size===3);
    const extraSaved=[];
    await event('desktop-overwrite',page); await until('document.documentElement.dataset.overwritten||document.documentElement.dataset.desktopError',page);
    const overwrites=await b.evaluate(api+'.downloads.search({}).then(items=>items.filter(item=>/desktop-overwrite/.test(item.filename)).map(({filename,state})=>({filename,state})))',manager);
    const overwriteFiles=(await fs.readdir(path.join(temp,'exports'))).filter(name=>name.startsWith('desktop-overwrite'));
    const overwritten=overwriteFiles.length===1?JSON.parse(await fs.readFile(path.join(temp,'exports',overwriteFiles[0]),'utf8')):null;
    evidence.desktopOverwrite={records:overwrites,files:overwriteFiles,authorization:overwritten?.authorization};
    check('conflictAction overwrite replaces the same file with the newer download', overwrites.length===2&&overwrites.every(record=>record.state==='complete')&&
      new Set(overwrites.map(record=>record.filename)).size===1&&overwriteFiles.join()==='desktop-overwrite.bin'&&overwritten?.value===42);
    check('Download credentials reach the server as Basic authentication', overwritten?.authorization==='Basic ZGVza3RvcDpzZWNyZXQ=');
    extraSaved.push(...overwriteFiles);
    const hitsBeforePrompt=fixtureState.hits.length;
    await event('desktop-prompt',page); await until('document.documentElement.dataset.prompted',page);
    const prompted=await b.evaluate('document.documentElement.dataset.prompted',page);
    evidence.desktopPrompt=prompted;
    if(evidence.browser==='firefox') {
      check('Firefox rejects conflictAction prompt before transferring', /^rejected: Firefox does not support conflictAction "prompt"/.test(prompted)&&fixtureState.hits.length===hitsBeforePrompt);
      // Confirm the early rejection matches Firefox's own downloads API.
      evidence.firefoxNativePrompt=await b.evaluate('(async()=>{const url=URL.createObjectURL(new Blob(["probe"]));try{const id=await browser.downloads.download({url,filename:"native-prompt-probe.bin",conflictAction:"prompt"});'+
        'await browser.downloads.cancel(id).catch(()=>{});await browser.downloads.removeFile(id).catch(()=>{});return "accepted";}catch(error){return "rejected: "+error.message;}finally{URL.revokeObjectURL(url);}})()',manager);
      check('Firefox’s native downloads API also rejects conflictAction prompt', /^rejected/.test(evidence.firefoxNativePrompt));
    } else {
      check('conflictAction prompt saves a new filename without a dialog', prompted==='saved');
      extraSaved.push('desktop-prompt.bin');
    }
    const transferFile = await runTransfers({ b, page, check, until, base, fixtureState, temp, evidence });
    const beforeAborts=fixtureState.aborted;
    await event('desktop-abort',page);
    for(let i=0;i<160&&!fixtureState.hits.some(hit=>hit.url.includes('desktop-abort'));i++)await new Promise(resolve=>setTimeout(resolve,25));
    check('Download cancellation exercises an active loopback request',fixtureState.hits.some(hit=>hit.url.includes('desktop-abort')));
    await event('desktop-abort-now',page); await until('document.documentElement.dataset.aborted',page);
    for(let i=0;i<160&&fixtureState.aborted===beforeAborts;i++)await new Promise(resolve=>setTimeout(resolve,25));
    check('Aborting a download closes transport and calls onabort once',fixtureState.aborted>beforeAborts&&await b.evaluate('document.documentElement.dataset.aborted==="1"',page));
    await event('desktop-invalid',page); await until('document.documentElement.dataset.invalidDownloads',page);
    check('Invalid filenames, HTTP errors, redirects and oversized files are rejected',await b.evaluate('document.documentElement.dataset.badFilename==="true"&&document.documentElement.dataset.invalidDownloads==="true"',page));
    await event('desktop-revoke-download',page);
    for(let i=0;i<160&&!fixtureState.hits.some(hit=>hit.url.includes('desktop-revoke'));i++)await new Promise(resolve=>setTimeout(resolve,25));
    check('Revocation exercises an active owned request',fixtureState.hits.some(hit=>hit.url.includes('desktop-revoke')));
    await b.evaluate(api+'.permissions.remove({permissions:["downloads"]})',manager);
    await until('document.documentElement.dataset.revokedDownload',page);
    await event('desktop-permission-probe',page); await until('document.documentElement.dataset.deniedAgain',page);
    check('Native permission revocation cancels downloads and denies new ones',await b.evaluate('document.documentElement.dataset.revokedDownload==="rejected"&&document.documentElement.dataset.deniedAgain==="yes"',page));
    const savedNames=new Set([...records.map(record=>path.basename(record.filename)), transferFile, ...extraSaved]), finalNames=await fs.readdir(path.join(temp,'exports'));
    check('Failed and cancelled downloads leave no output files',finalNames.length===savedNames.size&&finalNames.every(name=>savedNames.has(name)));
    check('Ad blocking stays active throughout desktop helpers and revocation',(await send({type:'GET_STATE'})).settings.enabled&&await b.evaluate('window.fixtureAd===undefined',page));
    check('Desktop fixture reports no unexpected failures',!await b.evaluate('document.documentElement.dataset.desktopError',page));
    evidence.desktopFixture={base,clipboard:'execCommand test sink; OS clipboard untouched',notifications:'native create/getAll/clear; clicks covered in unit fixtures',downloads:'native files, never opened or executed'};
  } catch(error) {
    evidence.desktopFailure={error:error.message,permissions:await b.evaluate(api+'.permissions.getAll()',manager),
      ui:await b.evaluate('({status:document.getElementById("status").textContent,busy:document.getElementById("refresh").disabled,helper:document.getElementById("helperAccess").innerText})',manager),
      pages:await Promise.all(pages.map(page=>b.evaluate('({...document.documentElement.dataset})',page)))};
    throw error;
  } finally {
    for(const page of pages)await b.closePage(page);
    for(const id of ids){const script=await get(id);if(script)await send({type:'US_DELETE',id,revision:script.revision});}
  }
}
module.exports={installClipboardSink,runDesktop};
