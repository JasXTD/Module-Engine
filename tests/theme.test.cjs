/* Appearance: accent derivation, CSS and page wiring, and theme.js start-up
   against an offline document and extension storage. Browser suites cover the
   rendered cascade (tests/pages-browser.cjs). */
'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { files } = require('../scripts/extension-files.cjs');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const settingsSource = read('src/shared/appearance-settings.js'), source = read('src/ui/shared/theme.js'), css = read('src/ui/shared/ui.css');
require('../src/shared/appearance-settings.js'); require('../src/ui/shared/theme.js');
const Theme = globalThis.ModuleEngineTheme;
const plain = value => JSON.parse(JSON.stringify(value));

// rgba() values are drawn over a background; hex values are opaque.
function over(value, background) {
  if (value.startsWith('#')) return value;
  const [r, g, b, alpha] = value.match(/[\d.]+/g).map(Number), base = [1, 3, 5].map(index => parseInt(background.slice(index, index + 2), 16));
  return '#' + [r, g, b].map((channel, index) => Math.round(channel * alpha + base[index] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}
function samples() {
  let seed = 0x2f6b9d1;
  const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const colours = ['#000000', '#ffffff', '#808080', '#777777', '#767676', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff',
    '#1e3a8a', '#0d0f12', '#15181d', '#f2f3ee', '#c9cdc1', '#333943', ...Theme.PRESETS.map(preset => preset.value)];
  for (let index = 0; index < 400; index++) colours.push('#' + Math.floor(random() * 0x1000000).toString(16).padStart(6, '0'));
  return colours;
}

test('normalize keeps only a known theme and a six-digit colour', () => {
  const websites = { websites: false, websiteExceptions: [] };
  assert.deepEqual(Theme.normalize(undefined), { mode: 'system', accent: '#c8f23a', ...websites });
  assert.deepEqual(Theme.normalize({ mode: 'dark', accent: '#4ADE80', extra: true }), { mode: 'dark', accent: '#4ade80', ...websites });
  for (const bad of [null, 'dark', [], { mode: 'Dark' }, { mode: 'high-contrast' }, { accent: '#fff' }, { accent: 'red' }, { accent: '#12345g' }, { accent: '#1234567' }, { accent: 0x4ade80 }])
    assert.deepEqual(Theme.normalize(bad), { mode: Theme.MODES.includes(bad?.mode) ? bad.mode : 'system', accent: '#c8f23a', ...websites }, JSON.stringify(bad));
  assert.equal(Theme.normalize, globalThis.ModuleEngineAppearance.normalize, 'pages and websites share one definition');
  assert.deepEqual(plain(Theme.MODES), ['system', 'light', 'dark']);
  assert.equal(Theme.PRESETS[0].value, Theme.DEFAULT.accent);
  assert.equal(new Set(Theme.PRESETS.map(preset => preset.value)).size, Theme.PRESETS.length);
});

test('every derived accent keeps text, on-accent text and edges readable in both themes', () => {
  for (const accent of samples()) {
    const palette = Theme.palette(accent);
    assert.deepEqual(Object.keys(palette).sort(), plain(Theme.VARIABLES).sort(), accent);
    assert.equal(palette['--theme-accent'], accent);
    for (const value of Object.values(palette)) assert.match(value, /^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, 0\.1[34]\))$/, accent);
    assert.ok(Theme.contrast(palette['--theme-on-accent'], accent) >= Theme.TEXT_CONTRAST, accent + ' on-accent');
    for (const mode of ['dark', 'light']) {
      const { bg, surface, surface2 } = Theme.TOKENS[mode], text = palette['--theme-accent-text-' + mode], soft = palette['--theme-accent-soft-' + mode];
      for (const background of [bg, surface, surface2, over(soft, surface), over(soft, bg)])
        assert.ok(Theme.contrast(text, background) >= Theme.TEXT_CONTRAST, `${accent} ${mode} text ${text} on ${background}`);
      assert.ok(Theme.contrast(palette['--theme-accent-edge-' + mode], surface) >= Theme.EDGE_CONTRAST, `${accent} ${mode} edge`);
    }
  }
});

