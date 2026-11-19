/* Scriptlet filters in real pages, offline, on the suites' own loopback servers.
   With userscript access (the userscript suites) they must run before the
   page's first script; without it (the blocker suite) they start as each frame
   asks for its hiding rules. Either way the same page effects are checked. */
'use strict';
const served = [];

// /scriptlets/page?frame=<loopback origin> embeds /scriptlets/frame from that origin.
function serve(request, response) {
  const url = new URL(request.url, 'http://fixture.invalid');
  if (!url.pathname.startsWith('/scriptlets/')) return false;
  served.push(url.pathname);
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/scriptlets/page') {
    const frame = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(url.searchParams.get('frame') || '') ? url.searchParams.get('frame') : '';
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Scriptlet fixture</title>
<script>
  // The page's first script: what document-start scriptlets have already done.
  window.meFirst = { flag: window.meFlag ?? null, storage: localStorage.getItem('meConsent') };
  window.meSawErrors = [];
  window.onerror = message => { window.meSawErrors.push(String(message)); };
</script>
<script>window.meRmntRan = true; /* me-rmnt-needle */</script>
</head><body>
<div id="rc-target" class="me-ad-class keep-class">Class target</div>
<div id="ra-target" data-me-ad="1" title="kept">Attribute target</div>
${frame ? `<iframe id="frame" src="${frame}/scriptlets/frame"></iframe>` : ''}
<script>
  window.meFrameState = () => new Promise(resolve => {
    const target = document.getElementById('frame')?.contentWindow;
    if (!target) { resolve(null); return; }
    const timer = setTimeout(() => { removeEventListener('message', receive); resolve(null); }, 2000);
    const receive = event => {
      if (event.source !== target || event.data?.kind !== 'scriptlet-state') return;
      clearTimeout(timer); removeEventListener('message', receive); resolve(event.data.value);
    };
    addEventListener('message', receive);
    target.postMessage('scriptlet-state', '*');
  });
</script>
</body></html>`);
    return true;
  }
  if (url.pathname === '/scriptlets/frame') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><script>window.meFrameFirst = window.meFrameFlag ?? null;</script></head><body>Frame
<script>addEventListener('message', event => {
  if (event.data === 'scriptlet-state') event.source.postMessage({ kind: 'scriptlet-state',
    value: { first: window.meFrameFirst, flag: window.meFrameFlag ?? null, topFlag: window.meFlag ?? null } }, '*');
});</script></body></html>`);
    return true;
  }
  response.setHeader('Content-Type', 'text/plain');
  response.end('server');
  return true;
}

// Every rule names this fixture's hosts only.
const RULES = ['127.0.0.1##+js(set, meFlag, true)', '127.0.0.1##+js(set, meConfig.ads, false)', '127.0.0.1##+js(aopr, meDetector)',
  '127.0.0.1##+js(nostif, meAdTimer)', '127.0.0.1##+js(json-prune, meAds)', '127.0.0.1##+js(no-fetch-if, ad-endpoint)',
  '127.0.0.1##+js(no-xhr-if, xhr-ad-endpoint)', '127.0.0.1##+js(aeld, click, meAdClick)', '127.0.0.1##+js(nowoif, me-popup)',
  '127.0.0.1##+js(rc, me-ad-class, #rc-target, stay)', '127.0.0.1##+js(ra, data-me-ad, #ra-target, stay)',
  '127.0.0.1##+js(set-local-storage-item, meConsent, accepted)', '127.0.0.1##+js(set-cookie, meConsent, yes)',
  '127.0.0.1##+js(acs, meAcsTarget, me-acs-needle)', '127.0.0.1##+js(rmnt, script, me-rmnt-needle)',
  '127.0.0.1##+js(set, meExcepted, true)', '127.0.0.1#@#+js(set, meExcepted, true)', 'localhost##+js(set, meFrameFlag, true)'];

