/* Native input and extension settings on locally authored Reddit-shaped DOM.
 * The disposable package aliases only /reddit-fixture on 127.0.0.1 to Reddit.
 * No Reddit URL, asset, script, DNS lookup or network connection is used. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function aliasFixture(extension) {
  const file = path.join(extension, 'src/blocking/reddit.js');
  const original = await fs.readFile(file, 'utf8');
  const needle = 'hostname = doc.location.hostname,';
  if (original.split(needle).length !== 2) throw new Error('Reddit fixture alias no longer matches the factory');
  const modified = original.replace(needle, 'hostname = doc.location.hostname === "127.0.0.1" && doc.location.pathname === "/reddit-fixture" ? "www.reddit.com" : doc.location.hostname,');
  await fs.writeFile(file, modified);
  return { file: 'src/blocking/reddit.js', purpose: 'Only the factory hostname defaults to www.reddit.com on the owned loopback /reddit-fixture route',
    originalSha256: createHash('sha256').update(original).digest('hex'), fixtureSha256: createHash('sha256').update(modified).digest('hex') };
}

async function verify({ browser, page: existing, send, state, until, check, temporary }) {
  const origin = await browser.evaluate('location.origin', existing);
  const page = await browser.open(origin + '/reddit-fixture');
  const evaluate = expression => browser.evaluate(expression, page);
  const wait = expression => until(browser, expression, page);
  const patch = async values => {
    const response = await send({ type: 'UPDATE_SETTINGS', patch: values });
    if (!response.ok) throw new Error(response.error);
  };
  const capture = async name => {
    if (!browser.send) return; // Chromium page captures; Firefox uses DOM/native input evidence.
    const image = await browser.send('Page.captureScreenshot', { format: 'png' }, page);
    await fs.writeFile(path.join(temporary, `reddit-${name}.png`), Buffer.from(image.data, 'base64'));
  };
  const start = (await state()).settings;
  const promo = '<h2>Get the best of Reddit in the app</h2><p>Editors\u2019 Choice</p><button>Get the Reddit App</button>';
  const setup = async (kind = 'fixed', extra = '') => {
    await patch({ cosmeticFiltering: false });
    await wait('!document.getElementById("blockads-cosmetic-shield")');
    await evaluate(`(() => {
      document.documentElement.removeAttribute('style'); document.body.removeAttribute('style');
      document.body.innerHTML = ${JSON.stringify('<style>html{scroll-behavior:auto}body{margin:0}main{min-height:4000px;padding:32px}#read{position:relative;z-index:0}.promotion{position:fixed;inset:0;z-index:20;background:#172023ed;color:white;padding:30vh 15vw 0}.scrim{position:fixed;inset:0;z-index:10;background:#0009}dialog::backdrop{background:#0009}</style><main id="content"><button id="read">Read comments</button><article id="comment">Ordinary Reddit comment</article><section inert id="unrelated-inert"><button>Unavailable widget</button></section><div class="ad-slot" id="reddit-ad">Local ad canary</div></main>')};
      window.reads = 0; document.getElementById('read').onclick = () => window.reads++;
      const app = document.createElement(${JSON.stringify(kind === 'dialog' ? 'dialog' : 'div')});
      app.id = 'app-promo'; app.className = 'promotion'; app.innerHTML = ${JSON.stringify(promo)};
      document.body.append(app);
      if (${JSON.stringify(kind)} === 'dialog') app.showModal();
      else app.setAttribute('role', 'dialog');
      document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden';
      document.getElementById('content').setAttribute('inert','');
      ${extra}
      scrollTo(0,0); return true;
    })()`);
  };
  const hidden = () => wait('getComputedStyle(document.getElementById("app-promo")).display === "none"');
  const clickComment = async () => {
    await evaluate('(scrollTo(0,0), true)');
    const point = await evaluate('(() => { const r = document.getElementById("read").getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()');
    await browser.clickAt(point.x, point.y, page);
  };
  try {
    await patch({ enabled: true, cosmeticPausedDomains: [], whitelistedDomains: [], genericCosmeticFiltering: true });
    await setup('fixed');
    await clickComment();
    check(await evaluate('window.reads === 0 && getComputedStyle(document.documentElement).overflowY === "hidden" && document.getElementById("content").inert'),
      'Reddit baseline reproduces blocked clicks, an inert main area and a root scroll lock');
    await capture('before');
    await patch({ cosmeticFiltering: true }); await hidden();
    await clickComment();
    check(await evaluate('window.reads === 1 && !document.getElementById("content").inert && document.getElementById("unrelated-inert").inert'),
      'Reddit repair restores a native pointer click and main content while preserving an unrelated inert widget');
    await capture('after');
    await browser.pressKey('PageDown', page);
    await wait('scrollY > 100');
    check(true, 'Reddit repair restores scrolling from native PageDown input');
    check(await evaluate('document.getElementById("comment").textContent === "Ordinary Reddit comment" && getComputedStyle(document.getElementById("reddit-ad")).display === "none"'),
      'Reddit comments survive and the existing cosmetic ad canary remains hidden');

    for (const values of [{ cosmeticFiltering: false }, { enabled: false }, { cosmeticPausedDomains: ['127.0.0.1'] }, { whitelistedDomains: ['127.0.0.1'] }]) {
      await patch(values);
      await wait('getComputedStyle(document.getElementById("app-promo")).display !== "none"');
      check(await evaluate('document.getElementById("content").inert && getComputedStyle(document.documentElement).overflowY === "hidden"'),
        'Reddit repair reverses its changes for ' + Object.keys(values)[0]);
      await patch({ enabled: true, cosmeticFiltering: true, cosmeticPausedDomains: [], whitelistedDomains: [] }); await hidden();
    }
    await patch({ genericCosmeticFiltering: false, proceduralFiltering: false }); await hidden();
    check(true, 'Reddit repair uses the site Page hiding control independently of generic and advanced filters');
    await patch({ genericCosmeticFiltering: true, proceduralFiltering: true });

    // A different modal must retain its native inertness and its page lock.
    await evaluate(`(() => { const d = document.createElement('dialog'); d.id='login'; d.innerHTML='<h2>Log in to Reddit</h2><form><input aria-label="Username"></form>'; document.body.append(d); d.showModal(); document.body.style.overflow='hidden'; return true; })()`);
    await wait('getComputedStyle(document.body).overflowY === "hidden"');
    check(await evaluate('document.getElementById("login").matches(":modal") && getComputedStyle(document.getElementById("login")).display !== "none"'),
      'Reddit login dialog stays visible, modal and scroll-locked');
    await evaluate('(document.getElementById("login").close(), document.getElementById("login").remove(), true)');
    await wait('!document.getElementById("content").inert && getComputedStyle(document.body).overflowY !== "hidden"');

    // Newly mounted prompts are handled by the real content-script observer.
    await evaluate('(document.getElementById("app-promo").remove(), true)');
    await wait('document.body.style.overflowY !== "auto"');
    check(await evaluate('getComputedStyle(document.documentElement).overflowY !== "hidden" && !document.getElementById("content").inert'),
      'Removing the repaired prompt does not reinstall its orphaned scroll or inert lock');
    await evaluate(`(() => { const app=document.createElement('div'); app.id='app-promo'; app.className='promotion'; app.innerHTML=${JSON.stringify(promo)}; document.body.append(app); document.body.style.overflow='hidden'; return true; })()`);
    await hidden();
    check(await evaluate('getComputedStyle(document.body).overflowY !== "hidden"'), 'A dynamically inserted app prompt is hidden and unlocked');

    await setup('dialog');
    check(await evaluate('document.getElementById("app-promo").matches(":modal")'), 'Native Reddit app-modal baseline enters the browser top layer');
    await patch({ cosmeticFiltering: true }); await hidden(); await clickComment();
    check(await evaluate('!document.getElementById("app-promo").open && window.reads === 1'),
      'Native app modal is closed, releasing browser-owned inertness as well as its backdrop');
    await evaluate('(dispatchEvent(new PageTransitionEvent("pagehide", {persisted:true})), document.getElementById("app-promo").showModal(), true)');
    await wait('!document.getElementById("app-promo").open');
    check(true, 'A synthetic lifecycle event cannot stop repair when the page reopens the native app modal');
    await patch({ cosmeticFiltering: false });
    await wait('document.getElementById("app-promo").matches(":modal")');
    check(true, 'Pausing restores the app dialog in its original modal mode');

    await setup('fixed', 'const scrim=document.createElement("div"); scrim.id="scrim"; scrim.className="scrim"; scrim.setAttribute("aria-hidden","true"); app.before(scrim);');
    await patch({ cosmeticFiltering: true }); await hidden();
    await wait('getComputedStyle(document.getElementById("scrim")).display === "none"');
    check(true, 'An adjacent empty decorative fullscreen scrim is hidden with its app prompt');
    await evaluate('(document.getElementById("scrim").textContent="Ordinary reused content", true)');
    await wait('getComputedStyle(document.getElementById("scrim")).display !== "none"');
    check(true, 'A scrim reused for ordinary content is released');

    await setup('fixed', 'document.body.style.position="fixed"; document.body.style.top="-240px"; document.body.style.pointerEvents="none";');
    await patch({ cosmeticFiltering: true }); await hidden();
    check(await evaluate('getComputedStyle(document.body).position !== "fixed" && getComputedStyle(document.body).pointerEvents !== "none" && scrollY >= 240'),
      'Fixed-body locking and pointer suppression are released without losing the stored scroll offset');
    await evaluate('(document.body.style.pointerEvents="auto", document.body.style.color="rgb(1, 2, 3)", true)');
    await patch({ cosmeticFiltering: false });
    await wait('getComputedStyle(document.getElementById("app-promo")).display !== "none"');
    check(await evaluate('document.body.style.pointerEvents === "auto" && document.body.style.color === "rgb(1, 2, 3)"'),
      'Pausing preserves newer page style edits and unrelated declarations');

    await setup('fixed', 'document.documentElement.inert=true; const css=document.createElement("style"); css.textContent="body.app-locked{overflow:hidden;pointer-events:none}"; document.body.append(css); document.body.classList.add("app-locked");');
    await patch({ cosmeticFiltering: true }); await hidden();
    check(await evaluate('!document.documentElement.inert && getComputedStyle(document.body).pointerEvents !== "none"'),
      'Document-root inertness and class-based locks are released for the app prompt');
    await evaluate('(document.getElementById("app-promo").remove(), true)');
    await wait('!document.querySelector("h2") && ![...document.querySelectorAll("style")].some(s => s.textContent.includes("data-module-engine-overlay-"))');
    check(await evaluate('getComputedStyle(document.body).overflowY !== "hidden" && getComputedStyle(document.body).pointerEvents !== "none" && document.body.classList.contains("app-locked")'),
      'An orphaned class lock stays neutralized after prompt removal without deleting page classes');
    await evaluate('(document.body.classList.remove("app-locked"), true)');
    await wait('!document.body.style.overflowY && !document.body.style.pointerEvents');
    check(true, 'Removing the page lock class releases the remaining owned overrides');

    // Open shadow DOM gets its own stylesheet; page-wide CSS cannot reach it.
    await setup('fixed', 'const host=document.createElement("section"); host.id="shadow-host"; document.body.append(host); host.attachShadow({mode:"open"}).append(app); app.style.cssText="position:fixed;inset:0;z-index:20";');
    await patch({ cosmeticFiltering: true });
    await wait('getComputedStyle(document.getElementById("shadow-host").shadowRoot.querySelector("#app-promo")).display === "none"');
    await clickComment();
    check(await evaluate('window.reads === 1'), 'An app prompt in an open shadow root is hidden and main-page clicks work');
    await evaluate('(document.getElementById("shadow-host").shadowRoot.querySelector("h2").textContent="Ordinary content", true)');
    await wait('getComputedStyle(document.getElementById("shadow-host").shadowRoot.querySelector("#app-promo")).display !== "none"');
    await evaluate('(document.getElementById("shadow-host").shadowRoot.querySelector("h2").textContent="Get the best of Reddit in the app", true)');
    await wait('getComputedStyle(document.getElementById("shadow-host").shadowRoot.querySelector("#app-promo")).display === "none"');
    check(true, 'Mutations inside an existing open shadow root release and re-hide a reused app prompt');

    await setup('fixed', 'app.innerHTML="<h2>Log in to Reddit</h2><button>Continue</button>";');
    await patch({ cosmeticFiltering: true });
    await wait('document.getElementById("blockads-cosmetic-shield")');
    check(await evaluate('getComputedStyle(document.getElementById("app-promo")).display !== "none" && document.getElementById("content").inert'),
      'An ordinary login overlay is not mistaken for the app promotion');
    await evaluate(`(document.getElementById('app-promo').remove(), document.getElementById('content').innerHTML += ${JSON.stringify('<section><h2>Get the best of Reddit in the app</h2><button>Get the Reddit App</button></section>')}, true)`);
    await patch({ cosmeticFiltering: false }); await wait('!document.getElementById("blockads-cosmetic-shield")');
    await patch({ cosmeticFiltering: true }); await wait('document.getElementById("blockads-cosmetic-shield")');
    check(await evaluate('getComputedStyle(document.querySelector("main section:last-child")).display !== "none"'),
      'An inline discussion of the app is preserved rather than hiding the comments container');

    await setup('fixed');
    await patch({ cosmeticFiltering: true }); await hidden();
    await evaluate('(() => { const box=document.createElement("div"); box.id="oversized"; const fragment=document.createDocumentFragment(); for(let i=0;i<20001;i++) fragment.append(document.createElement("span")); box.append(fragment); document.body.append(box); return true; })()');
    await wait('getComputedStyle(document.getElementById("app-promo")).display !== "none"');
    check(await evaluate('document.getElementById("content").inert'), 'Exceeding the DOM scan budget stops repair and reverses its changes');
    await evaluate('(document.getElementById("oversized").remove(), true)');
    await patch({ cosmeticFiltering: false }); await wait('!document.getElementById("blockads-cosmetic-shield")');
    await patch({ cosmeticFiltering: true }); await hidden();
    check(true, 'Toggling Page hiding retries a stopped repair after the oversized DOM is gone');

    // Native extension on a different local route has no fixture hostname alias.
    const other = await browser.open(origin + '/not-reddit');
    try {
      await browser.evaluate(`(document.body.innerHTML=${JSON.stringify('<div id="other" style="position:fixed;inset:0">' + promo + '</div>')}, true)`, other);
      await until(browser, 'document.getElementById("blockads-cosmetic-shield")', other);
      check(await browser.evaluate('getComputedStyle(document.getElementById("other")).display !== "none"', other),
        'A matching-looking popup on a non-Reddit site is left untouched');
    } finally { await browser.closePage(other); }
  } finally {
    await patch({ enabled: start.enabled, cosmeticFiltering: start.cosmeticFiltering, whitelistedDomains: start.whitelistedDomains,
      cosmeticPausedDomains: start.cosmeticPausedDomains, genericCosmeticFiltering: start.genericCosmeticFiltering, proceduralFiltering: start.proceduralFiltering });
    await browser.closePage(page);
  }
}
module.exports = { aliasFixture, verify };
