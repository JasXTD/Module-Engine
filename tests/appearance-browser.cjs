/* Appearance in a real engine: a chosen theme beats the system preference,
   accents and their derived tokens reach every open page, the choice survives
   a reload and same-tab sections, and Reset clears storage. Offline; called
   from tests/pages-browser.cjs with its pages and helpers. */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const BACKGROUND = { dark: 'rgb(13, 15, 18)', light: 'rgb(242, 243, 238)' };
const KEYWORD = { dark: 'rgb(198, 160, 237)', light: 'rgb(112, 64, 160)' };
const rgb = hex => 'rgb(' + [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(', ') + ')';
// A probe element turns var() into the used colour on that page.
const token = name => `(() => {const probe=document.createElement('i');probe.style.color='var(${name})';document.body.append(probe);
  const value=getComputedStyle(probe).color;probe.remove();return value;})()`;
const storage = '(globalThis.browser||chrome).storage.local.get("appearance").then(saved=>saved.appearance)';
const label = (name, value) => `label:has(> input[name="${name}"][value="${value}"])`;

module.exports = async function verifyAppearance({ browser, until, check, temporary, url, pages, press, setColourScheme }) {
  const wait = (expression, target) => until(browser, expression, target);
  const file = 'src/ui/appearance/appearance.html';
  const appearance = await browser.open(url(file));
  const all = { ...pages, [file]: appearance }, targets = Object.values(all);
  const shot = async (name, target = appearance) => {
    const output = path.join(temporary, 'appearance-' + name + '.png');
    if (!browser.send) return browser.screenshot(output, target);
    await browser.send('Target.activateTarget', { targetId: target.id });
    const { data } = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, target);
    await fs.writeFile(output, Buffer.from(data, 'base64'));
  };
  const everyPage = async (expression, description) => {
    for (const [name, target] of Object.entries(all)) await wait(expression, target).catch(error => { throw new Error(name + ': ' + description + '\n' + error.message); });
    check(true, description);
  };
  // Chromium returns stored objects with sorted keys, so compare fields.
  const saved = async expected => wait(`${storage}.then(value=>${expected === undefined ? 'value===undefined' :
    `value?.websites===false && JSON.stringify(value.websiteExceptions)==='[]' && value.mode===${JSON.stringify(expected.mode)} && value.accent===${JSON.stringify(expected.accent)}`})`, appearance);
  const ready = "!document.querySelector('input[name=\"mode\"]').disabled";
  try {
    await wait(ready, appearance);
    check(await browser.evaluate(`[...document.styleSheets].every(sheet=>sheet.cssRules.length>0) && document.styleSheets.length===document.querySelectorAll('link[rel="stylesheet"]').length`, appearance),
      `${file} loads its stylesheets`);
    check(await browser.evaluate(`(() => {const root=document.documentElement;
      return !root.hasAttribute('data-theme') && !root.hasAttribute('data-accent') && document.querySelector('input[value="system"]').checked &&
        document.querySelector('input[name="accent"][value="#c8f23a"]').checked && document.getElementById('resetAppearance').disabled &&
        document.querySelectorAll('.swatch').length===ModuleEngineTheme.PRESETS.length && document.getElementById('status').classList.contains('success');})()`, appearance),
      'Appearance opens on the system theme and the default accent');
    check(await browser.evaluate(`${storage}.then(value=>value===undefined)`, appearance), 'the default appearance stores nothing');

    // A chosen theme beats the system preference on every open page.
    for (const [system, chosen] of [['dark', 'light'], ['light', 'dark']]) {
      await setColourScheme(system, targets);
      await press(appearance, label('mode', chosen));
      await saved({ mode: chosen, accent: '#c8f23a' });
      await everyPage(`document.documentElement.dataset.theme===${JSON.stringify(chosen)} && getComputedStyle(document.body).backgroundColor===${JSON.stringify(BACKGROUND[chosen])} &&
        getComputedStyle(document.documentElement).colorScheme===${JSON.stringify(chosen)}`, `every open page switches to the chosen ${chosen} theme while the system is ${system}`);
      check(await browser.evaluate(`(() => {const span=document.createElement('span');span.className='syntax-keyword';document.body.append(span);
        const colour=getComputedStyle(span).color;span.remove();return colour===${JSON.stringify(KEYWORD[chosen])};})()`, pages['src/ui/manager/manager.html']),
        `editor syntax colours follow the chosen ${chosen} theme`);
      await shot(chosen + '-over-' + system);
    }
    await press(appearance, label('mode', 'system'));
    await saved(undefined);
    for (const system of ['dark', 'light']) {
      await setColourScheme(system, targets);
      await everyPage(`!document.documentElement.hasAttribute('data-theme') && getComputedStyle(document.body).backgroundColor===${JSON.stringify(BACKGROUND[system])}`,
        `System follows a ${system} device setting again on every open page`);
    }

    // A preset accent and the readable shades theme.js derives for it.
    const sky = '#38bdf8';
    await press(appearance, label('accent', sky));
    await saved({ mode: 'system', accent: sky });
    for (const system of ['light', 'dark']) {
      await setColourScheme(system, targets);
      await everyPage(`document.documentElement.dataset.accent==='custom' && ${token('--accent')}===${JSON.stringify(rgb(sky))} &&
        ${token('--accent-text')}===${token(`--theme-accent-text-${system}`)} && ${token('--accent-edge')}===${token(`--theme-accent-edge-${system}`)}`,
        `every open page uses the Sky accent with its ${system} text and edge shades`);
    }
    const derived = await browser.evaluate(`JSON.stringify(ModuleEngineTheme.palette(${JSON.stringify(sky)}))`, appearance).then(JSON.parse);
    // Finishing the switch's colour transition makes its end state readable at once.
    check(await browser.evaluate(`(() => {document.getAnimations().forEach(animation=>animation.finish());const toggle=document.getElementById('masterToggle');
      return toggle.checked && getComputedStyle(toggle).backgroundColor===${JSON.stringify(rgb(sky))} &&
        getComputedStyle(toggle,'::before').backgroundColor===${JSON.stringify(rgb(derived['--theme-on-accent']))};})()`, pages['src/ui/popup/popup.html']),
      'the popup master switch fills with the accent and keeps a readable knob');
    await press(appearance, label('mode', 'light'));
    await saved({ mode: 'light', accent: sky });
    await setColourScheme('dark', targets);
    await everyPage(`${token('--accent-text')}===${JSON.stringify(rgb(derived['--theme-accent-text-light']))}`, 'a chosen light theme uses the light accent text while the system is dark');
    await shot('sky-light');

    // A picker colour. The native picker cannot be driven, so set its value and send its events.
    const red = '#ef4444';
    await browser.evaluate(`(() => {const input=document.getElementById('customAccent');input.value=${JSON.stringify(red)};
      input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`, appearance);
    await saved({ mode: 'light', accent: red });
    check(await browser.evaluate(`(() => {const caution=document.getElementById('accentCaution');
      return !caution.hidden && caution.textContent.includes('warning and error colours') && !document.querySelector('input[name="accent"]:checked') &&
        document.getElementById('accentValue').textContent===${JSON.stringify(red + ' · Custom')};})()`, appearance),
      'a custom red accent is saved, selects no preset and warns that it resembles the status colours');
    await everyPage(`${token('--accent')}===${JSON.stringify(rgb(red))}`, 'every open page uses the custom accent');
    await shot('custom-red');

    // The saved choice survives a reload, and each page keeps a matching first-paint copy.
    const log = pages['src/ui/log/log.html'];
    await browser.navigate(log, url('src/ui/log/log.html'));
    await wait(`document.readyState==='complete' && document.documentElement.dataset.theme==='light' && ${token('--accent')}===${JSON.stringify(rgb(red))}`, log);
    check(await browser.evaluate(`localStorage.getItem('moduleEngineAppearance')===${JSON.stringify(JSON.stringify({ mode: 'light', accent: red }))}`, log),
      'a reloaded page applies the saved appearance and shares its first-paint copy');

    // Same-tab sections: a choice made in the Appearance section reaches the hosting page.
    const manager = pages['src/ui/manager/manager.html'];
    await press(manager, '.rail-pages a[href$="appearance/appearance.html"]');
    const frame = "document.querySelector('iframe.me-section-frame[data-me-section=\"appearance\"]:not([hidden])')";
    await wait(`Boolean(${frame}?.contentDocument && (d => d.readyState==='complete' && ${ready.replaceAll('document', 'd')})(${frame}.contentDocument))`, manager);
    const point = await browser.evaluate(`(() => {const node=${frame}.contentDocument.querySelector(${JSON.stringify(label('mode', 'dark'))});
      node.scrollIntoView({block:'center',behavior:'instant'});const r=node.getBoundingClientRect(),f=${frame}.getBoundingClientRect();
      return {x:f.x+r.x+r.width/2,y:f.y+r.y+r.height/2};})()`, manager);
    await setColourScheme('light', targets);
    await browser.clickAt(point.x, point.y, manager);
    await saved({ mode: 'dark', accent: red });
    await wait(`document.documentElement.dataset.theme==='dark' && ${frame}.contentDocument.documentElement.dataset.theme==='dark' &&
      getComputedStyle(${frame}).backgroundColor===${JSON.stringify(BACKGROUND.dark)}`, manager);
    check(true, 'a choice in the same-tab Appearance section updates its host page and frame');
    await browser.evaluate(`${frame}.contentDocument.querySelector('.rail-pages a[href$="manager/manager.html"]').click()`, manager);
    await wait(`!document.querySelector('iframe.me-section-frame:not([hidden])') && getComputedStyle(document.body).backgroundColor===${JSON.stringify(BACKGROUND.dark)}`, manager);
    check(true, 'returning to Modules & scripts shows the same appearance');

    // Narrow layout.
    if (browser.send) {
      await browser.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 900, deviceScaleFactor: 1, mobile: false }, appearance);
      check(await browser.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth', appearance), 'Appearance fits a 380px viewport');
      await shot('dark-380');
      await browser.send('Emulation.clearDeviceMetricsOverride', {}, appearance);
    }

    await press(appearance, '#resetAppearance');
    await saved(undefined);
    await everyPage(`!document.documentElement.hasAttribute('data-theme') && !document.documentElement.hasAttribute('data-accent') &&
      !document.documentElement.hasAttribute('style') && localStorage.getItem('moduleEngineAppearance')===null && getComputedStyle(document.body).backgroundColor===${JSON.stringify(BACKGROUND.light)}`,
      'Reset returns every open page to the system theme and default accent');
    check(await browser.evaluate(`document.getElementById('status').textContent==='Restored the default theme and accent colour.' && document.getElementById('resetAppearance').disabled`, appearance),
      'Reset confirms the change and has nothing left to reset');
  } finally {
    await browser.evaluate('(globalThis.browser||chrome).storage.local.remove("appearance").then(()=>true)', appearance).catch(() => {});
    await setColourScheme(null, targets).catch(() => {});
    await browser.closePage(appearance).catch(() => {});
  }
};
