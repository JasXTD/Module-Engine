/* Native browser input on loopback fixtures. No external page or dependency. */
'use strict';
const fs = require('node:fs/promises'), path = require('node:path');
module.exports = async function verifyPicker({browser,page,send,state,until,check,temporary}) {
  // Inspect closed controls through the extension's privileged DOM API. No
  // test hook or shadow-root reference is exposed to the untrusted page.
  const ui = 'pickerUI';
  const evaluate = expression => expression.includes(ui) ? browser.evaluate(`api.scripting.executeScript({
    target:{tabId:${tabId},frameIds:[0]},func:()=>{
      const host=document.querySelector('[data-blockads-picker]');
      const extension=typeof browser !== 'undefined' ? browser : chrome;
      const pickerUI=host && (extension.dom?.openOrClosedShadowRoot ? extension.dom.openOrClosedShadowRoot(host) : host.openOrClosedShadowRoot);
      return (${expression});
    }}).then(results=>results[0].result)`) : browser.evaluate(expression,page);
  const wait = expression => until({evaluate},expression,page);
  const element = id => `${ui}.getElementById(${JSON.stringify(id)})`;
  const display = id => `getComputedStyle(document.getElementById(${JSON.stringify(id)})).display`;
  const currentUrl = await evaluate('location.href');
  const tabId = await browser.evaluate(`api.tabs.query({}).then(tabs=>tabs.find(tab=>tab.url === ${JSON.stringify(currentUrl)}).id)`);
  const saveCustom = async text => {
    const result = await send({type:'SAVE_COSMETIC_FILTERS',previous:(await state()).settings.customCosmeticFilters,text});
    if (!result.ok) throw new Error(result.error);
  };
  const click = async (expression,target=page) => {
    const position = `(() => {const node=${expression}; node.scrollIntoView({block:'nearest'});const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`;
    const point = target === page ? await evaluate(position) : await browser.evaluate(position,target);
    await browser.clickAt(point.x,point.y,target);
  };
  const input = async value => {
    await evaluate(`(${element('selector')}.focus(),${element('selector')}.select(),true)`);
    await browser.typeText(value,page);
    await wait(`${element('selector')}.value === ${JSON.stringify(value)}`);
  };
  const open = async () => {
    const result = await send({type:'START_PICKER',tabId});
    if (!result.ok) throw new Error(result.error);
    await wait(`Boolean(${ui})`);
  };
  const chooseLink = async () => { await click('document.getElementById("ba-pick-link")'); await wait(`!${element('editor')}.hidden`); };
  await evaluate(`(() => {
    const fixture=document.createElement('section');fixture.id='ba-picker-fixture';
    fixture.style.cssText='margin:16px 0;width:280px;min-height:180px';
    fixture.innerHTML='<div id="ba-pick-first" class="ba-pick-card" style="padding:12px;background:#ddeeff"><a id="ba-pick-link" href="/picker-link-trap" style="display:inline-block;padding:8px">Local offer fixture</a><p>First card</p></div><div id="ba-pick-second" class="ba-pick-card" style="padding:12px;background:#eeeeee">Second card</div>';
    document.body.prepend(fixture);window.baPickedClicks=0;
    document.getElementById('ba-pick-link').addEventListener('click',()=>window.baPickedClicks++);
    document.getElementById('ba-pick-link').focus();window.baPickStyle=document.getElementById('ba-pick-link').getAttribute('style');return true;
  })()`);
  await browser.evaluate(`(activeTabId=${tabId},activeHostname='127.0.0.1',renderUI(),true)`);
  await until(browser,'!busy && !document.getElementById("pickElement").disabled');
  await browser.evaluate("(lastError='Fixture protection verification failure',renderUI(),true)");
  await click('document.getElementById("pickElement")',browser.popup);
  await wait(`Boolean(${ui})`);
  check(true,'popup opens an on-demand picker on the selected ordinary page');
  await until(browser,'!busy');
  check(await browser.evaluate("lastError === 'Fixture protection verification failure' && !errorPanel.hidden"),'opening the picker cannot clear an unresolved protection verification error');
  await browser.evaluate("(lastError='',renderUI(),true)");
  const selectorChecks = await browser.evaluate(`api.scripting.executeScript({target:{tabId:${tabId},frameIds:[0]},func:()=>{
    const core=BlockAdsPickerCore, box=document.createElement('div');box.id='ba-core-checks';box.style.display='none';
    box.innerHTML='<div class="ba-core-row"><span class="ba-core-same">one</span><span class="ba-core-same">two</span></div><div class="ba-core-row"><span class="ba-core-same">three</span></div><div id="ba-duplicate"></div><div id="ba-duplicate"></div><div id="fake@example.invalid" class="slot:md"></div>';
    document.body.append(box);
    try {
      const nodes=[box.children[0].children[1],box.children[1].firstElementChild,box.children[3],box.children[4]];
      const unique=nodes.every(node=>{const selector=core.selectorFor(node),matches=document.querySelectorAll(selector);return matches.length===1 && matches[0]===node && !selector.includes('@');});
      let roots=false,detached=false,shadow=false,deep=false;
      try {core.selectorFor(document.body);}catch{roots=true;}
      try {core.selectorFor(document.createElement('div'));}catch{detached=true;}
      const shadowHost=document.createElement('div');box.append(shadowHost);const shadowRoot=shadowHost.attachShadow({mode:'open'});shadowRoot.innerHTML='<span>Shadow item</span>';
      try {core.selectorFor(shadowRoot.firstChild);}catch{shadow=true;}
      let last;
      for(let copy=0;copy<2;copy++){let parent=box;for(let i=0;i<20;i++){const node=document.createElement('section');parent.append(node);parent=node;}last=parent;}
      try {core.selectorFor(last);}catch{deep=true;}
      return {unique,roots,detached,shadow,deep};
    } finally {box.remove();}
  }}).then(results=>results[0].result)`);
  check(selectorChecks.unique,'generated selectors remain unique with duplicate IDs, repeated classes and unusual identifiers');
  check(selectorChecks.roots && selectorChecks.detached && selectorChecks.shadow && selectorChecks.deep,'selector generation refuses roots, detached nodes, shadow internals and excessive depth');
  await chooseLink();
  check(await evaluate(`${element('selector')}.value === '#ba-pick-link'`) && await evaluate(`window.baPickedClicks === 0 && location.href === ${JSON.stringify(currentUrl)}`),
    'native selection generates a unique selector without activating the underlying link');
  await evaluate(`(${element('save')}.click(),true)`);
  check((await state()).settings.customCosmeticFilters === '', 'synthetic page clicks cannot save a picker filter');
  const pageCouldRewrite = await evaluate(`(() => {
    const root=document.querySelector('[data-blockads-picker]').shadowRoot;
    if (!root) return false;
    root.getElementById('selector').value='#ba-pick-second';
    root.getElementById('status').textContent='Page-controlled confirmation';
    return true;
  })()`);
  await click(element('save'));
  await wait(`!document.querySelector('[data-blockads-picker]')`);
  const savedAfterAttack = (await state()).settings.customCosmeticFilters;
  check(savedAfterAttack === '127.0.0.1###ba-pick-link',
    'page selector substitution cannot change the rule saved by a native click: ' + savedAfterAttack);
  check(!pageCouldRewrite, 'page scripts cannot read or rewrite the closed picker controls');
  await saveCustom(''); await wait(`${display('ba-pick-link')} !== 'none'`);
  await evaluate("(document.getElementById('ba-pick-link').focus(),true)");
  await open(); await chooseLink();
  // Privileged test code simulates a value change without a trusted input
  // event; even such a change must not replace the isolated validated draft.
  await evaluate(`(${element('selector')}.value='#ba-pick-second',${element('selector')}.dispatchEvent(new Event('input',{bubbles:true})),true)`);
  await click(element('save')); await wait(`!document.querySelector('[data-blockads-picker]')`);
  check((await state()).settings.customCosmeticFilters === '127.0.0.1###ba-pick-link',
    'save uses validated state instead of rereading a programmatically changed control');
  await saveCustom(''); await wait(`${display('ba-pick-link')} !== 'none'`);
  await evaluate("(document.getElementById('ba-pick-link').focus(),true)");
  await open(); await chooseLink();
  await click(element('preview')); await wait(`${display('ba-pick-link')} === 'none'`);
  check(await evaluate(`document.getElementById('ba-pick-link').getAttribute('style') === window.baPickStyle && ${display('ba-pick-second')} !== 'none'`),
    'preview hides only the match and preserves original inline styling');
  await browser.pressKey('Escape',page);
  await wait(`!document.querySelector('[data-blockads-picker]') && ${display('ba-pick-link')} !== 'none'`);
  check((await state()).settings.customCosmeticFilters === '', 'Escape restores preview without saving');
  check(await evaluate("document.activeElement.id === 'ba-pick-link'"),'cancellation restores the previous page focus');

  await open(); await chooseLink();
  await input('.ba-pick-card'); await click(element('preview'));
  await wait(`${display('ba-pick-first')} === 'none' && ${display('ba-pick-second')} === 'none'`);
  await evaluate(`(() => {const card=document.createElement('div');card.id='ba-pick-third';card.className='ba-pick-card';card.textContent='Third card';document.getElementById('ba-picker-fixture').append(card);return true;})()`);
  await wait(`${display('ba-pick-third')} === 'none' && ${element('status')}.textContent.startsWith('3 elements')`);
  await evaluate("(document.getElementById('ba-pick-second').classList.remove('ba-pick-card'),true)");
  await wait(`${display('ba-pick-second')} !== 'none' && ${element('status')}.textContent.startsWith('2 elements')`);
  check(true,'preview tracks inserted and changed matches and restores elements that stop matching');
  await evaluate(`(() => {const node=document.createElement('span');node.id='ba-empty-case';node.append(document.createTextNode(''));document.getElementById('ba-picker-fixture').append(node);return true;})()`);
  await input('#ba-empty-case:empty'); await wait(`${display('ba-empty-case')} === 'none'`);
  await evaluate("(document.getElementById('ba-empty-case').firstChild.data='Now filled',true)");
  await wait(`${display('ba-empty-case')} !== 'none' && ${element('save')}.disabled`);
  check(true,'character-data changes restore elements whose native CSS state stops matching');
  await input('body');
  await wait(`${element('save')}.disabled && ${element('status')}.classList.contains('error')`);
  check(await evaluate(`${display('ba-pick-first')} !== 'none'`),'unsafe root selection is rejected and restores the former preview');
  await input('[broken');
  check(await evaluate(`${element('save')}.disabled`),'invalid CSS cannot be saved');
  await evaluate(`(() => {const fragment=document.createDocumentFragment();for(let i=0;i<101;i++){const node=document.createElement('span');node.className='ba-too-many';fragment.append(node);}document.getElementById('ba-picker-fixture').append(fragment);return true;})()`);
  await input('.ba-too-many');
  check(await evaluate(`${element('save')}.disabled && ${element('status')}.textContent.includes('100')`),'overbroad preview is rejected at 100 matches');
  await input('#ba-pick-first');
  await wait(`!${element('save')}.disabled`);
  if (browser.send) {
    await browser.send('Target.activateTarget',{targetId:page.id});
    for (const width of [1100,380]) {
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:850,deviceScaleFactor:1,mobile:false},page);
      check(await evaluate(`(() => {const r=${element('panel')}.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;})()`),`picker panel fits a ${width}px viewport`);
      const screenshot = await browser.send('Page.captureScreenshot',{format:'png'},page);
      await fs.writeFile(path.join(temporary,`picker-${width}.png`),Buffer.from(screenshot.data,'base64'));
    }
    await browser.send('Emulation.setDeviceMetricsOverride',{width:1100,height:850,deviceScaleFactor:1,mobile:false},page);
  }
  await saveCustom('127.0.0.1#@##ba-pick-first');
  await click(element('save'));
  await wait(`${element('status')}.textContent.includes('exception') && !${element('cancel')}.disabled`);
  check((await state()).settings.customCosmeticFilters === '127.0.0.1#@##ba-pick-first','a save rejected by a concurrent exception keeps the draft and existing rules');
  await saveCustom('127.0.0.1##.ba-unrelated');
  await click(element('save'));
  await wait(`!document.querySelector('[data-blockads-picker]') && ${display('ba-pick-first')} === 'none'`);
  check((await state()).settings.customCosmeticFilters === '127.0.0.1##.ba-unrelated\n127.0.0.1###ba-pick-first', 'retry saves the exact site rule while retaining concurrent editor changes');
  check(await evaluate("!document.getElementById('ba-pick-first').getAttributeNames().some(name=>name.startsWith('data-blockads-preview-'))"),'successful save removes temporary preview markers');
  const editor=await browser.open(await browser.evaluate('api.runtime.getURL("lists.html")'));
  await until(browser,'settings && !busy',editor);
  check(await browser.evaluate("document.getElementById('customFilters').value.includes('127.0.0.1###ba-pick-first')",editor),'saved picker rules appear in the existing custom-filter editor');
  await browser.closePage(editor);
  await saveCustom(''); await wait(`${display('ba-pick-first')} !== 'none'`);
  check(true,'removing the saved rule through the existing editor contract restores the page');

  await open(); await chooseLink(); await click(element('preview'));
  await send({type:'UPDATE_SETTINGS',patch:{cosmeticFiltering:false}});
  await wait(`!document.querySelector('[data-blockads-picker]') && ${display('ba-pick-link')} !== 'none'`);
  check(true,'pausing cosmetic filtering closes the picker and restores preview');
  await send({type:'UPDATE_SETTINGS',patch:{cosmeticFiltering:true}});
  await evaluate("(document.getElementById('ba-pick-link').focus(),true)");
  await open(); await chooseLink(); await click(element('preview')); await open();
  await wait(`${ui} && ${element('editor')}.hidden && ${display('ba-pick-link')} !== 'none'`);
  check(await evaluate("document.querySelectorAll('[data-blockads-picker]').length === 1"),'reopening replaces the old session and restores its preview');
  const starts = await Promise.all([send({type:'START_PICKER',tabId}),send({type:'START_PICKER',tabId})]);
  check(starts.every(result=>result.ok) && await evaluate("document.querySelectorAll('[data-blockads-picker]').length === 1"),'overlapping launches leave one usable picker session');
  await browser.pressKey('Tab',page);
  check(await evaluate(`${ui}.activeElement === [...${ui}.querySelectorAll('button, textarea')].find(node=>!node.disabled && node.getClientRects().length)`),'keyboard focus wraps to the first available picker control');
  for (let i=0;i<6 && !(await evaluate(`${ui}.activeElement.id === 'choose'`));i++) await browser.pressKey('Tab',page);
  await browser.pressKey('Enter',page); await wait(`!${element('editor')}.hidden`);
  check(await evaluate(`${element('selector')}.value === '#ba-pick-link'`),'the focused page element can be selected using only keyboard controls');
  await click(element('preview'));
  await evaluate("(document.querySelector('[data-blockads-picker]').remove(),true)");
  await wait(`${display('ba-pick-link')} !== 'none'`);
  check(true,'removing the overlay restores its preview and removes observers');
  await open(); await chooseLink(); await click(element('preview'));
  await evaluate(`(() => {sessionStorage.setItem('ba-picker-navigation','pending');window.addEventListener('pagehide',()=>sessionStorage.setItem('ba-picker-navigation',JSON.stringify({host:!!document.querySelector('[data-blockads-picker]'),marker:document.getElementById('ba-pick-link').getAttributeNames().some(name=>name.startsWith('data-blockads-preview-'))})),{once:true});return true;})()`);
  await browser.navigate(page,currentUrl+'?picker-navigation');
  await wait(`location.href === ${JSON.stringify(currentUrl+'?picker-navigation')} && document.readyState === 'complete'`);
  check(await evaluate("sessionStorage.getItem('ba-picker-navigation') === JSON.stringify({host:false,marker:false})"),'real navigation cleans up the picker and its preview before leaving');
  await browser.navigate(page,currentUrl);
  await wait(`location.href === ${JSON.stringify(currentUrl)} && document.readyState === 'complete' && typeof window.frameDisplay === 'function'`);
  const cspUrl = new URL('/picker-csp',currentUrl).href;
  await browser.navigate(page,cspUrl);
  await wait(`location.href === ${JSON.stringify(cspUrl)} && document.readyState === 'complete' && document.getElementById('normal')`);
  await open(); await click('document.getElementById("normal")'); await wait(`!${element('editor')}.hidden`);
  await click(element('preview')); await wait(`${display('normal')} === 'none'`);
  await browser.pressKey('Escape',page); await wait(`!document.querySelector('[data-blockads-picker]') && ${display('normal')} !== 'none'`);
  check(true,'picker opens, previews and restores on a local page requiring Trusted Types');
  await browser.navigate(page,currentUrl);
  await wait(`location.href === ${JSON.stringify(currentUrl)} && document.readyState === 'complete' && typeof window.frameDisplay === 'function'`);
};
