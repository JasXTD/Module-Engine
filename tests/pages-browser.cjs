/* Redesigned extension pages in a real engine: shared design system, :has()
   rules, restyled switches, narrow layouts and the module manager. Offline. */
'use strict';
const path=require('node:path');
// Each page shows in its DOM that its first verified state has arrived.
const loaded={
  'popup.html':"doc.body.getAttribute('aria-busy') === 'false' && !doc.getElementById('masterToggle').disabled",
  'manager.html':"!doc.getElementById('newScript').disabled",
  'lists.html':"doc.querySelectorAll('#siteHosts tbody tr').length > 0 && !doc.querySelector('section[data-list] input').disabled",
  'log.html':"doc.querySelectorAll('#entryTable tbody tr').length > 0"
};
// The page background proves the scheme's @media block won, not just its default.
const background={dark:'rgb(13, 15, 18)',light:'rgb(242, 243, 238)'};
const tokenColour=`(name => {const probe=document.createElement('i');probe.style.color='var('+name+')';document.body.append(probe);
  const value=getComputedStyle(probe).color;probe.remove();return value;})`;
// Lists each rendered switch's differences from ui.css. Finishing transitions
// makes the end state readable at once, without a delay.
const switchProblems=`(() => {
  document.getAnimations().forEach(animation=>animation.finish());
  const colour=${tokenColour}, rendered=[...document.querySelectorAll('input[type="checkbox"]')].filter(node=>node.getClientRects().length);
  const problems=rendered.flatMap(node=>{
    const box=getComputedStyle(node), knob=getComputedStyle(node,'::before');
    const [width,height,size]=node.classList.contains('switch-lg')?[42,24,18]:[34,20,14];
    const wanted={appearance:'none',width:width+'px',height:height+'px',background:colour(node.checked?'--accent':'--switch-off'),
      border:colour(node.checked?'--accent':'--line-strong'),radius:'999px',opacity:node.disabled?'0.45':'1',cursor:node.disabled?'not-allowed':'pointer',
      knobContent:'""',knobPosition:'absolute',knobWidth:size+'px',knobHeight:size+'px',knobRadius:'50%',
      knobColour:colour(node.checked?'--on-accent':'--text'),knobMoved:node.checked?'matrix(1, 0, 0, 1, '+(width-size-6)+', 0)':'none'};
    const actual={appearance:box.appearance,width:box.width,height:box.height,background:box.backgroundColor,
      border:box.borderTopColor,radius:box.borderTopLeftRadius,opacity:box.opacity,cursor:box.cursor,
      knobContent:knob.content,knobPosition:knob.position,knobWidth:knob.width,knobHeight:knob.height,knobRadius:knob.borderTopLeftRadius,
      knobColour:knob.backgroundColor,knobMoved:knob.transform};
    return Object.keys(wanted).filter(key=>wanted[key]!==actual[key]).map(key=>node.id+' '+key+': '+actual[key]+' instead of '+wanted[key]);
  });
  return {count:rendered.length,checked:rendered.filter(node=>node.checked).length,problems};
})()`;
const tablesFollowRows=`[...document.querySelectorAll('.table-wrap')].map(wrap=>[wrap.querySelector('tbody').childNodes.length===0,getComputedStyle(wrap).display==='none'])`;