test('a readable accent is used unchanged, and adjusted text keeps its hue', () => {
  assert.equal(Theme.palette('#60a5fa')['--theme-accent-text-dark'], '#60a5fa');
  assert.equal(Theme.palette('#1e3a8a')['--theme-accent-text-light'], '#1e3a8a');
  assert.equal(Theme.palette('#1e3a8a')['--theme-on-accent'], '#ffffff');
  for (const { value } of Theme.PRESETS) for (const mode of ['dark', 'light']) {
    const text = Theme.palette(value)['--theme-accent-text-' + mode], gap = Math.abs(Theme.oklch(text)[2] - Theme.oklch(value)[2]) % 360;
    assert.ok(Math.min(gap, 360 - gap) < 12, `${value} ${mode} text ${text} changed hue`);
  }
});

test('cautions flag accents that resemble status colours or a switched-off switch', () => {
  for (const { value } of Theme.PRESETS) assert.deepEqual(plain(Theme.cautions(value)), [], value);
  for (const colour of ['#ef4444', '#f97316', '#facc15', '#fb7185', '#ff8a80', '#8f5a00']) assert.ok(Theme.cautions(colour).includes('status'), colour);
  for (const colour of ['#c9cdc1', '#333943', '#d0d3c8']) assert.ok(Theme.cautions(colour).includes('switch'), colour);
  for (const colour of ['#808080', '#000000', '#ffffff', '#2563eb']) assert.deepEqual(plain(Theme.cautions(colour)), [], colour);
});

function block(selector, from = 0) {
  const start = css.indexOf(selector + ' {', from);
  assert.ok(start >= 0, 'ui.css has ' + selector);
  const open = css.indexOf('{', start), close = css.indexOf('}', open);
  const declarations = Object.fromEntries(css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '').split(';').map(item => item.trim()).filter(Boolean)
    .map(item => [item.slice(0, item.indexOf(':')).trim(), item.slice(item.indexOf(':') + 1).trim()]));
  return { start, declarations };
}
test('ui.css defines one light theme for both the system and the Appearance choice', () => {
  const dark = block(':root'), chosen = block(':root[data-theme="light"]');
  const media = css.indexOf('@media (prefers-color-scheme: light)'), followed = block(':root:not([data-theme="dark"])', media);
  assert.ok(media > chosen.start && followed.start > media);
  assert.deepEqual(followed.declarations, chosen.declarations);
  assert.equal(chosen.declarations['color-scheme'], 'light');
  assert.equal(dark.declarations['color-scheme'], 'dark');
  // Every themed token in the dark defaults has a light value.
  const themed = Object.keys(dark.declarations).filter(name => !['--radius', '--radius-sm', '--sans', '--mono'].includes(name));
  assert.deepEqual(Object.keys(chosen.declarations).sort(), themed.sort());
  // theme.js measures contrast against the same surfaces the pages draw.
  const names = { bg: '--bg', surface: '--surface', surface2: '--surface-2', switchOff: '--switch-off', danger: '--danger', warn: '--warn' };
  for (const [mode, tokens] of Object.entries({ dark: dark.declarations, light: chosen.declarations }))
    for (const [key, name] of Object.entries(names)) assert.equal(Theme.TOKENS[mode][key], tokens[name], `${mode} ${name}`);
  // Chosen-accent rules follow, and so override, both light blocks.
  const accent = block(':root[data-accent]'), lightAccent = block(':root[data-accent][data-theme="light"]'), systemAccent = block(':root[data-accent]:not([data-theme="dark"])', media);
  assert.ok(accent.start > followed.start && systemAccent.start > accent.start);
  assert.deepEqual(systemAccent.declarations, lightAccent.declarations);
  for (const name of Theme.VARIABLES) assert.ok(css.includes('var(' + name + ')'), name + ' is used');
});

