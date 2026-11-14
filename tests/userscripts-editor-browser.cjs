/* Native ordering, editor diagnostics and local organization on owned pages. */
const fs = require('node:fs/promises'), path = require('node:path');
async function runEditor({ b, manager, send, check, until, browse, scriptSource, click, temp, evidence }) {
  const ids = [], pages = [], api = '(globalThis.browser||chrome)';
  const read = async id => (await send({ type: 'US_LIST' })).scripts.find(script => script.id === id);
  const input = (id, value) => b.evaluate('(()=>{const el=document.getElementById(' + JSON.stringify(id) + ');el.value=' + JSON.stringify(value) + ';el.dispatchEvent(new Event("input",{bubbles:true}));})()', manager);
  const select = async id => {
    const selector = JSON.stringify('button[data-id="' + id + '"]');
    await b.front(manager);
    // A refresh can replace the list between pointer-down and pointer-up.
    // Confirm selection before typing; retain lost clicks instead of hiding them.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until('(()=>{const el=document.querySelector('+selector+');if(!el||el.disabled)return false;el.scrollIntoView({block:"center",behavior:"instant"});return true;})()');
      await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))', manager);
      const point = await until('(()=>{const el=document.querySelector('+selector+');if(!el||el.disabled)return null;const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return r.width&&r.height&&el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()');
      await b.clickAt(point.x, point.y, manager);
      if (await b.evaluate('new Promise(resolve=>requestAnimationFrame(()=>resolve(document.querySelector('+selector+')?.getAttribute("aria-pressed")==="true")))', manager)) return;
      (evidence.lostSelections ||= []).push({ id, attempt });
    }
    throw new Error('Pointer clicks did not select editor fixture ' + id);
  };
  try {
    for (const name of ['A','B','C']) {
      const source = scriptSource('Editor fixture ' + name, '// @grant none\n', 'document.documentElement.dataset.execOrder=(document.documentElement.dataset.execOrder||"")+' + JSON.stringify(name) + ';',
        '// @run-at document-start\n' + (name === 'A' ? '// @tag author\n' : '')).replace('http://127.0.0.1/*', 'http://127.0.0.1/order-*');
      const result = await send({ type: 'US_SAVE', source }); check('Saved ordered fixture ' + name, result.ok); ids.push(result.selectedId);
      const script = await read(result.selectedId); check('Enabled ordered fixture ' + name, (await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true })).ok);
    }
    await click('refresh'); await until('!document.getElementById("refresh").disabled');
    await select(ids[0]);
    await until('document.getElementById("syntaxStatus").textContent.startsWith("No syntax errors")');
    check('Bundled worker highlights metadata and JavaScript', await b.evaluate('document.querySelectorAll("#sourceHighlight .syntax-comment").length>0&&document.querySelectorAll("#sourceHighlight .syntax-string").length>0', manager));
    const original = (await read(ids[0])).source;
    const invalid = original + '\nconst broken = ;';
    await input('scriptSource', invalid); await until('document.getElementById("scriptSource").getAttribute("aria-invalid")==="true"');
    await click('syntaxJump');
    check('Inline diagnostic focuses the exact failing source character', await b.evaluate('document.activeElement.id==="scriptSource"&&document.getElementById("scriptSource").selectionStart===' + invalid.lastIndexOf(';'), manager));
    await input('scriptSource', original + '\nconst markup="<img src=x onerror=alert(1)>";');
    await until('document.getElementById("syntaxStatus").textContent.startsWith("No syntax errors")');
    check('Highlighted source is text and cannot create HTML elements', await b.evaluate('!document.querySelector("#sourceHighlight img")&&document.getElementById("sourceHighlight").textContent.includes("<img")', manager));
    await input('scriptSource', original); await until('document.getElementById("syntaxStatus").textContent.startsWith("No syntax errors")');
    await input('scriptTags', 'reading, <literal>'); await click('saveTags');
    await until(api + '.runtime.sendMessage({type:"US_LIST"}).then(r=>r.scripts[0].tags.includes("reading"))');
    check('Saving tags keeps the script enabled', (await read(ids[0])).enabled);
    await input('searchScripts', '<literal>'); check('Search includes local tags', await b.evaluate('document.querySelectorAll("#scriptList li").length===1', manager));
    await input('searchScripts', '');
    await b.evaluate('(()=>{document.getElementById("tagFilter").value="author";document.getElementById("tagFilter").dispatchEvent(new Event("change"));})()', manager);
    check('Tag filter includes author metadata tags', await b.evaluate('document.querySelectorAll("#scriptList li").length===1', manager));
    await b.evaluate('(()=>{document.getElementById("tagFilter").value="";document.getElementById("tagFilter").dispatchEvent(new Event("change"));})()', manager);
    if (b.send) {
      for (const width of [1280,390]) {
        await b.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, manager);
        check('Editor layout fits width ' + width, await b.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth&&document.getElementById("sourceEditor").getBoundingClientRect().right<=innerWidth', manager));
        check('Editor input and highlighting have equal height at ' + width, await b.evaluate('Math.abs(document.getElementById("scriptSource").getBoundingClientRect().height-document.getElementById("sourceHighlight").getBoundingClientRect().height)<2', manager));
        await b.evaluate('document.getElementById("organization").scrollIntoView({block:"start",behavior:"instant"})', manager);
        const shot = await b.send('Page.captureScreenshot', { format: 'png' }, manager); await fs.writeFile(path.join(temp, 'editor-' + width + '.png'), Buffer.from(shot.data,'base64'));
      }
      await b.send('Emulation.setDeviceMetricsOverride', { width:1280,height:1000,deviceScaleFactor:1,mobile:false },manager);
      await input('scriptSource', invalid); await until('document.getElementById("scriptSource").getAttribute("aria-invalid")==="true"');
      await click('syntaxJump');
      for (const scheme of ['light', 'dark']) {
        await b.send('Emulation.setEmulatedMedia', { features: [{name:'prefers-color-scheme', value:scheme}] }, manager);
        await b.evaluate('document.getElementById("sourceEditor").scrollIntoView({block:"center",behavior:"instant"})', manager);
        const shot = await b.send('Page.captureScreenshot', {format:'png'}, manager);
        await fs.writeFile(path.join(temp,'editor-error-'+scheme+'.png'),Buffer.from(shot.data,'base64'));
      }
      await b.send('Emulation.setEmulatedMedia', { features: [] }, manager);
      await input('scriptSource', original); await until('document.getElementById("syntaxStatus").textContent.startsWith("No syntax errors")');
    } else await b.screenshot(path.join(temp,'editor-firefox.png'),manager);
    // Move through the UI, then confirm source execution in separate native worlds.
    await select(ids[2]);
    await click('moveEarlier'); await until(api+'.runtime.sendMessage({type:"US_LIST"}).then(r=>r.scripts[1].id==='+JSON.stringify(ids[2])+')');
    await until('!document.getElementById("moveEarlier").disabled'); await click('moveEarlier');
    await until(api+'.runtime.sendMessage({type:"US_LIST"}).then(r=>r.scripts[0].id==='+JSON.stringify(ids[2])+')');
    const ordered = (await send({type:'US_LIST'})).scripts.map(s=>s.id);
    const script = await read(ids[1]);
    check('Stale ordering from another window is rejected', !(await send({type:'US_MOVE',id:script.id,revision:script.revision,direction:-1,order:ids})).ok);
    for (const phase of ['document-start','document-end','document-idle']) {
      if (phase !== 'document-start') for (const id of ordered) {
        let current=await read(id);const saved=await send({type:'US_SAVE',id,revision:current.revision,source:current.source.replace(/@run-at document-\w+/, '@run-at '+phase)});
        check('Timing fixture updated', saved.ok);current=await read(id);check('Timing fixture enabled', (await send({type:'US_ENABLE',id,revision:current.revision,enabled:true})).ok);
      }
      const page = await browse('/order-'+phase);pages.push(page);await until('(document.documentElement.dataset.execOrder||"").length===3',page);
      check('Configured native order at '+phase, await b.evaluate('document.documentElement.dataset.execOrder==="CAB"',page));
      check('Ad blocking remains active during ordered scripts', await b.evaluate('window.fixtureAd===undefined',page));
    }
    check('Tags survive source updates and re-registration', (await read(ids[0])).tags.includes('reading'));
    await require('./userscripts-development-browser.cjs').runDevelopment({ b, manager, send, check, until, browse, scriptSource, click, temp, evidence, select, input });
    evidence.editorOrganizationCompleted=true;
  } finally {
    for(const id of ids){const script=await read(id);if(script)await send({type:'US_DELETE',id,revision:script.revision});}
    for(const page of pages)await b.closePage(page);
  }
}
module.exports={runEditor};