module.exports=async function verifyPages({browser,send,state,until,check,temporary,url}) {
  const wait=(expression,target)=>until(browser,expression,target);
  const front=target=>browser.send?browser.send('Target.activateTarget',{targetId:target.id}):browser.front(target);
  // Pages disable their controls for a moment during a refresh, and a pointer
  // click landing in that moment is lost. Click again as a person would.
  const press=async (target,selector)=>{
    const element=`document.querySelector(${JSON.stringify(selector)})`;
    for (let attempt=0;attempt<5;attempt++) {
      await wait(`!${element}.disabled && ${element}.getClientRects().length > 0`,target);
      const point=await browser.evaluate(`(() => {const node=${element};node.scrollIntoView({block:'center',behavior:'instant'});globalThis.pressArrived=false;
        addEventListener('click',event=>{if(node.contains(event.target))globalThis.pressArrived=true;},{capture:true,once:true});
        const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`,target);
      await browser.clickAt(point.x,point.y,target);
      if (await browser.evaluate('globalThis.pressArrived',target)) return;
    }
    throw new Error(`Pointer clicks never reached ${selector}`);
  };
  const setColourScheme=async (scheme,targets)=>{
    if (!browser.send) return browser.setColorScheme(scheme);
    for (const target of targets) await browser.send('Emulation.setEmulatedMedia',{features:scheme?[{name:'prefers-color-scheme',value:scheme}]:[]},target);
  };
  const open={'popup.html':browser.popup};
  for (const file of ['manager.html','lists.html','log.html']) open[file]=await browser.open(url(file));
  const {'popup.html':popup,'manager.html':manager,'lists.html':lists,'log.html':log}=open;
  const extras=[];
  try {
    for (const [file,target] of Object.entries(open)) await wait(`(doc => ${loaded[file]})(document)`,target);
    check(await browser.evaluate("CSS.supports('selector(:has(*))')"),'browser supports the :has() selector the redesign relies on');

    for (const scheme of ['dark','light']) {
      await setColourScheme(scheme,Object.values(open));
      for (const [file,target] of Object.entries(open)) {
        await wait(`getComputedStyle(document.body).backgroundColor === ${JSON.stringify(background[scheme])}`,target);
        check(await browser.evaluate(`(() => {const body=getComputedStyle(document.body),colour=${tokenColour};
          return body.color===colour('--text') && body.fontFamily.includes('Segoe UI') && getComputedStyle(document.documentElement).colorScheme===${JSON.stringify(scheme)} &&
            [...document.styleSheets].every(sheet=>sheet.cssRules.length>0) && document.styleSheets.length===document.querySelectorAll('link[rel="stylesheet"]').length;})()`,target),
          `${file} loads its stylesheets and applies the ${scheme} design tokens`);
        const switches=await browser.evaluate(switchProblems,target);
        if (switches.count===0 || switches.problems.length) throw new Error(`${file} ${scheme} switches: ${JSON.stringify(switches)}`);
        check(true,`${file} shows ${switches.count} restyled switches in ${scheme}, ${switches.checked} on`);
        check(await browser.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth',target),`${file} has no horizontal overflow in ${scheme}`);
        if (!browser.send) await browser.screenshot(path.join(temporary,`${file.replace('.html','')}-${scheme}.png`),target);
      }
    }
    await setColourScheme(null,Object.values(open));

    const shown=selector=>`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display !== 'none'`;
    // ui.css: a table with no rows gives way to its empty message.
    const tableStates=async target=>(await browser.evaluate(tablesFollowRows,target)).every(([empty,hidden])=>empty===hidden);
    check(await tableStates(lists) && await tableStates(log),'every table hides while empty and shows once it has rows');
    const allowedWrap='section[data-list="allowedDomains"] .table-wrap';
    check(!(await browser.evaluate(shown(allowedWrap),lists)) && await browser.evaluate(shown('section[data-list="allowedDomains"] .empty'),lists),'an empty list shows its message instead of a table');
    await send({type:'ADD_ALLOWED_DOMAIN',domain:'pages-fixture.example'});
    await wait(shown(allowedWrap),lists);
    check(!(await browser.evaluate(shown('section[data-list="allowedDomains"] .empty'),lists)),':has(tbody:empty) reveals a table as soon as it gains a row');
    await send({type:'REMOVE_ALLOWED_DOMAIN',domain:'pages-fixture.example'});
    await wait(`!${shown(allowedWrap)}`,lists);
    check(true,':has(tbody:empty) hides the table again when its last row goes');

    // popup.css: messages take no room until one shows.
    await wait('!busy');
    await browser.evaluate("(lastError='',renderUI(),true)");
    check(!(await browser.evaluate(shown('.messages'))),':has() collapses the popup message area when nothing is showing');
    await browser.evaluate("(lastError='Fixture message',renderUI(),true)");
    check(await browser.evaluate(shown('.messages')),':has() opens the popup message area for a visible message');
    await browser.evaluate("(lastError='',renderUI(),true)");

    // popup.css: a switch that is off limits dims its label, unless it only waits on a save.
    const label="getComputedStyle(document.getElementById('toggleAds').closest('.layer-row').querySelector('.layer-name')).color";
    await send({type:'UPDATE_SETTINGS',patch:{enabled:false}});
    await wait('!busy && toggleAds.disabled');
    const dimmed=await browser.evaluate(`(() => {const colour=${tokenColour},dim=${label};document.body.setAttribute('aria-busy','true');const busyLabel=${label};document.body.setAttribute('aria-busy','false');
      return {dim:dim===colour('--text-2'),waiting:busyLabel===colour('--text')};})()`);
    check(dimmed.dim,':has(input:disabled) dims the label of a switch that is off limits');
    check(dimmed.waiting,'a switch that is only waiting on a save keeps its label colour');
    await send({type:'UPDATE_SETTINGS',patch:{enabled:true}});
    await wait('!busy && !toggleAds.disabled');
    check(await browser.evaluate(`${label} === (${tokenColour})('--text')`),'an available switch keeps its full label colour');

    // Real input reaches the restyled controls, not only the DOM behind them.
    await press(popup,'#toggleTrackers');
    await wait('!busy && !toggleTrackers.checked',popup);
    check((await state()).settings.rulesets.trackers_ruleset===false,'a pointer click on a restyled popup switch saves the setting');
    const off=await browser.evaluate(switchProblems,popup);
    if (off.problems.length) throw new Error('Popup switch after click: '+JSON.stringify(off));
    check(true,'a switched-off popup switch moves its knob and takes its off colour');
    await press(popup,'#toggleTrackers');
    await wait('!busy && toggleTrackers.checked',popup);
    check((await state()).settings.rulesets.trackers_ruleset===true,'a second pointer click turns the popup switch back on');
    await press(popup,'#masterToggle');
    await wait('!busy && !masterToggle.checked',popup);
    check((await state()).settings.enabled===false,'a pointer click on the large master switch pauses filtering');
    const paused=await browser.evaluate(switchProblems,popup);
    if (paused.problems.length) throw new Error('Popup switches while paused: '+JSON.stringify(paused));
    check(true,'paused popup shows the large switch off and dependent switches disabled');
    await press(popup,'#masterToggle');
    await wait('!busy && masterToggle.checked',popup);

    await front(log);
    await browser.evaluate(`(() => {const controls=[...document.querySelectorAll('a,button,input,select,textarea,summary')];controls[controls.indexOf(document.getElementById('liveToggle'))-1].focus();return true;})()`,log);
    await browser.pressKey('Tab',log);
    await wait("document.activeElement.id === 'liveToggle'",log);
    check(await browser.evaluate(`(() => {const node=document.activeElement,box=getComputedStyle(node);return node.matches(':focus-visible') && box.outlineStyle==='solid' && box.outlineWidth==='2px';})()`,log),'keyboard focus on a restyled switch draws its focus ring');
    if (!browser.send) {
      await browser.typeText(' ',log);
      await wait("!document.getElementById('liveToggle').checked",log);
      await browser.typeText(' ',log);
      await wait("document.getElementById('liveToggle').checked",log);
      check(true,'the space key toggles a focused restyled switch');
      // A tab shares the popup's code, not its container.
      const panel=await browser.openToolbarPopup(log,path.join(temporary,'toolbar-popup.png'));
      check(panel.state==='open' && panel.uri===url('popup.html') && panel.width===350 && panel.height>300 && panel.height<=600,`the real toolbar popup opens at ${panel.width} by ${panel.height}`);
    }

    // Narrow layouts: extension pages cannot set a viewport in every browser, but a frame has its own.
    const host=await browser.open(url('log.html')); extras.push(host);
    await wait(`(doc => ${loaded['log.html']})(document)`,host);
    for (const [file,widths] of [['popup.html',[350]],['manager.html',[1100,380]],['lists.html',[1100,380]],['log.html',[1100,380]]]) for (const width of widths) {
      await browser.evaluate(`(() => {document.getElementById('layoutFrame')?.remove();const frame=document.createElement('iframe');frame.id='layoutFrame';
        frame.style.cssText='position:fixed;left:0;top:0;width:${width}px;height:900px;border:0';frame.src=${JSON.stringify(file)};document.body.append(frame);return true;})()`,host);
      await wait(`(doc => doc.location.pathname.endsWith(${JSON.stringify(file)}) && doc.readyState === 'complete' && ${loaded[file]})(document.getElementById('layoutFrame').contentDocument)`,host);
      const layout=await browser.evaluate(`(() => {const frame=document.getElementById('layoutFrame'),view=frame.contentWindow,doc=frame.contentDocument,root=doc.documentElement,shell=doc.querySelector('.shell');
        doc.getAnimations().forEach(animation=>animation.finish());
        return {width:view.innerWidth,client:root.clientWidth,scroll:root.scrollWidth,columns:shell&&view.getComputedStyle(shell).gridTemplateColumns.split(' ').length,rail:shell&&view.getComputedStyle(doc.querySelector('.rail')).position};})()`,host);
      check(layout.width===width && layout.scroll<=layout.client,`${file} fits a ${width}px viewport`);
      if (file!=='popup.html') check(width>860?layout.columns===2 && layout.rail==='sticky':layout.columns===1 && layout.rail==='static',`${file} ${width>860?'keeps its side menu':'stacks its menu above the page'} at ${width}px`);
      if (!browser.send && width<860) await browser.screenshot(path.join(temporary,`${file.replace('.html','')}-${width}.png`),host,{width,height:900});
      if (file==='log.html') check(await browser.evaluate(`document.getElementById('layoutFrame').contentDocument.querySelector('#entryTable tbody tr').cells[3].getBoundingClientRect().width >= 180`,host),`log.html keeps its Details column readable at ${width}px`);
      if (file==='lists.html') check(await browser.evaluate(`(() => {const doc=document.getElementById('layoutFrame').contentDocument,rows=[...doc.querySelectorAll('#siteHosts tbody tr')];
        const lines=cell=>{const range=doc.createRange();range.selectNodeContents(cell);return new Set([...range.getClientRects()].map(rect=>Math.round(rect.top))).size;};
        return rows.length>0 && rows.every(row=>[0,1,3].every(index=>lines(row.cells[index])===1) && row.cells[2].getBoundingClientRect().width>=180);})()`,host),`lists.html keeps site-check hosts on one line at ${width}px`);
    }

    // A long entry must not squeeze short columns until "Event" wraps as "Even / t".
    check(await browser.evaluate(`(() => {
      const live=document.getElementById('liveToggle');live.checked=false;
      const site='127.0.0.1',lines=cell=>{const range=document.createRange();range.selectNodeContents(cell);return range.getClientRects().length;};
      entries=[{time:Date.now(),kind:'event',site,message:'x'.repeat(128)},{time:Date.now(),kind:'blocked',site,host:'ads.example.test',path:'/'+'y'.repeat(128),type:'script',layer:'Reported threat'}];
      render();
      const cells=[...document.querySelectorAll('#entryTable tbody td:nth-child(2),#entryTable tbody td:nth-child(3),#summaryTable tbody td:first-child')];
      const fits=cells.length===5 && cells.every(cell=>lines(cell)===1);
      live.checked=true;
      return fits;
    })()`,log),'activity log keeps short columns on one line beside a long entry');
    // Hostnames come from web pages. One this long must wrap in its own column.
    check(await browser.evaluate(`(() => {
      const live=document.getElementById('liveToggle');live.checked=false;
      const columns=host=>{
        entries=[{time:Date.now(),kind:'event',site:host,message:'Paused on this site'},{time:Date.now(),kind:'blocked',site:host,host,path:'/ad.js',type:'script',layer:'Custom block'}];
        render();
        return [...document.querySelectorAll('#entryTable,#summaryTable')].flatMap(table=>[...table.tBodies[0].rows[0].cells].map(cell=>Math.round(cell.getBoundingClientRect().width))).join();
      };
      // Keep the scrollbar in place: its arrival would shift every column by itself.
      document.documentElement.style.overflowY='scroll';
      const ordinary=columns('example.test'),long=columns('a'.repeat(63)+'.'+'b'.repeat(50)+'.example.com');
      const details=document.querySelector('#entryTable tbody tr').cells[3].getBoundingClientRect().width;
      document.documentElement.style.overflowY='';
      live.checked=true;
      return ordinary===long && details>=180;
    })()`,log),'a very long hostname wraps in its own column and leaves Details readable');

    // Module manager. Its code is private, so everything here reads the DOM.
    const text=id=>`document.getElementById(${JSON.stringify(id)}).textContent`;
    const managerReady=()=>wait("!document.getElementById('newScript').disabled",manager);
    const setSource=value=>browser.evaluate(`(() => {const input=document.getElementById('scriptSource');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,manager);
    const accept=async ()=>{await wait("document.getElementById('confirmDialog').open",manager);await press(manager,'#confirmAccept');await wait("!document.getElementById('confirmDialog').open",manager);await managerReady();};
    await managerReady();
    check(await browser.evaluate(`(() => {const status=document.getElementById('status'),badge=document.getElementById('blockerStatus');
      return status.classList.contains('success') && badge.textContent==='Active' && badge.classList.contains('active') && document.getElementById('blockingEnabled').checked;})()`,manager),'manager reports ad blocking active on its verified state');
    check(await browser.evaluate(`document.querySelector('.rail-links a[aria-current="page"]').getAttribute('href') === 'manager.html' && [...document.querySelectorAll('.rail-links a')].map(link=>link.getAttribute('href')).join() === 'manager.html,lists.html,log.html'`,manager),'manager side menu links every page and marks the current one');
    check(await browser.evaluate("!document.getElementById('accessPanel').hidden && !document.getElementById('grantAccess').hidden && !document.getElementById('userscriptsEnabled').checked",manager),'manager explains that userscript access has not been granted');
    await press(manager,'#newScript');
    await wait("!document.getElementById('scriptSource').disabled && document.getElementById('scriptPreview').textContent.includes('My page customization')",manager);
    check(await browser.evaluate(`document.activeElement.id === 'scriptSource' && ${text('editorHeading')} === 'New script' && !document.getElementById('saveScript').disabled`,manager),'New script opens a focused, reviewed draft');
    const source=name=>`// ==UserScript==\n// @name ${name}\n// @match http://127.0.0.1/*\n// @grant none\n// ==/UserScript==\n`;
    await setSource(source('Layout fixture'));
    await press(manager,'#saveScript');
    await wait(`${text('libraryCount')} === '1 scripts' && /saved and turned off/i.test(${text('status')})`,manager);
    await managerReady();
    const saved=(await send({type:'US_LIST'})).scripts[0];
    check(saved?.metadata.name==='Layout fixture' && !saved.enabled,'manager saves a new script disabled');
    check(await browser.evaluate(`document.querySelector('.script-item').getAttribute('aria-pressed') === 'true' && ${text('editorHeading')} === 'Layout fixture'`,manager),'the saved script is selected in the library');
    await press(manager,'#scriptEnabled');
    await wait(`/saved · enabled/i.test(${text('draftState')})`,manager);
    await managerReady();
    check((await send({type:'US_LIST'})).scripts[0].enabled && (await browser.evaluate(switchProblems,manager)).problems.length===0,'the restyled script switch enables a saved script');
    await press(manager,'#scriptEnabled');
    await wait(`/saved · disabled/i.test(${text('draftState')})`,manager);
    await managerReady();
    await browser.evaluate("(document.getElementById('searchScripts').focus(),true)",manager);
    await browser.typeText('no-such-script',manager);
    await wait(`document.getElementById('emptyLibrary').textContent === 'No matching scripts.' && !document.querySelector('.script-item')`,manager);
    check(true,'library search narrows the list and says when nothing matches');
    await browser.evaluate(`(() => {const input=document.getElementById('searchScripts');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`,manager);
    await wait("Boolean(document.querySelector('.script-item'))",manager);
    check(await browser.evaluate(`document.querySelector('.script-item .script-state').textContent === 'Off'`,manager),'each library item shows its own on or off state');

    // Opening a script starts at its first line, even when its last line is wider than the editor.
    await setSource(source('Layout fixture')+'// '+'x'.repeat(400)+'\n');
    await press(manager,'#saveScript');
    await wait(`${text('draftState')} === 'Saved · disabled'`,manager);
    await managerReady();
    await browser.evaluate("(document.getElementById('searchScripts').focus(),true)",manager);
    await press(manager,'.script-item');
    await wait("document.activeElement.id === 'scriptSource'",manager);
    check(await browser.evaluate(`(() => {const input=document.getElementById('scriptSource');
      return input.scrollWidth>input.clientWidth && input.scrollLeft===0 && input.scrollTop===0 && input.selectionStart===0;})()`,manager),'a reopened script shows its first line, not the end of its longest one');

    await setSource(source('Layout fixture')+'// unsaved\n');
    await wait(`${text('draftState')} === 'Unsaved draft'`,manager);
    await press(manager,'#discardDraft');
    await wait("document.getElementById('confirmDialog').open",manager);
    check(await browser.evaluate(`document.getElementById('confirmDialog').matches(':modal') && ${text('confirmTitle')} === 'Discard this draft?' && document.getElementById('scriptSource').disabled`,manager),'a modal confirmation guards the draft and locks the editor');
    await browser.pressKey('Escape',manager);
    await wait("!document.getElementById('confirmDialog').open",manager);
    check(await browser.evaluate("document.getElementById('scriptSource').value.endsWith('// unsaved\\n')",manager),'Escape keeps the draft');
    await press(manager,'#discardDraft');
    await accept();
    await wait("!document.getElementById('scriptSource').value.includes('// unsaved')",manager);
    check(true,'Discard draft reloads the saved source after confirmation');
    await browser.evaluate(`(() => {const input=document.getElementById('scriptFile'),files=new DataTransfer();files.items.add(new File([${JSON.stringify(source('Imported fixture'))}],'fixture.user.js',{type:'text/javascript'}));
      input.files=files.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,manager);
    await wait(`/Imported as a draft/.test(${text('status')}) && document.getElementById('scriptSource').value.includes('Imported fixture')`,manager);
    check((await send({type:'US_LIST'})).scripts.length===1,'an imported file stays a reviewable draft until saved');
    await press(manager,'#saveScript');
    await wait(`${text('libraryCount')} === '2 scripts'`,manager);
    await managerReady();

    await press(manager,'#blockingEnabled');
    await wait(`${text('blockerStatus')} === 'Off' && !document.getElementById('blockingEnabled').checked`,manager);
    check((await state()).settings.enabled===false,'the manager switch pauses ad blocking');
    await managerReady();
    await press(manager,'#blockingEnabled');
    await wait(`${text('blockerStatus')} === 'Active' && document.getElementById('blockingEnabled').checked`,manager);
    check((await state()).settings.enabled===true,'the manager switch resumes ad blocking');
    await managerReady();

    await press(manager,'#deleteScript');
    await accept();
    await wait(`${text('libraryCount')} === '1 scripts'`,manager);
    await press(manager,'.script-item');
    await wait(`${text('editorHeading')} === 'Layout fixture'`,manager);
    await press(manager,'#deleteScript');
    await accept();
    await wait(`${text('libraryCount')} === '0 scripts' && /deleted/.test(${text('status')})`,manager);
    check((await send({type:'US_LIST'})).scripts.length===0,'confirmed deletions empty the library');
  } finally {
    await setColourScheme(null,Object.values(open)).catch(()=>{});
    for (const target of [manager,lists,log,...extras]) await browser.closePage(target).catch(()=>{});
  }
};
