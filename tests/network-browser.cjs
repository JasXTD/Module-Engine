/* Native DNR matching uses inert strings; actual requests go only to loopback. */
'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
module.exports=async function verifyNetwork({browser,page,send,state,match,until,check,temporary,requests,threatHosts}) {
  const baseline=(await state()).settings;
  const save=async text=>{
    const response=await send({type:'SAVE_NETWORK_FILTERS',previous:(await state()).settings.customNetworkFilters,text});
    if (!response.ok) throw new Error(response.error);
  };
  const change=async patch=>{const response=await send({type:'UPDATE_SETTINGS',patch});if(!response.ok)throw new Error(response.error);};
  const editor=await browser.open(await browser.evaluate("api.runtime.getURL('lists.html')"));
  const evaluate=expression=>browser.evaluate(expression,editor),wait=expression=>until(browser,expression,editor);
  const click=async selector=>{
    const element=`document.querySelector(${JSON.stringify(selector)})`;
    // A DOM click on a disabled control is silently lost, so wait in the same
    // task as the click. A control that never enables times out and fails.
    if (!browser.send) return wait(`(() => {const node=${element};if (node.disabled) return false;node.click();return true;})()`);
    const point=await evaluate(`(() => {const node=${element};node.scrollIntoView({block:'center'});const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await browser.clickAt(point.x,point.y,editor);
  };
  const input=async value=>{
    await wait("!busy && !document.getElementById('networkFilters').disabled");
    if (browser.send) await browser.send('Target.activateTarget',{targetId:editor.id});
    await evaluate("(document.getElementById('networkFilters').focus(),document.getElementById('networkFilters').select(),true)");
    if (browser.send) await browser.typeText(value,editor);
    else await evaluate(`(() => {const input=document.getElementById('networkFilters');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    await wait(`document.getElementById('networkFilters').value === ${JSON.stringify(value)}`);
  };
  const action=async (url,type='script',initiator='https://publisher-fixture.test')=>{
    const result=await match(url,type,initiator);
    const rules=await browser.evaluate('api.declarativeNetRequest.getDynamicRules()');
    return result.matchedRules.filter(item=>item.rulesetId==='_dynamic').map(item=>rules.find(rule=>rule.id===item.ruleId)?.action.type).join(',');
  };
  try {
  await wait("settings && !busy && (threatEvidence || threatEvidenceError)");
  check(await evaluate("!!threatEvidence && !threatEvidenceError"),'bundled evidence verifies in the browser without opening reports');
  check(await evaluate("document.querySelectorAll('#threatEvidence tbody tr').length === 24"),'evidence panel shows the 24 validated exact hosts');
  check(await evaluate("[...document.querySelectorAll('#threatEvidence tbody tr')].every(row=>row.cells[0].textContent.includes('[.]') && !row.cells[0].querySelector('a'))"),'reported hosts are defanged inert text');
  check(await evaluate("[...document.querySelectorAll('#threatEvidence a')].every(link=>['www.proofpoint.com','www.volexity.com'].includes(new URL(link.href).hostname) && link.rel === 'noopener noreferrer')"),'only approved publisher reports are links, with no opener or referrer');
  check(await evaluate("document.getElementById('threatEvidenceStatus').textContent.includes('enabled')"),'evidence display uses verified protection status');
  await click('#networkFilterPanel > summary');
  const filters=[
    '! Original local request-matching fixtures',
    '||cdn.request-probe.test/unit-block/*$script,third-party,domain=publisher-fixture.test|~quiet.publisher-fixture.test',
    '@@||cdn.request-probe.test/unit-block/allowed.js$script,domain=publisher-fixture.test',
    '||case.request-probe.test/Upper.js|$script,match-case',
    '||uncased.request-probe.test/Banner$script',
    '||first.request-probe.test^$image,first-party',
    '||third.request-probe.test^$script,third-party',
    '||negative.request-probe.test^$~image,~stylesheet',
    '|https://absolute.request-probe.test:8443/path.js|$script',
    '||www.scope.request-probe.test^$script',
    '||bücher.request-probe.test^$script',
    '||frame.request-probe.test^$subdocument',
    '@@||hard.request-probe.test^',
    '@@||'+threatHosts[0]+'^'
  ].join('\n');
  await input(filters); await wait("!busy && !document.getElementById('saveNetworkFilters').disabled");
  await click('#saveNetworkFilters'); await wait("!busy && !networkDraftDirty && document.getElementById('networkStatus').textContent.startsWith('Network filters saved and verified.')");
  check((await state()).settings.customNetworkFilters===filters,'editor saves the exact draft after browser rule readback');
  const cases=[
    ['https://cdn.request-probe.test/unit-block/a.js','script','https://publisher-fixture.test','block'],
    ['https://child.cdn.request-probe.test/unit-block/a.js','script','https://news.publisher-fixture.test','block'],
    ['https://cdn.request-probe.test/unit-block/a.js','script','https://quiet.publisher-fixture.test',''],
    ['https://cdn.request-probe.test/unit-block/a.js','script','https://another-publisher.test',''],
    ['https://cdn.request-probe.test/unit-block/a.js','image','https://publisher-fixture.test',''],
    ['https://cdn.request-probe.test/ordinary/a.js','script','https://publisher-fixture.test',''],
    ['https://cdn.request-probe.test.evil.test/unit-block/a.js','script','https://publisher-fixture.test',''],
    ['https://safe.example/?next=cdn.request-probe.test/unit-block/a.js','script','https://publisher-fixture.test',''],
    ['https://cdn.request-probe.test/unit-block/allowed.js','script','https://publisher-fixture.test','allow'],
    ['https://case.request-probe.test/Upper.js','script','https://publisher-fixture.test','block'],
    ['https://case.request-probe.test/upper.js','script','https://publisher-fixture.test',''],
    ['https://case.request-probe.test/Upper.js?more=1','script','https://publisher-fixture.test',''],
    ['https://uncased.request-probe.test/banner-extra','script','https://publisher-fixture.test','block'],
    ['https://first.request-probe.test/image.png','image','https://news.request-probe.test','block'],
    ['https://first.request-probe.test/image.png','image','https://publisher-fixture.test',''],
    ['https://third.request-probe.test/asset','script','https://publisher-fixture.test','block'],
    ['https://third.request-probe.test/asset','script','https://news.request-probe.test',''],
    ['https://negative.request-probe.test/asset','script','https://publisher-fixture.test','block'],
    ['https://negative.request-probe.test/asset','main_frame','https://publisher-fixture.test','block'],
    ['https://negative.request-probe.test/asset','image','https://publisher-fixture.test',''],
    ['https://negative.request-probe.test/asset','stylesheet','https://publisher-fixture.test',''],
    ['https://absolute.request-probe.test:8443/path.js','script','https://publisher-fixture.test','block'],
    ['https://absolute.request-probe.test/path.js','script','https://publisher-fixture.test',''],
    ['http://absolute.request-probe.test:8443/path.js','script','https://publisher-fixture.test',''],
    ['https://sub.absolute.request-probe.test:8443/path.js','script','https://publisher-fixture.test',''],
    ['https://www.scope.request-probe.test/file','script','https://publisher-fixture.test','block'],
    ['https://scope.request-probe.test/file','script','https://publisher-fixture.test',''],
    ['https://xn--bcher-kva.request-probe.test/file','script','https://publisher-fixture.test','block'],
    ['https://frame.request-probe.test/frame','sub_frame','https://publisher-fixture.test','block'],
    ['https://frame.request-probe.test/frame','main_frame','https://publisher-fixture.test','']
  ];
  for (const [url,type,initiator,expected] of cases) check(await action(url,type,initiator)===expected,`custom DNR ${type} ${url} from ${initiator}: ${expected || 'no custom match'}`);
  check((await match('https://'+threatHosts[0]+'/fixture')).matchedRules.some(rule=>rule.rulesetId==='threats_ruleset'),'custom request exceptions cannot override dated threat rules');
  await send({type:'ADD_CUSTOM_DOMAIN',domain:'hard.request-probe.test'});
  check(await action('https://hard.request-probe.test/file')==='block','explicit domain block wins over a custom request exception');
  await send({type:'REMOVE_CUSTOM_DOMAIN',domain:'hard.request-probe.test'});
  await send({type:'ADD_ALLOWED_DOMAIN',domain:'case.request-probe.test'});
  check(await action('https://case.request-probe.test/Upper.js')==='allow','Always Allowed wins over a custom request block');
  await send({type:'REMOVE_ALLOWED_DOMAIN',domain:'case.request-probe.test'});
  await change({whitelistedDomains:[...baseline.whitelistedDomains,'publisher-fixture.test']});
  check(await action('https://cdn.request-probe.test/unit-block/a.js')==='allow','full site pause wins over a custom request block');
  await change({whitelistedDomains:baseline.whitelistedDomains,enabled:false});
  check(await action('https://case.request-probe.test/Upper.js')==='','master pause removes custom network rules');
  await wait("document.getElementById('networkActivity').textContent.includes('paused') && document.getElementById('threatEvidenceStatus').textContent.includes('inactive')");
  check(true,'network editor and evidence status accurately show the master pause');
  await change({enabled:true,cosmeticFiltering:false,customBlockedDomains:[],rulesets:{ads_ruleset:false,trackers_ruleset:false,community_ruleset:false,threats_ruleset:false}});
  check(await action('https://case.request-probe.test/Upper.js')==='block','custom request filters are independent of cosmetic and list toggles');
  await until(browser,"!busy && currentSettings && !currentSettings.cosmeticFiltering && !Object.values(currentSettings.rulesets).some(Boolean)");
  check(await browser.evaluate("document.getElementById('statusText').textContent === 'Filtering enabled'"),'popup counts custom request blocks when all other filtering is off');
  const allowOnly='! No blocking rules\n@@||allow-only.request-probe.test^';
  await save(allowOnly);
  await until(browser,`!busy && currentSettings.customNetworkFilters === ${JSON.stringify(allowOnly)}`);
  check(await browser.evaluate("document.getElementById('statusText').textContent === 'No filters enabled'"),'popup does not count comments or request exceptions as blocking protection');
  await save(filters);
  await until(browser,`!busy && currentSettings.customNetworkFilters === ${JSON.stringify(filters)}`);
  check(await browser.evaluate("document.getElementById('statusText').textContent === 'Filtering enabled'"),'an already-open popup follows custom request-filter changes');
  await change({cosmeticFiltering:baseline.cosmeticFiltering,customBlockedDomains:baseline.customBlockedDomains,rulesets:baseline.rulesets});

  await input(filters+'\n||invalid.example^$redirect=script');
  check(await evaluate("document.getElementById('saveNetworkFilters').disabled && /Line 15:/.test(document.getElementById('networkStatus').textContent)"),'unsupported syntax reports its source line and prevents submission');
  check((await state()).settings.customNetworkFilters===filters,'an invalid draft leaves active filters unchanged');
  const draft=filters+'\n||draft.request-probe.test^$script',remote=filters+'\n||remote.request-probe.test^$image';
  await input(draft); await save(remote);
  await wait(`!busy && settings.customNetworkFilters === ${JSON.stringify(remote)}`);
  check(await evaluate(`networkDraftDirty && document.getElementById('networkFilters').value === ${JSON.stringify(draft)}`),'background additions preserve the unsaved editor draft');
  await click('#saveNetworkFilters'); await wait("!busy && /changed|discard|load/i.test(document.getElementById('networkStatus').textContent)");
  check((await state()).settings.customNetworkFilters===remote,'stale save cannot overwrite a background addition');
  await click('#discardNetworkFilters');
  check(await evaluate(`!networkDraftDirty && document.getElementById('networkFilters').value === ${JSON.stringify(remote)}`),'Discard explicitly loads the current saved revision');
  await input(draft); await save(''); await wait("!busy && settings.customNetworkFilters === ''");
  await click('#saveNetworkFilters'); await wait("!busy && /changed|discard|load/i.test(document.getElementById('networkStatus').textContent)");
  check((await state()).settings.customNetworkFilters==='' && await evaluate('networkDraftDirty'),'stale save cannot resurrect background deletions and retains the draft');
  await click('#discardNetworkFilters');
  check(await evaluate("!networkDraftDirty && document.getElementById('networkFilters').value === '' && document.getElementById('networkCount').textContent === '(0)'"),'clearing filters updates the empty editor state');

  const port=new URL(await browser.evaluate('location.href',page)).port;
  const local='|http://localhost:'+port+'/blocked-probe.network*$script,third-party,domain=127.0.0.1';
  await save(local);
  const blockedPath='/blocked-probe.network?blocked='+Date.now();
  const loadScript=probe=>browser.evaluate(`new Promise(resolve=>{const script=document.createElement('script');script.src=${JSON.stringify('http://localhost:'+port+probe)};script.onload=()=>{script.remove();resolve('loaded');};script.onerror=()=>{script.remove();resolve('blocked');};document.body.append(script);})`,page);
  check(await loadScript(blockedPath)==='blocked' && !requests.includes(blockedPath),'a real matching loopback script is blocked before the server receives it');
  const fetchPath='/blocked-probe.network?fetch='+Date.now();
  check(await browser.evaluate(`fetch(${JSON.stringify('http://localhost:'+port+fetchPath)}).then(response=>response.ok)`,page) && requests.includes(fetchPath),'the same loopback endpoint remains available to an excluded resource type');
  const allowedPath='/blocked-probe.network?allowed='+Date.now();
  await save(local+'\n@@|http://localhost:'+port+allowedPath+'|$script');
  check(await loadScript(allowedPath)==='loaded' && requests.includes(allowedPath) && await browser.evaluate('window.__blockadsNetworkProbe === 1',page),'a precise request exception restores a harmless loopback script');
  await browser.navigate(editor,await browser.evaluate("api.runtime.getURL('lists.html')"));
  await wait("settings && !busy && threatEvidence && document.getElementById('networkCount').textContent === '(2)'");
  check(await evaluate("document.getElementById('networkFilters').value === settings.customNetworkFilters"),'saved request filters survive a full editor reload');
  await click('#networkFilterPanel > summary');
  await evaluate("(document.querySelector('#threatEvidence details').open=true,true)");
  if (browser.send) {
    for (const width of [1100,380]) {
      await browser.send('Target.activateTarget',{targetId:editor.id});
      await browser.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},editor);
      await evaluate("(document.getElementById('requestFiltering').scrollIntoView({block:'start'}),true)");
      check(await evaluate('document.documentElement.scrollWidth <= innerWidth+1'),`request editor has no horizontal page overflow at ${width}px`);
      const shot=await browser.send('Page.captureScreenshot',{format:'png'},editor);
      await fs.writeFile(path.join(temporary,`network-editor-${width}.png`),Buffer.from(shot.data,'base64'));
      await evaluate("(document.getElementById('threatEvidence').scrollIntoView({block:'start'}),true)");
      const evidenceShot=await browser.send('Page.captureScreenshot',{format:'png'},editor);
      await fs.writeFile(path.join(temporary,`threat-evidence-${width}.png`),Buffer.from(evidenceShot.data,'base64'));
      if (width === 380) {
        await evaluate("(document.querySelector('#threatEvidence .table-wrap').focus(),true)");
        for (const type of ['keyDown','keyUp']) await browser.send('Input.dispatchKeyEvent',{type,key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},editor);
        await wait("document.querySelector('#threatEvidence .table-wrap').scrollLeft > 0");
        check(true,'the narrow evidence table can be scrolled with the keyboard');
      }
    }
  }
  await evaluate("(() => {const now=Date.now;Date.now=()=>Date.parse(threatEvidence.policy.expiresAt)+1;try {render();} finally {Date.now=now;}return true;})()");
  check(await evaluate("document.getElementById('threatEvidenceStatus').textContent.includes('expired') && !document.getElementById('threatEvidenceStatus').textContent.includes('enabled')"),'an expired evidence view never claims the threat rules are current');
  await evaluate('(render(),true)');
  await evaluate("(async () => {const original=api.runtime.sendMessage;api.runtime.sendMessage=async()=>{throw new Error('Fixture messaging failure');};try {await run({type:'GET_STATE'});} finally {api.runtime.sendMessage=original;}return true;})()");
  check(await evaluate("!protectionVerified && document.getElementById('threatEvidenceStatus').textContent.includes('not verified') && document.getElementById('notice').textContent.includes('Fixture messaging failure')"),'a failed background connection clears the verified-protection claim');
  await evaluate("run({type:'GET_STATE'})");
  check(await evaluate("protectionVerified && document.getElementById('threatEvidenceStatus').textContent.includes('enabled')"),'a successful protection check recovers the evidence status');
  await browser.closePage(editor);
  await save(baseline.customNetworkFilters);
  check((await state()).settings.customCosmeticFilters===baseline.customCosmeticFilters,'network editing preserves custom page-hiding filters');
  } catch (error) {
    try {
      error.message+='\nEditor state: '+JSON.stringify(await evaluate("({busy,dirty:networkDraftDirty,valid:networkDraftValid,baseCurrent:networkDraftBase===settings?.customNetworkFilters,status:document.getElementById('networkStatus').textContent,notice:document.getElementById('notice').textContent})"));
    } catch { /* Keep the original failure if the browser itself disconnected. */ }
    throw error;
  }
};