test('every page applies the theme from <head> and lists the same six sections', () => {
  const navigation = read('src/ui/shared/navigation.js'), sections = [...navigation.match(/const paths = \{[^}]+\}/)[0].matchAll(/'(src\/ui\/[^']+\.html)'/g)].map(match => match[1]);
  assert.equal(sections.length, 6);
  assert.ok(sections.includes('src/ui/appearance/appearance.html'));
  const pages = files.filter(file => file.endsWith('.html') && read(file).includes('shared/ui.css'));
  assert.ok(pages.length >= 7);
  for (const file of pages) {
    const html = read(file), head = html.slice(0, html.indexOf('</head>')), script = '<script src="../shared/theme.js"></script>';
    const settings = '<script src="../../shared/appearance-settings.js"></script>';
    assert.ok(head.includes(script), file + ' loads theme.js in <head>');
    assert.ok(head.indexOf(script) > head.lastIndexOf('rel="stylesheet"'), file + ' loads theme.js after its stylesheets');
    assert.ok(head.includes(settings) && head.indexOf(settings) < head.indexOf(script), file + ' loads the Appearance setting before theme.js');
    const rail = html.match(/<ul class="rail-links rail-pages">([\s\S]*?)<\/ul>/);
    if (!rail) continue;
    const links = [...rail[1].matchAll(/<a href="([^"]+)"( aria-current="page")?/g)];
    assert.deepEqual(links.map(link => path.posix.join(path.posix.dirname(file), link[1])), sections, file + ' side menu');
    assert.deepEqual(links.filter(link => link[2]).map(link => path.posix.join(path.posix.dirname(file), link[1])), [file], file + ' marks itself');
  }
});

// An offline page: <html> records its attributes and custom properties.
function page({ cache, stored, cacheThrows = false } = {}) {
  const attributes = new Map(), properties = new Map(), changeListeners = [], calls = [];
  const documentElement = {
    setAttribute: (name, value) => attributes.set(name, String(value)),
    removeAttribute: name => { attributes.delete(name); if (name === 'style') properties.clear(); },
    getAttribute: name => name === 'style' ? [...properties].map(([key, value]) => key + ': ' + value + ';').join(' ') : attributes.get(name) ?? null,
    style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) }
  };
  const cacheStore = new Map(cache === undefined ? [] : [['moduleEngineAppearance', typeof cache === 'string' ? cache : JSON.stringify(cache)]]);
  const localStorage = {
    getItem: key => { if (cacheThrows) throw new Error('SecurityError'); return cacheStore.get(key) ?? null; },
    setItem: (key, value) => { if (cacheThrows) throw new Error('SecurityError'); cacheStore.set(key, String(value)); },
    removeItem: key => { if (cacheThrows) throw new Error('SecurityError'); cacheStore.delete(key); }
  };
  let resolveGet, rejectGet, failWrite = null;
  const storage = { appearance: stored };
  const chrome = { storage: {
    onChanged: { addListener: listener => changeListeners.push(listener) },
    local: {
      get: key => { calls.push(['get', key]); return new Promise((resolve, reject) => { resolveGet = resolve; rejectGet = reject; }); },
      set: async value => { calls.push(['set', plain(value)]); if (failWrite) throw failWrite; Object.assign(storage, plain(value)); },
      remove: async key => { calls.push(['remove', key]); if (failWrite) throw failWrite; delete storage[key]; }
    }
  } };
  const context = vm.createContext({ document: { documentElement }, localStorage, chrome, console });
  vm.runInContext(settingsSource, context, { filename: 'appearance-settings.js' });
  vm.runInContext(source, context, { filename: 'theme.js' });
  return {
    theme: context.ModuleEngineTheme, attributes, properties, cacheStore, calls, storage,
    answer: value => resolveGet(value === undefined ? {} : { appearance: value }),
    refuse: error => rejectGet(error),
    change: (changes, area = 'local') => changeListeners.forEach(listener => listener(changes, area)),
    failWrites: error => { failWrite = error; },
    cached: () => cacheStore.has('moduleEngineAppearance') ? JSON.parse(cacheStore.get('moduleEngineAppearance')) : null
  };
}
test('the cached choice is applied while theme.js runs, before storage answers', async () => {
  const view = page({ cache: { mode: 'light', accent: '#4ade80' } });
  assert.equal(view.attributes.get('data-theme'), 'light');
  assert.equal(view.attributes.get('data-accent'), 'custom');
  assert.equal(view.properties.get('--theme-accent'), '#4ade80');
  assert.equal(view.properties.size, Theme.VARIABLES.length);
  assert.deepEqual(view.calls, [['get', 'appearance']]);
  view.answer({ mode: 'dark', accent: '#c8f23a' });
  assert.deepEqual(plain(await view.theme.ready), { ok: true });
  assert.equal(view.attributes.get('data-theme'), 'dark');
  assert.ok(!view.attributes.has('data-accent'));
  assert.equal(view.properties.size, 0);
  assert.deepEqual(view.cached(), { mode: 'dark', accent: '#c8f23a' }, 'the cache follows storage');
  view.change({ appearance: { oldValue: { mode: 'dark' }, newValue: undefined } });
  assert.ok(!view.attributes.has('data-theme'), 'removing the saved value returns to the system theme');
  assert.equal(view.cached(), null, 'the default leaves no cache behind');
});

