/* Authored loopback fixtures only. Never invoke an unguarded permission request
 * or subscribe to a real push service. Use native input for page repairs. */
const fs = require('node:fs/promises');
const path = require('node:path');

function serve(req, res) {
  const url = new URL(req.url, 'http://fixture.invalid');
  if (url.pathname === '/prompt-worker.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end('self.addEventListener("install", () => self.skipWaiting()); self.addEventListener("activate", event => event.waitUntil(clients.claim()));');
    return true;
  }
  if (url.pathname !== '/prompt-fixture') return false;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Local prompt protection fixtures</title>
    <script>window.firstPermission = Notification.permission;
    window.firstNative = /\\[native code\\]/.test(Notification.requestPermission.toString());
    window.firstResult = null; window.callbackResult = null;
    if (!firstNative && ${!url.searchParams.has('passive')}) Notification.requestPermission(value => callbackResult = value).then(value => firstResult = value);
    </script><main><button id="request">Request notifications</button><p>Local fixtures only</p></main>
    <script>document.getElementById('request').onclick = () => {
      if (!/\\[native code\\]/.test(Notification.requestPermission.toString())) Notification.requestPermission().then(value => window.clickedResult = value);
    };</script>`);
  return true;
}

async function verify({ browser: b, page: existing, send, state, until, check, temporary }) {
  const original = (await state()).settings;
  const originalHostname = await b.evaluate('activeHostname');
  const saved = Object.fromEntries(['enabled', 'cosmeticFiltering', 'notificationPromptBlocking', 'deceptivePromptBlocking',
    'promptAllowedDomains', 'whitelistedDomains'].map(key => [key, original[key]]));
  const origin = await b.evaluate('location.origin', existing);
  const patch = async patch => { const result = await send({ type: 'UPDATE_SETTINGS', patch }); if (!result.ok) throw new Error(result.error); };
  const command = async message => { const result = await send(message); if (!result.ok) throw new Error(result.error); return result; };
  let page;
  const evaluate = expression => b.evaluate(expression, page);
  const wait = expression => until(b, expression, page);
  const hidden = id => `(getComputedStyle(document.getElementById(${JSON.stringify(id)})).display === 'none')`;
  const click = async id => {
    const box = await evaluate(`(() => { const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await b.clickAt(box.x, box.y, page);
  };
  const control = async (id, target = b.popup) => {
    await until(b, `!document.getElementById(${JSON.stringify(id)}).disabled && !busy`, target);
    const point = await b.evaluate(`(() => { const node=document.getElementById(${JSON.stringify(id)}); node.scrollIntoView({block:'center'});
      const rect=node.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`, target);
    await b.clickAt(point.x, point.y, target);
  };
  const capture = async (name, target = page) => {
    if (b.send) {
      const result = await b.send('Page.captureScreenshot', { format: 'png' }, target);
      await fs.writeFile(path.join(temporary, `prompts-${name}.png`), Buffer.from(result.data, 'base64'));
    } else await b.screenshot(path.join(temporary, `prompts-${name}.png`), target);
  };
  const install = '<h2>Install HD codec to watch this video</h2><p>Required video player component</p><button>Install codec</button>';
  const notification = '<h2>Click Allow to prove you are human</h2><button>Allow</button>';
  const setup = async (markup, { lock = true } = {}) => {
    await patch({ deceptivePromptBlocking: false, notificationPromptBlocking: false });
    await wait('![...document.querySelectorAll("style")].some(style => style.textContent.includes("data-module-engine-overlay-"))');
    await evaluate(`(() => {
      document.documentElement.removeAttribute('style'); document.body.removeAttribute('style');
      document.body.innerHTML = ${JSON.stringify('<style>body{margin:0;font:16px system-ui}main{padding:32px;min-height:3500px}.promotion{position:fixed;inset:0;background:#172023ee;color:white;padding:25vh 15vw;z-index:20}.small{position:fixed;right:20px;top:20px;width:300px;min-height:120px;padding:20px;background:#fff;color:#111;z-index:30}.scrim{position:fixed;inset:0;background:#0009;z-index:10}dialog::backdrop{background:#0009}button{padding:12px}</style><main id=content><button id=read>Read local article</button><article id=article>A legitimate article</article><section id=inert-widget inert>Disabled widget</section><div id=ad class=ad-slot>Local ad canary</div></main>' + markup)};
      window.readClicks=0; document.getElementById('read').onclick=()=>readClicks++;
      if (${lock}) { document.body.style.overflow='hidden'; document.body.style.pointerEvents='none'; document.body.style.touchAction='none'; document.getElementById('content').inert=true; }
      scrollTo(0,0);
    })()`);
  };
  const enable = () => patch({ deceptivePromptBlocking: true, notificationPromptBlocking: true });
  try {
    await patch({ enabled: true, cosmeticFiltering: true, notificationPromptBlocking: true, deceptivePromptBlocking: true, promptAllowedDomains: [], whitelistedDomains: [] });
    page = await b.open(origin + '/prompt-fixture');
    await wait('firstResult === "denied" && callbackResult === "denied"');
    check(await evaluate('firstNative === false && firstPermission === "default" && Notification.permission === "default"'),
      'notification guard is installed before the first page script and leaves native saved permission unchanged');
    await click('request'); await wait('clickedResult === "denied"');
    check(true, 'trusted click resolves denied without opening a notification permission request');
    check(await evaluate(`(async () => {
      const frame=document.createElement('iframe'); document.body.append(frame);
      const child=frame.contentWindow; const result=await child.Notification.requestPermission();
      const unchanged=child.Notification.permission==='default'; frame.remove(); return result==='denied'&&unchanged;
    })()`), 'fresh same-origin about:blank iframe cannot supply an unguarded request API through its realm getter');
    const push = await evaluate(`(async () => {
      if (!('serviceWorker' in navigator) || typeof PushManager==='undefined') return {supported:false};
      const registration=await navigator.serviceWorker.register('/prompt-worker.js'); await navigator.serviceWorker.ready;
      if (/\\[native code\\]/.test(registration.pushManager.subscribe.toString())) throw new Error('Refusing unguarded push test');
      try { await registration.pushManager.subscribe({userVisibleOnly:true}); return {supported:true,error:null}; }
      catch(error) { return {supported:true,error:error.name,permission:Notification.permission}; }
      finally { await registration.unregister(); }
    })()`);
    check(push.supported && push.error === 'NotAllowedError' && push.permission === 'default', 'PushManager subscribe prompt path is rejected before any push service request');
    await capture('notification-request');

    await setup(`<div id="scrim" class="scrim" aria-hidden="true"></div><section id="prompt" class="promotion">${install}</section>`);
    check(!(await evaluate(hidden('prompt'))), 'install overlay is present with the new filters off');
    await capture('before');
    await enable(); await wait(hidden('prompt') + ' && ' + hidden('scrim'));
    check(await evaluate('!document.getElementById("content").inert && document.getElementById("inert-widget").inert'), 'prompt cleanup restores main content without unlocking unrelated widgets');
    await click('read'); await wait('readClicks === 1');
    await b.pressKey('PageDown', page); await wait('scrollY > 0');
    check(true, 'removing install overlay and adjacent decorative scrim restores real clicks and scrolling');
    check(await evaluate(hidden('ad') + ' && document.getElementById("article").textContent === "A legitimate article"'), 'cosmetic ads stay hidden and article content stays intact');
    await capture('after');
    await command({ type: 'SET_SITE_PROMPTS', domain: '127.0.0.1', allowed: true });
    await wait('!' + hidden('prompt'));
    check(await evaluate('document.body.style.overflow === "hidden" && document.getElementById("content").inert'), 'trusted-site exception restores owned page locks and hidden prompt');
    const allowedPage = await b.open(origin + '/prompt-fixture?passive=1');
    check(await b.evaluate('firstNative && firstPermission === "default"', allowedPage), 'reloaded trusted site receives its unmodified notification API');
    await b.closePage(allowedPage);
    await command({ type: 'REMOVE_PROMPT_SITE', domain: '127.0.0.1' });
    await wait(hidden('prompt'));
    const scripts = await b.evaluate('api.scripting.getRegisteredContentScripts()');
    check(scripts.some(s => s.id === 'notification-guard' && s.runAt === 'document_start') && scripts.some(s => s.id === 'youtube-ads'), 'prompt registration and existing YouTube registration coexist');

    await setup(`<dialog id="prompt">${install}</dialog>`, { lock: false });
    await evaluate('document.getElementById("prompt").showModal()');
    await enable(); await wait(hidden('prompt') + ' && !document.getElementById("prompt").open');
    await click('read'); await wait('readClicks === 1');
    check(true, 'native modal is closed so its browser-managed backdrop and inertness are removed');
    await patch({ deceptivePromptBlocking: false });
    await wait('document.getElementById("prompt").matches(":modal")');
    check(true, 'disabling install filtering restores the original native modal');

    await setup(`<dialog id="ordinary"><h2>Save your work</h2><button>Save</button></dialog><dialog id="prompt">${install}</dialog>`, { lock: false });
    await evaluate('(() => { document.body.style.overflow="hidden"; document.getElementById("ordinary").showModal(); document.getElementById("prompt").showModal(); })()');
    await enable(); await wait(hidden('prompt'));
    check(await evaluate('document.getElementById("ordinary").matches(":modal") && document.body.style.overflow === "hidden"'), 'legitimate concurrent modal retains its native inertness and scroll lock');

    await setup(`<section id="prompt" class="promotion">${install}</section><section id="notify" class="small">${notification}</section>`);
    await enable(); await wait(hidden('prompt') + ' && ' + hidden('notify'));
    await patch({ deceptivePromptBlocking: false }); await wait('!' + hidden('prompt') + ' && ' + hidden('notify'));
    check(true, 'independent install switch restores only its prompt while notification preprompt filtering stays active');
    await patch({ notificationPromptBlocking: false }); await wait('!' + hidden('notify'));
    check(await evaluate('document.getElementById("content").inert'), 'disabling both policies restores their shared lock ownership');

    for (const [name, html] of [
      ['ordinary download dialog', '<dialog open id="prompt"><h2>Download the desktop app</h2><button>Download</button></dialog>'],
      ['extension product dialog without a gating claim', '<dialog open id="prompt"><h2>Install our browser extension</h2><button>Install extension</button></dialog>'],
      ['security warning', '<section id="prompt" class="promotion"><h2>Never install a codec to watch video</h2><button>Download guide</button></section>'],
      ['article quoting a deceptive prompt', `<section id="prompt" class="promotion"><article>${install}</article></section>`],
      ['ordinary inline content', `<section id="prompt">${install}</section>`],
      ['camera prompt', '<dialog open id="prompt"><h2>Allow camera access to continue</h2><button>Allow</button></dialog>'],
      ['legitimate CAPTCHA', '<dialog open id="prompt"><h2>Confirm you are human</h2><button>Verify</button></dialog>'],
      ['non-rendered data', '<dialog open id="prompt"><h2>Download data</h2><script type="application/json">"Install codec to watch video"</script><button>Download</button></dialog>']
    ]) {
      await setup(html + `<section id="positive" class="small">${notification}</section>`, { lock: false }); await enable();
      await wait(hidden('positive'));
      check(!(await evaluate(hidden('prompt'))), `${name} is preserved`);
    }

    await setup('<div id="host"></div>', { lock: false });
    await evaluate(`(() => { document.getElementById('host').attachShadow({mode:'open'}).innerHTML=${JSON.stringify('<dialog id="shadow">' + install + '</dialog>')}; document.getElementById('host').shadowRoot.getElementById('shadow').showModal(); })()`);
    await enable(); await wait('!document.getElementById("host").shadowRoot.getElementById("shadow").open');
    await click('read'); await wait('readClicks === 1');
    check(true, 'install prompt inside an open shadow root is closed and page input restored');
    await setup(`<dialog id="prompt">${install}</dialog>`, { lock: false });
    await evaluate('document.getElementById("prompt").showModal()'); await enable(); await wait(hidden('prompt'));
    await evaluate('(() => { document.getElementById("prompt").innerHTML="<h2>Save your work</h2><button>Save</button>"; document.getElementById("prompt").showModal(); })()');
    await wait('!' + hidden('prompt'));
    check(await evaluate('document.getElementById("prompt").matches(":modal")'), 'dialog reused for legitimate content is returned to the page');

    await setup(`<section id="prompt" class="promotion">${install}</section>`); await enable(); await wait(hidden('prompt'));
    await patch({ cosmeticFiltering: false });
    await wait('!document.getElementById("blockads-cosmetic-shield")');
    check(await evaluate(hidden('prompt')), 'prompt protection is independent of cosmetic ad hiding');
    await command({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: true }); await wait('!' + hidden('prompt'));
    const pausedPage = await b.open(origin + '/prompt-fixture?passive=1');
    check(await b.evaluate('firstNative', pausedPage), 'full site pause excludes notification hook on the next navigation');
    await b.closePage(pausedPage);
    await command({ type: 'SET_SITE_PAUSED', domain: '127.0.0.1', paused: false });
    await wait(hidden('prompt'));
    await patch({ enabled: false }); await wait('!' + hidden('prompt'));
    check(!(await b.evaluate('api.scripting.getRegisteredContentScripts()')).length, 'master pause unregisters notification protection with the other page hooks');

    await patch(saved);
    await until(b, '!busy && currentSettings.notificationPromptBlocking');
    await b.evaluate('(activeHostname="127.0.0.1", currentDomainEl.textContent=activeHostname, renderUI(), true)');
    await control('toggleSitePrompts');
    await until(b, '!busy && currentSettings.promptAllowedDomains.includes("127.0.0.1")');
    check(await b.evaluate('!toggleSitePrompts.checked && /127.0.0.1/.test(document.getElementById("promptScope").textContent)'), 'native popup switch adds a visible trusted-site prompt exception');
    await control('toggleSitePrompts');
    await until(b, '!busy && !currentSettings.promptAllowedDomains.includes("127.0.0.1")');
    await control('toggleNotificationPrompts');
    await until(b, '!busy && !currentSettings.notificationPromptBlocking');
    check(await b.evaluate('currentSettings.deceptivePromptBlocking && currentSettings.rulesets.ads_ruleset'), 'native notification switch leaves install protection and ads enabled');
    await control('toggleNotificationPrompts');
    await until(b, '!busy && currentSettings.notificationPromptBlocking');
    if (b.send) await b.send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false}, b.popup);
    await b.evaluate('(document.getElementById("toggleNotificationPrompts").scrollIntoView({block:"center"}), true)');
    await capture('popup', b.popup);
    check(await b.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'popup prompt controls fit without horizontal overflow');
    const lists = await b.open(await b.evaluate('api.runtime.getURL("src/ui/lists/lists.html#promptExceptions")'));
    await until(b, 'typeof settings !== "undefined" && settings !== null && !busy', lists);
    await b.evaluate('document.getElementById("promptExceptions").scrollIntoView()', lists);
    await capture('exceptions', lists);
    check(await b.evaluate('document.querySelector("#promptExceptions input").getAttribute("aria-label") === "Site to allow prompts and buttons on"', lists), 'trusted prompt exception controls are labeled and available on My lists');
    await b.closePage(lists);
  } catch (error) {
    if (page) {
      await capture('failure');
      await fs.writeFile(path.join(temporary, 'prompts-failure.json'), JSON.stringify(await evaluate(`({body:document.body.innerHTML,
        locks:document.body.style.cssText, hidden:[...document.querySelectorAll('[id]')].map(element=>({id:element.id,
          display:getComputedStyle(element).display,open:element.open,rect:element.getBoundingClientRect().toJSON()}))})`), null, 2));
    }
    throw error;
  } finally {
    if (page) await b.closePage(page);
    await patch(saved);
    await b.evaluate(`(activeHostname=${JSON.stringify(originalHostname)}, currentDomainEl.textContent=activeHostname||'Browser / unsupported page', renderUI(), true)`);
    if (b.send) await b.send('Emulation.clearDeviceMetricsOverride', {}, b.popup);
  }
}
module.exports = { serve, verify };
