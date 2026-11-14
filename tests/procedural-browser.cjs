/* Real-DOM tests on the smoke suite's loopback page; no external resources. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async function verifyProcedures({ browser, page, send, state, until, check, root }) {
  const evaluate = expression => browser.evaluate(expression, page);
  const wait = expression => until(browser, expression, page);
  const display = id => `getComputedStyle(document.getElementById(${JSON.stringify(id)})).display`;
  const hidden = id => wait(`${display(id)} === 'none'`);
  const visible = id => wait(`${display(id)} !== 'none'`);
  const save = async text => {
    const result = await send({ type: 'SAVE_COSMETIC_FILTERS', previous: (await state()).settings.customCosmeticFilters, text });
    if (!result.ok) throw new Error(result.error);
  };
  const patch = values => send({ type: 'UPDATE_SETTINGS', patch: values }).then(result => {
    if (!result.ok) throw new Error(result.error);
  });
  const label = '#ba-fixture .ba-label:has-text(Sponsored):upward(1)';
  const rules = [label, '#ba-fixture .ba-card:-abp-has(> .ba-inner:-abp-contains(广告))',
    '#ba-fixture .ba-partner:has-text(Partner):upward(.ba-card)'];
  const filters = rules.map(selector => '127.0.0.1##' + selector).join('\n');
  await evaluate(`(() => {
    const section = document.createElement('div'); section.id = 'ba-fixture';
    section.innerHTML = '<section id="ba-match" class="ba-card" style="display:block;color:rgb(20,30,40)"><span class="ba-label"><b>Spon</b>sored</span><p>Local content</p></section>' +
      '<section id="ba-neighbor" class="ba-card"><span class="ba-label">Editorial</span></section>' +
      '<section id="ba-nested" class="ba-card"><span class="ba-inner">推荐广告</span></section>' +
      '<section id="ba-deeper" class="ba-card"><div><span class="ba-inner">广告</span></div></section>' +
      '<section id="ba-ancestor" class="ba-card"><div><span class="ba-partner">Partner</span></div></section>';
    document.body.append(section);
    window.baInline = document.getElementById('ba-match').getAttribute('style');
    return true;
  })()`);
  await save(filters);
  await hidden('ba-match'); await hidden('ba-nested'); await hidden('ba-ancestor');
  await evaluate("(window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true})), true)");
  check(await evaluate(`${display('ba-match')} === 'none'`), 'a synthetic page lifecycle event cannot disable advanced hiding');
  check(await evaluate(`${display('ba-neighbor')} !== 'none' && ${display('ba-deeper')} !== 'none'`),
    'procedures match split text, direct-child Unicode text and ancestors while preserving neighboring content');
  check(await evaluate("document.getElementById('ba-match').getAttribute('style') === window.baInline"),
    'procedural hiding preserves the page\'s original inline styles');
  await evaluate("(document.querySelector('#ba-match b').firstChild.data = 'Editor', document.querySelector('#ba-match .ba-label').lastChild.data = 'ial', true)");
  await visible('ba-match');
  check(true, 'character-data changes restore a container that no longer matches');
  await evaluate(`(() => { const card = document.getElementById('ba-match').cloneNode(true); card.id = 'ba-insert';
    card.querySelector('.ba-label').textContent = 'Sponsored'; document.getElementById('ba-fixture').append(card); return true; })()`);
  await hidden('ba-insert');
  check(true, 'new matching containers are hidden after insertion');
  await evaluate("(document.getElementById('ba-neighbor').append(document.querySelector('#ba-insert .ba-label')), true)");
  await visible('ba-insert'); await hidden('ba-neighbor');
  check(true, 'moving a matching label restores its former parent and hides its new parent');
  await evaluate("(window.baDetached = document.getElementById('ba-neighbor'), window.baDetached.remove(), true)");
  await wait("!window.baDetached.getAttributeNames().some(name => name.startsWith('data-blockads-procedural-'))");
  check(true, 'detached containers lose owned markers and are released');
  await evaluate("(document.querySelector('#ba-match .ba-label').textContent = 'Sponsored', true)");
  await hidden('ba-match');
  await save(filters + '\n127.0.0.1#@#' + label);
  await visible('ba-match'); await hidden('ba-nested');
  check(true, 'an exact procedural exception restores only its matching rule');
  await save(filters + '\n127.0.0.1,~127.0.0.1###ba-deeper:has-text(广告)');
  await hidden('ba-match'); await visible('ba-deeper');
  check(true, 'excluded sites cannot activate a procedural rule');
  await save(filters);
  await patch({ genericCosmeticFiltering: false });
  await hidden('ba-match');
  check(true, 'site-specific procedures remain active with generic CSS disabled');
  await patch({ genericCosmeticFiltering: true });

  // Exercise the actual editor and popup setting, including cross-window state.
  const editor = await browser.open(await browser.evaluate('api.runtime.getURL("src/ui/lists/lists.html")'));
  await until(browser, 'settings && !busy && !document.getElementById("proceduralFiltering").disabled', editor);
  await browser.evaluate('(document.getElementById("proceduralFiltering").click(), true)', editor);
  await visible('ba-match');
  await until(browser, '!busy && !currentSettings.proceduralFiltering && !toggleProcedural.checked');
  check(await evaluate(`${display('ad')} === 'none'`), 'advanced-hiding switch restores its changes while ordinary cosmetic filtering remains active');
  await until(browser, '!busy && !toggleProcedural.disabled');
  await browser.evaluate('(toggleProcedural.click(), true)');
  await hidden('ba-match');
  await until(browser, '!busy && settings.proceduralFiltering && document.getElementById("proceduralFiltering").checked', editor);
  check(true, 'popup and editor advanced-hiding controls stay synchronized');
  await browser.closePage(editor);

  for (const setting of ['cosmeticFiltering', 'enabled']) {
    await patch({ [setting]: false }); await visible('ba-match');
    await patch({ [setting]: true }); await hidden('ba-match');
    check(true, `${setting} pause restores and resumes procedural changes`);
  }
  await patch({ cosmeticPausedDomains: ['127.0.0.1'] }); await visible('ba-match');
  check((await browser.evaluate('api.declarativeNetRequest.getEnabledRulesets()')).includes('community_ruleset'),
    'cosmetic-only site pause restores procedures while network filtering remains enabled');
  await patch({ cosmeticPausedDomains: [] }); await hidden('ba-match');
  await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: true }); await visible('ba-match');
  await send({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: false }); await hidden('ba-match');
  check(true, 'full site pause restores and resumes procedural changes');
  await save('127.0.0.1###ba-match .ba-label:has-text(Sponsored):upward(body)');
  await visible('ba-match');
  check(await evaluate("getComputedStyle(document.body).display !== 'none'"), 'ancestor selection cannot hide the document body');
  await save('127.0.0.1#?##ba-match:has(> .ba-label)'); await hidden('ba-match');
  await patch({ proceduralFiltering: false }); await visible('ba-match');
  await patch({ proceduralFiltering: true }); await hidden('ba-match');
  check(true, 'an explicit procedural separator keeps native CSS under the advanced-hiding switch');

  const logCount = async () => (await send({ type: 'GET_LOG' })).entries.filter(entry => /Advanced page hiding stopped.*scan limit/.test(entry.message)).length;
  const before = await logCount();
  const overLimit = Array.from({ length: 65 }, (_, i) => '127.0.0.1###ba-fixture .ba-limit-' + i + ':has-text(Ad)').join('\n');
  await save(overLimit + '\n127.0.0.1###ba-deeper');
  await hidden('ba-deeper'); await visible('ba-match');
  await until(browser, `api.runtime.sendMessage({type:'GET_LOG'}).then(log => log.entries.filter(entry => /Advanced page hiding stopped.*scan limit/.test(entry.message)).length === ${before + 1})`);
  check(true, 'exceeding the default procedural rule limit restores advanced hides, keeps CSS and reports a fixed activity event');
  await patch({ flagSuspects: false });
  await until(browser, '!busy && !currentSettings.flagSuspects');
  check(await logCount() === before + 1, 'unrelated settings do not retry or repeat the warning for a suspended rule set');
  await patch({ flagSuspects: true });
  await save(filters); await hidden('ba-match'); await visible('ba-deeper');
  check(true, 'changing the rule set recovers from a procedural scan limit');
  await save(''); await visible('ba-match'); await visible('ba-nested'); await visible('ba-ancestor');
  check(await evaluate("!document.getElementById('blockads-procedural-shield') && document.getElementById('ba-match').getAttribute('style') === window.baInline"),
    'clearing custom procedures removes their style and restores original display');

  // The same source runs against a real browser DOM here, with smaller limits
  // to deterministically test each independent budget and lifecycle branch.
  await evaluate('(() => {\n' + (await fs.readFile(path.join(root, 'src/blocking/cosmetic.js'), 'utf8')) + '\n' +
    (await fs.readFile(path.join(root, 'src/blocking/procedural.js'), 'utf8')) + '\nreturn true; })()');
  const simple = [{ selector: '#ba-fixture .ba-card:has-text(never-matches)' }];
  for (const limits of [{ candidates: 2 }, { operations: 1 }, { characters: 2 }, { milliseconds: -1 }]) {
    await evaluate(`(() => { window.baProblems = []; window.baEngine = BlockAdsProcedural.create({document,
      limits: {...BlockAdsProcedural.DEFAULT_LIMITS, ...${JSON.stringify(limits)}}, onProblem: reason => window.baProblems.push(reason)});
      window.baEngine.setRules(${JSON.stringify(simple)}); return true; })()`);
    await wait("window.baProblems.length === 1");
    check(await evaluate("window.baProblems[0] === 'limit' && !document.querySelector('[id=blockads-procedural-shield]')"),
      `real-DOM ${Object.keys(limits)[0]} budget stops without applying partial results`);
    await evaluate('(window.baEngine.clear(), true)');
  }
  const one = [{ selector: label }];
  await evaluate(`(() => { window.baProblems = []; window.baAlive = true; window.baEngine = BlockAdsProcedural.create({document,
    isAlive: () => window.baAlive, onProblem: reason => window.baProblems.push(reason)});
    window.baEngine.setRules(${JSON.stringify(one)}); window.baEngine.clear(); return true; })()`);
  await evaluate('new Promise(resolve => setTimeout(() => resolve(true), 150))');
  check(await evaluate(`${display('ba-match')} !== 'none' && !document.getElementById('blockads-procedural-shield')`),
    'cleanup cancels a pending initial scan');
  await evaluate(`(window.baEngine.setRules(${JSON.stringify(one)}), true)`); await hidden('ba-match');
  await evaluate("(window.baAlive = false, document.getElementById('ba-match').dataset.wake = '1', true)");
  await visible('ba-match');
  check(true, 'an invalidated extension context restores owned changes and stops observing');
  await evaluate(`(window.baAlive = true, window.baEngine.setRules(${JSON.stringify([{ selector: '.ba-card:made-up-css(Something):has-text(Ad)' }, ...one])}), true)`);
  await hidden('ba-match');
  check(await evaluate("window.baProblems.includes('invalid')"), 'an invalid browser CSS selector is reported without suppressing valid procedures');
  await evaluate(`(() => { window.baWrites = 0; window.baObserver = new MutationObserver(records => {
    window.baWrites += records.filter(record => record.attributeName?.startsWith('data-blockads-procedural-')).length; });
    window.baObserver.observe(document.getElementById('ba-fixture'), {subtree:true, attributes:true});
    document.getElementById('ba-match').dataset.wake = '2'; return true; })()`);
  await evaluate('new Promise(resolve => setTimeout(() => resolve(true), 350))');
  check(await evaluate('window.baWrites === 0'), 'unchanged matches do not repeatedly rewrite markers or trigger a feedback loop');
  await evaluate("(() => { const element = document.getElementById('ba-match'); element.removeAttribute(element.getAttributeNames().find(name => name.startsWith('data-blockads-procedural-'))); return true; })()");
  await hidden('ba-match');
  check(true, 'removing an owned marker triggers a bounded repair');
  await evaluate('(document.getElementById("blockads-procedural-shield").remove(), true)');
  await hidden('ba-match');
  check(true, 'removing the owned style triggers a bounded repair');
  await evaluate(`(() => { window.baEngine.clear(); window.baProblems = [];
    window.baQuery = document.querySelectorAll; document.querySelectorAll = () => { throw new Error('Injected DOM failure'); };
    window.baEngine.setRules(${JSON.stringify(one)}); return true; })()`);
  await wait("window.baProblems.length === 1");
  check(await evaluate("window.baProblems[0] === 'error' && !document.getElementById('blockads-procedural-shield')"),
    'unexpected DOM failures restore changes and are reported as errors rather than scan limits');
  await evaluate('(document.querySelectorAll = window.baQuery, true)');
  await evaluate("(window.baObserver.disconnect(), window.baEngine.clear(), document.getElementById('ba-fixture').remove(), window.baDetached = null, true)");

  const originalUrl = await evaluate('location.href');
  const nextUrl = originalUrl + '?ba-navigation';
  await save('127.0.0.1###normal:has-text(Normal content)'); await hidden('normal');
  await evaluate(`(() => { sessionStorage.setItem('ba-navigation-result', JSON.stringify({stage:'registered'}));
    window.addEventListener('pagehide', event => {
    const result = {stage:'pagehide', trusted:event.isTrusted, persisted:event.persisted};
    try { result.markerLeft = document.getElementById('normal')?.getAttributeNames().some(name => name.startsWith('data-blockads-procedural-'));
      result.styleLeft = Boolean(document.getElementById('blockads-procedural-shield')); }
    catch (error) { result.error = error.message; }
    sessionStorage.setItem('ba-navigation-result', JSON.stringify(result));
    }, {once:true}); return true; })()`);
  await browser.navigate(page, nextUrl);
  await wait(`location.href === ${JSON.stringify(nextUrl)} && document.readyState === 'complete' && document.getElementById('normal')`);
  await hidden('normal');
  const navigationResult = await evaluate("JSON.parse(sessionStorage.getItem('ba-navigation-result'))");
  check(navigationResult?.trusted && navigationResult.markerLeft === false && navigationResult.styleLeft === false && !navigationResult.error,
    'a real browser pagehide restores markers and removes the owned style before leaving: ' + JSON.stringify(navigationResult));
  await browser.navigate(page, originalUrl);
  await wait(`location.href === ${JSON.stringify(originalUrl)} && document.readyState === 'complete' && typeof window.frameDisplay === 'function'`);
  await hidden('normal');
  check(true, 'procedures activate again after real navigation');
  await save(''); await visible('normal');
};