test('only local appearance changes apply, and an older read never replaces a newer change', async () => {
  const view = page({ cache: { mode: 'dark' } }), seen = [];
  view.theme.subscribe(choice => seen.push(plain(choice)));
  view.change({ appearance: { newValue: { mode: 'light' } } }, 'sync');
  view.change({ enabled: { newValue: false } });
  assert.equal(view.attributes.get('data-theme'), 'dark');
  view.change({ appearance: { newValue: { mode: 'light', accent: '#f472b6' } } });
  assert.equal(view.attributes.get('data-theme'), 'light');
  view.answer({ mode: 'dark' });
  assert.equal((await view.theme.ready).ok, true);
  assert.equal(view.attributes.get('data-theme'), 'light', 'the read started before the change');
  assert.deepEqual(plain(view.theme.current()), { mode: 'light', accent: '#f472b6', websites: false, websiteExceptions: [] });
  view.change({ appearance: { newValue: { mode: 'light', accent: '#f472b6' } } });
  assert.deepEqual(seen, [{ mode: 'light', accent: '#f472b6', websites: false, websiteExceptions: [] }], 'listeners hear each different choice once');
});

test('unreadable caches and failed reads keep the page usable and report the failure', async () => {
  const broken = page({ cache: '{not json' });
  assert.ok(!broken.attributes.has('data-theme'));
  broken.answer({ mode: 'light' }); await broken.theme.ready;
  assert.equal(broken.attributes.get('data-theme'), 'light');
  const blocked = page({ cacheThrows: true });
  blocked.answer({ mode: 'dark', accent: '#38bdf8' });
  assert.deepEqual(plain(await blocked.theme.ready), { ok: true });
  assert.equal(blocked.properties.get('--theme-accent'), '#38bdf8', 'storage still applies when localStorage is blocked');
  const refused = page({ cache: { mode: 'light' } });
  refused.refuse(new Error('Extension context invalidated.'));
  assert.deepEqual(plain(await refused.theme.ready), { ok: false, error: 'Extension context invalidated.' });
  assert.equal(refused.attributes.get('data-theme'), 'light', 'the cached theme stays');
});

test('save stores a normalized choice, removes the default and leaves state alone on failure', async () => {
  const view = page();
  view.answer(undefined); await view.theme.ready;
  const saved = await view.theme.save({ mode: 'dark', accent: '#B18CFA', note: 'dropped' });
  assert.deepEqual(plain(saved), { mode: 'dark', accent: '#b18cfa', websites: false, websiteExceptions: [] });
  assert.deepEqual(view.calls.at(-1), ['set', { appearance: { mode: 'dark', accent: '#b18cfa', websites: false, websiteExceptions: [] } }]);
  assert.equal(view.attributes.get('data-theme'), 'dark');
  assert.deepEqual(view.cached(), { mode: 'dark', accent: '#b18cfa' });
  await view.theme.save(Theme.DEFAULT);
  assert.deepEqual(view.calls.at(-1), ['remove', 'appearance']);
  assert.ok(!('appearance' in view.storage) && !view.attributes.has('data-theme') && view.properties.size === 0);
  view.failWrites(new Error('QUOTA_BYTES quota exceeded'));
  await assert.rejects(view.theme.save({ mode: 'light' }), /QUOTA_BYTES/);
  assert.deepEqual(plain(view.theme.current()), plain(Theme.DEFAULT));
  assert.ok(!view.attributes.has('data-theme'), 'a failed save applies nothing');
  view.theme.preview({ mode: 'light', accent: '#2dd4bf' });
  assert.equal(view.attributes.get('data-theme'), 'light');
  assert.deepEqual(plain(view.theme.current()), plain(Theme.DEFAULT), 'a preview is not saved');
  assert.equal(view.cached(), null);
});