// open(url) → page, evaluate(expression, page), wait(expression, page), close(page),
// send(message), check(condition, description). early: userscript access is on.
// frameOrigin: a cross-origin loopback origin, or the page's own origin when the
// suite blocks the other one (its ad canary). popup and listsUrl are optional.
async function verify({ open, evaluate, wait, close, send, check, origin, frameOrigin, early, popup, listsUrl }) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const crossOrigin = frameOrigin !== origin;
  const state = await send({ type: 'GET_STATE' });
  if (!state.ok) throw new Error(state.error);
  const previous = state.settings.customCosmeticFilters;
  // The bundled uBlock filters bring scriptlet rules of their own.
  const listRules = state.scriptletStatus?.rules ?? 0;
  const save = async text => {
    const result = await send({ type: 'SAVE_COSMETIC_FILTERS', previous: (await send({ type: 'GET_STATE' })).settings.customCosmeticFilters, text });
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  const patch = async values => {
    const result = await send({ type: 'UPDATE_SETTINGS', patch: values });
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  const saved = await save([previous, ...RULES].filter(Boolean).join('\n'));
  check(saved.scriptletStatus?.mode === (early ? 'early' : 'late'), early ? 'with userscript access, scriptlet filters are registered to start at document start'
    : 'without userscript access, scriptlet filters start as each page loads');
  const url = origin + '/scriptlets/page?frame=' + encodeURIComponent(frameOrigin);
  let page = await open(url);
  // Started late, the scriptlets arrive with the frame's first hiding request.
  await wait('window.meFlag === true', page);
  check(await evaluate('(window.meConfig = { ads: true, other: 1 }, meConfig.ads === false && meConfig.other === 1)', page),
    'set-constant fixes a value on an object the page creates later');
  check(await evaluate('(() => { try { return window.meDetector, false; } catch (error) { return error instanceof ReferenceError; } })()', page),
    'abort-on-property-read stops a script that reads the property');
  check(await evaluate(`new Promise(resolve => { setTimeout(function meAdTimer() { window.meTimerRan = true; }, 0);
    setTimeout(function meOkTimer() { window.meOkRan = true; }, 0); setTimeout(() => resolve(!window.meTimerRan && window.meOkRan === true), 200); })`, page),
    'no-setTimeout-if stops only the timer whose code matches');
  check(await evaluate(`JSON.stringify(JSON.parse('{"meAds":[1],"keep":true}')) === '{"keep":true}'`, page), 'json-prune removes the named property from parsed JSON');
  const before = served.length;
  check(await evaluate(`Promise.all([fetch('/scriptlets/ad-endpoint').then(response => response.text()), fetch('/scriptlets/ok-endpoint').then(response => response.text()),
    new Promise(resolve => { const xhr = new XMLHttpRequest(); xhr.onload = () => resolve(xhr.status === 200 && xhr.responseText === ''); xhr.onerror = () => resolve(false);
      xhr.open('GET', '/scriptlets/xhr-ad-endpoint'); xhr.send(); })]).then(([ad, ok, xhr]) => ad === '' && ok === 'server' && xhr)`, page),
    'no-fetch-if and no-xhr-if answer matching requests themselves and let others through');
  check(!served.slice(before).some(path => path.includes('ad-endpoint')) && served.slice(before).includes('/scriptlets/ok-endpoint'),
    'stopped requests never reach the server');
  check(await evaluate(`(() => { const seen = [], node = document.getElementById('ra-target');
    node.addEventListener('click', function meAdClick() { seen.push('ad'); }); node.addEventListener('click', function meUsefulClick() { seen.push('useful'); });
    node.dispatchEvent(new MouseEvent('click')); return seen.join() === 'useful'; })()`, page), 'addEventListener-defuser drops only the matching listener');
  check(await evaluate("window.open('/scriptlets/me-popup') === null", page) && !served.includes('/scriptlets/me-popup'),
    'no-window-open-if refuses the matching pop-up, which never loads');
  await wait("!document.getElementById('rc-target').classList.contains('me-ad-class') && !document.getElementById('ra-target').hasAttribute('data-me-ad')", page);
  check(await evaluate("document.getElementById('rc-target').classList.contains('keep-class') && document.getElementById('ra-target').title === 'kept'", page),
    'remove-class and remove-attr remove only what they name');
  await evaluate("(document.getElementById('rc-target').classList.add('me-ad-class'), true)", page);
  await wait("!document.getElementById('rc-target').classList.contains('me-ad-class')", page);
  check(true, 'with stay, remove-class keeps removing the class when the page adds it back');
  check(await evaluate("localStorage.getItem('meConsent') === 'accepted' && document.cookie.split('; ').includes('meConsent=yes')", page),
    'set-local-storage-item and set-cookie set their fixed values');
  const acs = await evaluate(`(() => {
    const run = text => { const script = document.createElement('script'); script.textContent = text; document.head.append(script); script.remove(); };
    run('window.meAcsTarget; window.meAcsAborted = false; // me-acs-needle');
    run('window.meAcsTarget; window.meAcsControl = true;');
    return { aborted: window.meAcsAborted === undefined, control: window.meAcsControl === true, errors: window.meSawErrors.slice() };
  })()`, page);
  const described = (passed, text) => passed ? text : text + ' FAILED: ' + JSON.stringify(acs);
  check(acs.aborted && acs.control, described(acs.aborted && acs.control, 'abort-current-script stops only the script whose text matches'));
  // Started late, an error handler the page set first can still see the abort:
  // Chrome and Edge call it before the scriptlets' own listener, Firefox after.
  if (early) check(!acs.errors.length, described(!acs.errors.length, 'the page\'s error handler never sees an aborted script'));
  else {
    const seen = acs.errors.length <= 1 && acs.errors.every(message => /ReferenceError/.test(message));
    check(seen, described(seen, 'started late, only an error handler the page set first can see the abort'));
  }
  check(await evaluate('window.meExcepted === undefined', page), 'an exact #@#+js() exception cancels its scriptlet');
  const frame = await evaluate('window.meFrameState()', page);
  check(crossOrigin ? frame?.flag === true && frame.topFlag === null : frame?.topFlag === true,
    crossOrigin ? 'a cross-origin frame runs its own host\'s scriptlets, not the top page\'s' : 'frames run the scriptlets of their host too');
  if (early) {
    check(await evaluate("window.meFirst.flag === true && window.meFirst.storage === 'accepted'", page), 'scriptlets ran before the page\'s first script');
    check(await evaluate('window.meRmntRan === undefined', page), 'remove-node-text emptied an inline script before it could run');
    if (crossOrigin) check(frame.first === true, 'a frame\'s scriptlets also ran before its first script');
  }
  await close(page);

  if (popup) {
    await wait('!busy && toggleScriptlets.checked && !toggleScriptlets.disabled', popup);
    await evaluate('(toggleScriptlets.click(), true)', popup);
    await wait('!busy && currentSettings.scriptletFiltering === false && !toggleScriptlets.checked', popup);
    await evaluate('(toggleScriptlets.click(), true)', popup);
    await wait('!busy && currentSettings.scriptletFiltering === true && toggleScriptlets.checked', popup);
    check(true, 'the popup switch turns scriptlet filters off and on');
  }
  // Turned off three ways; a page loaded afterwards runs none of them. A late
  // start would arrive with the frame's first hiding request, so allow time for it.
  const pauseSite = paused => send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused }).then(result => { if (!result.ok) throw new Error(result.error); });
  for (const [off, on, what] of [[() => patch({ scriptletFiltering: false }), () => patch({ scriptletFiltering: true }), 'their own switch'],
    [() => patch({ cosmeticFiltering: false }), () => patch({ cosmeticFiltering: true }), 'cosmetic hiding'], [() => pauseSite(true), () => pauseSite(false), 'a site pause']]) {
    await off();
    page = await open(url);
    if (!early) await pause(1500);
    check(await evaluate('window.meFlag === undefined && window.meRmntRan === true', page), `no scriptlet runs while turned off by ${what}`);
    // A paused top page also turns them off in a frame from another site. Started
    // at document start, a frame learns its top page from location.ancestorOrigins;
    // a browser without it would still run the frame's own site's scriptlets.
    if (what === 'a site pause' && crossOrigin) {
      const paused = await evaluate('window.meFrameState()', page);
      if (!early || await evaluate("'ancestorOrigins' in location", page)) check(paused?.flag === null, 'a frame of a paused page runs no scriptlets');
      else check(paused?.flag === true, 'without ancestorOrigins, a document-start frame of a paused page runs its own site\'s scriptlets (documented limit)');
    }
    await close(page);
    await on();
  }
  if (listsUrl) {
    const lists = await open(listsUrl);
    await wait("document.getElementById('scriptletStatus').textContent.includes('scriptlet rules start')", lists);
    const status = await evaluate("document.getElementById('scriptletStatus').textContent", lists);
    check(early ? /start before each page's own scripts/.test(status) : /start as each page loads/.test(status),
      'My lists says when scriptlet filters start: ' + status);
    check(await evaluate("document.getElementById('scriptletFiltering').checked && !document.getElementById('scriptletFiltering').disabled", lists),
      'My lists shows the scriptlet switch on');
    check(early === await evaluate("document.getElementById('scriptletActions').hidden", lists),
      early ? 'no access action is offered once scriptlets start first' : 'My lists offers userscript access so scriptlets can start first');
    await close(lists);
  }
  await save(previous);
  // The lists' rules are never registered; they start as each page loads.
  const after = (await send({ type: 'GET_STATE' })).scriptletStatus;
  check(after?.rules === listRules && after.own === 0 && after.mode === (listRules ? 'late' : 'off'),
    `removing the rules leaves the lists' ${listRules.toLocaleString('en')} scriptlet rules, which start as each page loads`);
}

module.exports = { serve, verify, RULES, served };
