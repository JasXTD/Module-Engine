/* Owned files and real extension UI; no public sites, personal profiles or external code. */
const fs = require('node:fs/promises'), path = require('node:path');
const { createHash } = require('node:crypto');
const { createServer } = require('../development/server.cjs');
async function runDevelopment({ b, manager, send, check, until, browse, scriptSource, click, temp, evidence, select, input }) {
  const source = scriptSource('External editor fixture', '// @grant none\n', 'document.documentElement.dataset.editorOriginal="yes";');
  const raw = source.replaceAll('\n','\r\n'), file = path.join(temp, 'owned-editor.user.js');
  let helper, id; const pages = [];
  const read = async () => (await send({type:'US_LIST'})).scripts.find(script=>script.id===id);
  const draft = () => b.evaluate('document.getElementById("scriptSource").value',manager);
  const place = offset => b.evaluate('(()=>{const e=document.getElementById("scriptSource");e.focus();e.setSelectionRange('+offset+','+offset+');e.scrollTop=0;})()',manager);
  const status = text => until('document.getElementById("externalStatus").textContent.includes('+JSON.stringify(text)+')');
  const atomic = async value => { const next=path.join(temp,'next-editor.user.js');await fs.writeFile(next,value);await fs.rename(next,file); };
  async function screenshots(name) {
    if (b.send) {
      for(const width of [1280,390]) {
        await b.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false},manager);
        await b.evaluate('document.getElementById('+JSON.stringify(name==='completion'?'sourceEditor':'externalEditor')+').scrollIntoView({block:"center",behavior:"instant"})',manager);
        check(name+' fits width '+width,await b.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth',manager));
        const shot=await b.send('Page.captureScreenshot',{format:'png'},manager);await fs.writeFile(path.join(temp,name+'-'+width+'.png'),Buffer.from(shot.data,'base64'));
      }
      await b.send('Emulation.setDeviceMetricsOverride',{width:1280,height:1000,deviceScaleFactor:1,mobile:false},manager);
    } else await b.screenshot(path.join(temp,name+'-firefox.png'),manager);
  }
  try {
    evidence.externalHelperHash=createHash('sha256').update(await fs.readFile(path.join(__dirname,'../development/server.cjs'))).digest('hex');
    const saved=await send({type:'US_SAVE',source:raw});check('Saved owned CRLF file fixture',saved.ok);id=saved.selectedId;
    let script=await read();check('Enabled original file fixture',(await send({type:'US_ENABLE',id,revision:script.revision,enabled:true})).ok);
    await click('refresh');await until('!document.getElementById("refresh").disabled');await select(id);
    check('Windows line endings do not create a false unsaved draft',await b.evaluate('document.getElementById("saveScript").disabled&&document.getElementById("draftState").textContent.startsWith("Saved")',manager));
    const incomplete=source.replace('@grant none','@grant GM.setV'),caret=incomplete.indexOf('GM.setV')+7;
    await input('scriptSource',incomplete);await place(caret);await b.pressKey('Space',manager,{control:true});
    await until('!document.getElementById("sourceSuggestions").hidden');
    check('Ctrl+Space offers only matching supported GM values',await b.evaluate('document.getElementById("sourceSuggestions").textContent==="GM.setValueGM.setValues"',manager));
    await screenshots('completion');await place(caret);await click('showSuggestions');
    await b.pressKey('Enter',manager);check('Enter inserts exactly the selected metadata token',await draft()===incomplete.replace('GM.setV','GM.setValue'));
    await b.pressKey('z',manager,{control:true});check('Native Ctrl+Z undoes suggestion insertion',await draft()===incomplete);
    await b.pressKey('y',manager,{control:true});check('Native Ctrl+Y redoes suggestion insertion',await draft()===incomplete.replace('GM.setV','GM.setValue'));
    await input('scriptSource',incomplete);await place(caret);await click('showSuggestions');
    await b.evaluate('(()=>{globalThis.__completionEvents=[];globalThis.__completionProbe=new AbortController();for(const type of ["pointerdown","mousedown","blur","focus","click","scroll"]){document.addEventListener(type,event=>{if(["scriptSource","sourceSuggestions","sourceSuggestion1"].includes(event.target.id))__completionEvents.push({type,id:event.target.id,hidden:document.getElementById("sourceSuggestions").hidden,caret:document.getElementById("scriptSource").selectionStart,active:document.activeElement.id});},{capture:true,signal:__completionProbe.signal});}})()',manager);
    await click('sourceSuggestion1');
    evidence.completionPointer=await b.evaluate('({events:__completionEvents,value:document.getElementById("scriptSource").value,hidden:document.getElementById("sourceSuggestions").hidden,active:document.activeElement.id})',manager);
    await b.evaluate('__completionProbe.abort()',manager);
    check('Pointer selection inserts only its literal suggestion',await draft()===incomplete.replace('GM.setV','GM.setValues'));
    await input('scriptSource',incomplete);await place(caret);await click('showSuggestions');
    await b.pressKey('a',manager,{control:true});await b.pressKey('Escape',manager);
    check('Selecting all dismisses stale suggestions without changing source',await draft()===incomplete&&await b.evaluate('document.getElementById("sourceSuggestions").hidden',manager));
    await input('scriptSource',incomplete);await place(caret);await click('showSuggestions');await b.pressKey('ArrowDown',manager);await b.pressKey('Tab',manager);
    check('Arrow selection and Tab insert the second completion',await draft()===incomplete.replace('GM.setV','GM.setValues'));
    await input('scriptSource',incomplete);await place(caret);await click('showSuggestions');await b.pressKey('Escape',manager);
    check('Escape dismisses suggestions without changing source',await b.evaluate('document.getElementById("sourceSuggestions").hidden',manager)&&await draft()===incomplete);
    await b.pressKey('Tab',manager);check('Tab leaves the editor when suggestions are closed',await b.evaluate('document.activeElement.id!=="scriptSource"',manager));
    await place(caret);await b.evaluate('document.getElementById("scriptSource").dispatchEvent(new CompositionEvent("compositionstart"))',manager);await b.pressKey('Space',manager,{control:true});
    check('Composition state suppresses metadata suggestions',await b.evaluate('document.getElementById("sourceSuggestions").hidden',manager));
    await b.evaluate('document.getElementById("scriptSource").dispatchEvent(new CompositionEvent("compositionend"))',manager);
    await input('scriptSource',source);await place(source.length);await click('showSuggestions');
    check('Suggestions do not appear in executable script text',await b.evaluate('document.getElementById("sourceSuggestions").hidden',manager));
    await fs.writeFile(file,raw);helper=await createServer({file});
    await b.evaluate('document.getElementById("externalEditor").open=true',manager);
    await input('externalCode',helper.pairingCode);await b.evaluate('document.getElementById("externalConnect").click()',manager);
    check('Synthetic clicks cannot approve file tracking',await b.evaluate('!document.getElementById("externalCode").disabled&&document.getElementById("externalStop").disabled',manager));
    await click('externalConnect');await status('File matches the draft');
    check('Paired file starts without changing or saving the draft',await draft()===source && (await read()).source===raw);
    check('Pairing code is cleared after use',await b.evaluate('document.getElementById("externalCode").value===""',manager));
    const revision=(await read()).revision;
    const next=source.replace('dataset.editorOriginal="yes"','dataset.externalDraft="first"');
    await atomic(next.replaceAll('\n','\r\n'));await status('File changed');
    check('An atomic external save waits for explicit draft review',await draft()===source&&(await read()).revision===revision);
    const manual=source+'\n// keep my manual changes';await input('scriptSource',manual);await input('scriptTags','external-local');
    await click('externalLoad');await until('document.getElementById("confirmDialog").open');await b.pressKey('Escape',manager);
    check('Cancelling external replacement preserves unsaved edits',await draft()===manual);
    await click('externalLoad');await until('document.getElementById("confirmDialog").open');
    const latest=next.replace('"first"','"latest"');await atomic(latest);await status('File changed');
    // The old message also says "File changed"; wait for a new /read to be accepted.
    await b.evaluate('new Promise(resolve=>setTimeout(resolve,1200))',manager);
    await click('confirmAccept');await status('changed during review');
    check('A file changed during confirmation cannot replace the reviewed bytes',await draft()===manual);
    await click('externalLoad');await until('document.getElementById("confirmDialog").open');await click('confirmAccept');await status('Loaded into draft');
    check('Loading the latest file changes only the draft and preserves tags',await draft()===latest&&await b.evaluate('document.getElementById("scriptTags").value==="external-local"',manager));
    check('Loading source does not save, enable or execute it',(await read()).revision===revision&&(await read()).enabled);
    const page=await browse('/external-review');pages.push(page);await until('document.documentElement.dataset.editorOriginal==="yes"',page);
    check('Only saved code runs during review; ad blocking remains active',await b.evaluate('!document.documentElement.dataset.externalDraft&&window.fixtureAd===undefined',page));
    await b.front(manager);await screenshots('external-review');await click('saveScript');
    await until('(globalThis.browser||chrome).runtime.sendMessage({type:"US_LIST"}).then(r=>r.scripts.find(s=>s.id==='+JSON.stringify(id)+')?.source==='+JSON.stringify(latest)+')');
    script=await read();check('Explicit Save pauses the script and preserves local tags',!script.enabled&&script.tags.includes('external-local'));
    check('Saving keeps the same chosen file connected',await b.evaluate('!document.getElementById("externalStop").disabled',manager));
    await input('scriptTags','external-local, reviewed');await click('saveTags');await until('!document.getElementById("refresh").disabled');
    check('Saving local tags keeps external tracking connected',(await read()).tags.includes('reviewed')&&await b.evaluate('!document.getElementById("externalStop").disabled',manager));
    check('Helper never writes normalized editor text back to disk',await fs.readFile(file,'utf8')===latest);
    await fs.writeFile(file,Buffer.from([0xff,0xfe]));await status('UTF-8');
    check('Invalid file data preserves the saved draft and hides outdated candidate',await draft()===latest&&await b.evaluate('document.getElementById("externalLoad").hidden',manager));
    const final=latest+'\n// after saving';await atomic(final);await status('File changed');
    // A second manager or MCP-readable state can change revisions while this draft is open.
    script=await read();check('Created concurrent saved revision',(await send({type:'US_TAGS',id,revision:script.revision,tags:['other-window']})).ok);
    await until('document.getElementById("draftState").textContent.includes("changed elsewhere")');
    check('Stale editor cannot load external changes',await b.evaluate('document.getElementById("externalLoad").disabled',manager));
    await click('discardDraft');await until('document.getElementById("externalStop").disabled');
    check('Reloading a saved revision stops tracking and preserves latest saved bytes',await draft()===latest);
    await helper.close();helper=undefined;
    // A fresh session can load a draft, then Stop must preserve it.
    helper=await createServer({file});await input('externalCode',helper.pairingCode);await click('externalConnect');await status('File changed');
    await click('externalLoad');await status('Loaded into draft');await click('externalStop');
    check('Stop preserves the reviewed draft',await draft()===final);
    await fs.writeFile(file,source);await b.evaluate('new Promise(resolve=>setTimeout(resolve,1200))',manager);
    check('Stopped tracking cannot overwrite the draft after a later file save',await draft()===final);
    await input('scriptSource',latest);await click('refresh');await until('!document.getElementById("refresh").disabled');
    await helper.close();helper=await createServer({file});await input('externalCode',helper.pairingCode);await click('externalConnect');await status('File changed');
    await click('newScript');await until('document.getElementById("editorHeading").textContent==="New script"');
    check('Opening another draft disconnects the chosen file',await b.evaluate('document.getElementById("externalStop").disabled&&document.getElementById("externalLoad").hidden',manager));
    await input('scriptSource',''); // Leave no dirty fixture draft for the parent harness.
    evidence.editorDevelopmentCompleted=true;
  } finally {
    await helper?.close();
    if(id){const script=await read();if(script)await send({type:'US_DELETE',id,revision:script.revision});}
    for(const page of pages)await b.closePage(page);
  }
}
module.exports={runDevelopment};
