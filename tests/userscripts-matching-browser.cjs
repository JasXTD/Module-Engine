/* Native URL scopes, with fixed domain aliases forwarded only to owned loopback. */
'use strict';
const http = require('node:http');
const ALIASES = new Set(['matching.example.com', 'matching.example.org', 'matching.example.com.evil.invalid']);
function forwardMatching(request, response, state, evidence) {
  if (!state.port) return false;
  let url; try { url = new URL(request.url); } catch { return false; }
  if (url.protocol !== 'http:' || url.username || url.password || !ALIASES.has(url.hostname) ||
      url.port !== String(state.port) || !url.pathname.startsWith('/matching/') || !['GET', 'HEAD'].includes(request.method)) return false;
  // Never resolve the URL's hostname or follow redirects. Only this test's
  // already-listening server can receive the request.
  (evidence.matchingAliasRequests ||= []).push({ url: url.href, destination: '127.0.0.1:' + state.port });
  const upstream = http.request({ hostname: '127.0.0.1', port: state.port, path: url.pathname + url.search,
    method: request.method, headers: { host: url.host, connection: 'close' } }, result => {
    response.writeHead(result.statusCode, result.headers); result.pipe(response);
  });
  upstream.on('error', error => { evidence.proxyErrors.push(error.message); response.destroy(); });
  response.on('close', () => upstream.destroy());
  upstream.end(); return true;
}
async function runMatching({ b, manager, send, check, until, port, aliasState, evidence }) {
  const ids = [], pages = new Set(), base = 'http://127.0.0.1:' + port;
  const install = async (name, scope, body, grants = 'none', extra = '') => {
    const source = '// ==UserScript==\n// @name ' + name + '\n// @namespace offline.matching\n' + scope + '\n// @grant ' + grants + '\n' + extra + '// ==/UserScript==\n' + body;
    const saved = await send({ type: 'US_SAVE', source });
    check('Matching source validates: ' + name, saved.ok);
    const script = saved.scripts.find(item => item.id === saved.selectedId); ids.push(script.id);
    const enabled = await send({ type: 'US_ENABLE', id: script.id, revision: script.revision, enabled: true });
    if (!enabled.ok) evidence.matchingFailure = enabled;
    check('Matching native registration succeeds: ' + name, enabled.ok);
    return script.id;
  };
  const remove = async id => {
    const script = (await send({ type: 'US_LIST' })).scripts.find(item => item.id === id);
    if (script) check('Matching fixture removed: ' + script.metadata.name, (await send({ type: 'US_DELETE', id, revision: script.revision })).ok);
  };
  const page = async url => {
    const target = await b.open(url); pages.add(target);
    await until('document.body.dataset.matchingSettled === "true"', target);
    return target;
  };
  const marker = 'document.body.dataset.matchingRan="true";';
  try {
    aliasState.port = port;
    await install('Matching ready marker', '// @match http://*/*', 'document.body.dataset.matchingSettled="true";', 'none', '// @run-at document-idle\n');
    for (const [name, scope, yes, no] of [
      ['Partial host and explicit port', '// @match http*://127.0.*:' + port + '/matching/port*', base + '/matching/port', 'http://matching.example.com:' + port + '/matching/port'],
      ['Wrong port guard', '// @match http://127.0.0.1:' + (port === 65535 ? 65534 : port + 1) + '/matching/port*\n// @include ' + base + '/matching/yes', base + '/matching/yes', base + '/matching/port'],
      ['Fragment match and exclusion', '// @match http://127.0.0.1:' + port + '/matching/fragment#good*\n// @exclude-match http://127.0.0.1:' + port + '/matching/fragment#good-deny', base + '/matching/fragment#good', base + '/matching/fragment#good-deny'],
      ['Regex includes and exclusion', '// @include /^http:\\/\\/127\\.0\\.0\\.1:' + port + '\\/matching\\/(?:regex|denied)\\/[a-z]+(?:\\?id=\\d+)?$/\n// @exclude /\\/denied\\//', base + '/matching/ReGeX/one?id=12', base + '/matching/denied/one'],
      ['Public suffix match', '// @match http://matching.example.tld:' + port + '/matching/suffix*', 'http://matching.example.com:' + port + '/matching/suffix', 'http://matching.example.com.evil.invalid:' + port + '/matching/suffix'],
      ['Public suffix include', '// @include http://matching.example.tld:' + port + '/matching/suffix*', 'http://matching.example.org:' + port + '/matching/suffix', 'http://matching.example.com.evil.invalid:' + port + '/matching/suffix']
    ]) {
      // A native prefilter can match the negative page; both worlds must still
      // leave its document untouched, and GM uses the same exact scope.
      for (const world of ['isolated', 'page']) {
        const body = marker + (world === 'isolated' ? 'GM.getValue("probe","ok").then(value=>document.body.dataset.matchingGM=value);' : 'window.matchingPageWorld=true;');
        const id = await install(name + ' (' + world + ')', scope, body, world === 'isolated' ? 'GM.getValue' : 'none', world === 'page' ? '// @inject-into page\n' : '');
        const good = await page(yes);
        await until('document.body.dataset.matchingRan === "true"', good);
        if (world === 'isolated') await until('document.body.dataset.matchingGM === "ok"', good);
        else check(name + ': page world executes', await b.evaluate('window.matchingPageWorld===true', good));
        check(name + ': positive scope executes in ' + world, await b.evaluate('document.body.dataset.matchingRan==="true"', good));
        const bad = await page(no);
        check(name + ': negative scope is untouched in ' + world, await b.evaluate('document.body.dataset.matchingRan===undefined&&window.matchingPageWorld===undefined', bad));
        check(name + ': ad subresource stays blocked', await b.evaluate('window.fixtureAd===undefined', good));
        await remove(id);
        for (const target of [good, bad]) { await b.closePage(target); pages.delete(target); }
      }
    }
    const stale = await install('Regex scope revokes after history change', '// @include /^http:\\/\\/127\\.0\\.0\\.1:' + port + '\\/matching\\/allowed$/',
      marker + 'document.addEventListener("matching-probe",()=>GM.getValue("probe").then(()=>document.body.dataset.matchingProbe="accepted",()=>document.body.dataset.matchingProbe="denied"));', 'GM.getValue');
    const current = await page(base + '/matching/allowed'); await until('document.body.dataset.matchingRan==="true"', current);
    await b.evaluate('(()=>{history.pushState(null,"","/matching/outside");document.dispatchEvent(new Event("matching-probe"));})()', current);
    await until('document.body.dataset.matchingProbe==="denied"', current);
    check('Native GM broker rejects requests after leaving the regex scope', await b.evaluate('document.body.dataset.matchingProbe==="denied"', current));
    const parent = await page(base + '/matching/container');
    await b.evaluate('(()=>{const f=document.createElement("iframe");f.id="matchingChild";f.src="/matching/allowed";document.body.append(f);})()', parent);
    await until('document.getElementById("matchingChild").contentDocument?.body?.dataset.matchingRan==="true"', parent);
    check('Native iframe scope can run without granting its parent scope', await b.evaluate('document.body.dataset.matchingRan===undefined', parent));
    await b.evaluate('(()=>{const w=document.getElementById("matchingChild").contentWindow;w.history.pushState(null,"","/matching/outside");w.document.dispatchEvent(new w.Event("matching-probe"));})()', parent);
    await until('document.getElementById("matchingChild").contentDocument.body.dataset.matchingProbe==="denied"', parent);
    check('Native GM broker checks the current child-frame URL after history changes', await b.evaluate('document.getElementById("matchingChild").contentDocument.body.dataset.matchingProbe==="denied"', parent));
    await remove(stale);
    const bad = await send({ type: 'US_SAVE', source: '// ==UserScript==\n// @name Rejected regex\n// @include /(?=unsafe)/\n// ==/UserScript==\n' });
    check('Unsupported regex imports fail visibly without creating a script', !bad.ok && /lookarounds/.test(bad.error));
    check('Fixed suffix aliases were served only by loopback', evidence.matchingAliasRequests?.length >= 8 && evidence.matchingAliasRequests.every(item => item.destination === '127.0.0.1:' + port));
    check('Ad blocking is still enabled after matching checks', (await send({ type: 'GET_STATE' })).settings.enabled);
    evidence.matchingCompleted = true;
  } finally {
    aliasState.port = null;
    for (const id of ids) await remove(id);
    for (const target of pages) await b.closePage(target);
  }
}
module.exports = { forwardMatching, runMatching };
