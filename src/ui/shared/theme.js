/* Appearance on every extension page: a theme (system, light or dark) and an
   accent colour, from the setting in src/shared/appearance-settings.js. Storage
   reads are asynchronous, so a localStorage copy of the theme and accent lets
   each page apply them before its first paint; Firefox may clear that copy
   with site data, so it is only a cache. Load appearance-settings.js and then
   this file in <head>, after the page's stylesheets. */
(() => {
  'use strict';
  const appearance = globalThis.ModuleEngineAppearance;
  const { KEY, MODES, DEFAULT_ACCENT, DEFAULT, normalize, same } = appearance;
  const CACHE_KEY = 'moduleEngineAppearance';
  // Lime keeps the hand-tuned values in ui.css. Every other accent is derived.
  const PRESETS = Object.freeze([
    { name: 'Lime', value: DEFAULT_ACCENT }, { name: 'Green', value: '#4ade80' }, { name: 'Teal', value: '#2dd4bf' },
    { name: 'Sky', value: '#38bdf8' }, { name: 'Blue', value: '#6d8dfa' }, { name: 'Violet', value: '#b18cfa' },
    { name: 'Pink', value: '#f472b6' }
  ].map(Object.freeze));
  // Keep in step with ui.css; tests/theme.test.cjs compares them.
  const TOKENS = Object.freeze({
    dark: Object.freeze({ bg: '#0d0f12', surface: '#15181d', surface2: '#1c2026', switchOff: '#333943', danger: '#ff8a80', warn: '#f5b74e' }),
    light: Object.freeze({ bg: '#f2f3ee', surface: '#ffffff', surface2: '#f4f5f1', switchOff: '#c9cdc1', danger: '#bf2a20', warn: '#8f5a00' })
  });
  const TEXT_CONTRAST = 4.5; // WCAG AA for normal-size text.
  const EDGE_CONTRAST = 1.9; // What the light theme's lime button edge has against a card.
  const SOFT_ALPHA = { dark: 0.13, light: 0.14 };
  const VARIABLES = Object.freeze(['--theme-accent', '--theme-on-accent', '--theme-accent-text-dark', '--theme-accent-text-light',
    '--theme-accent-edge-dark', '--theme-accent-edge-light', '--theme-accent-soft-dark', '--theme-accent-soft-light']);

  // Colour arithmetic: sRGB channels are 0-1, OKLCH lightness is 0-1, hue in degrees.
  const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
  const hex = channels => '#' + channels.map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('');
  const linear = value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const encode = value => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  function luminance(colour) {
    const [r, g, b] = rgb(colour).map(linear);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function contrast(first, second) {
    const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  }
  function oklab(colour) {
    const [r, g, b] = rgb(colour).map(linear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function oklch(colour) {
    const [L, A, B] = oklab(colour);
    return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
  }
  function linearFromOklch(L, C, h) {
    const A = C * Math.cos(h * Math.PI / 180), B = C * Math.sin(h * Math.PI / 180);
    const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
    const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
    const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  // Keeps lightness and hue, and reduces chroma until the colour fits sRGB.
  function fromOklch(L, C, h) {
    const fits = chroma => linearFromOklch(L, chroma, h).every(value => value >= -1e-6 && value <= 1 + 1e-6);
    let low = 0, high = C;
    if (!fits(high)) { for (let step = 0; step < 24; step++) { const middle = (low + high) / 2; if (fits(middle)) low = middle; else high = middle; } high = low; }
    return hex(linearFromOklch(L, high, h).map(value => encode(Math.min(1, Math.max(0, value)))));
  }
  // The colour seen when `top` is drawn at `alpha` over `bottom`.
  const over = (top, alpha, bottom) => hex(rgb(top).map((value, index) => value * alpha + rgb(bottom)[index] * (1 - alpha)));
  const rgba = (colour, alpha) => 'rgba(' + rgb(colour).map(value => Math.round(value * 255)).join(', ') + ', ' + alpha + ')';
  const middle = (first, second) => hex(rgb(first).map((value, index) => (value + rgb(second)[index]) / 2));

  // Moves the accent away from the theme's surfaces in small lightness steps,
  // keeping its hue, until `passes` accepts it. The accent itself wins if it passes.
  function shift(accent, mode, passes) {
    const [L, C, h] = oklch(accent), direction = mode === 'dark' ? 1 : -1;
    if (passes(accent)) return accent;
    for (let step = 1; step <= 200; step++) {
      const lightness = Math.min(1, Math.max(0, L + direction * step * 0.005)), candidate = fromOklch(lightness, C, h);
      if (passes(candidate)) return candidate;
      if (lightness === 0 || lightness === 1) break;
    }
    return mode === 'dark' ? '#ffffff' : '#000000';
  }
  const softBase = (accent, text, mode) => mode === 'dark' ? text : middle(accent, text);
  function textColour(accent, mode) {
    const { bg, surface, surface2 } = TOKENS[mode];
    return shift(accent, mode, candidate => {
      const soft = softBase(accent, candidate, mode);
      return [bg, surface, surface2, over(soft, SOFT_ALPHA[mode], surface), over(soft, SOFT_ALPHA[mode], bg)]
        .every(background => contrast(candidate, background) >= TEXT_CONTRAST);
    });
  }
  function onAccent(accent) {
    const [, C, h] = oklch(accent), dark = fromOklch(0.21, Math.min(C, 0.03), h);
    const best = contrast(dark, accent) >= contrast('#ffffff', accent) ? dark : '#ffffff';
    if (contrast(best, accent) >= TEXT_CONTRAST) return best;
    // Black or white always reaches 4.58:1 against any colour.
    return contrast('#000000', accent) >= contrast('#ffffff', accent) ? '#000000' : '#ffffff';
  }

  // CSS values for a chosen accent. The fill keeps the chosen colour in both
  // themes; text and edges move just far enough to stay readable on each one.
  function palette(accent) {
    const colour = normalize({ accent }).accent, values = { '--theme-accent': colour, '--theme-on-accent': onAccent(colour) };
    for (const mode of ['dark', 'light']) {
      const text = textColour(colour, mode);
      values['--theme-accent-text-' + mode] = text;
      values['--theme-accent-edge-' + mode] = shift(colour, mode, candidate => contrast(candidate, TOKENS[mode].surface) >= EDGE_CONTRAST);
      values['--theme-accent-soft-' + mode] = rgba(softBase(colour, text, mode), SOFT_ALPHA[mode]);
    }
    return values;
  }

  // Reasons a chosen accent could make the interface harder to read: a hue
  // near the warning or error colours, or a switch track that looks switched off.
  function cautions(accent) {
    const colour = normalize({ accent }).accent, [, C, h] = oklch(colour), found = [];
    const hueGap = other => { const gap = Math.abs(h - oklch(other)[2]) % 360; return Math.min(gap, 360 - gap); };
    const statuses = Object.values(TOKENS).flatMap(tokens => [tokens.danger, tokens.warn]);
    if (C >= 0.06 && statuses.some(status => hueGap(status) < 22)) found.push('status');
    const lab = oklab(colour), distance = other => Math.hypot(...oklab(other).map((value, index) => value - lab[index]));
    if (Object.values(TOKENS).some(tokens => distance(tokens.switchOff) < 0.1)) found.push('switch');
    return found;
  }

  function apply(value, root = document.documentElement) {
    const { mode, accent } = normalize(value);
    if (mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    if (accent === DEFAULT_ACCENT) {
      root.removeAttribute('data-accent');
      for (const name of VARIABLES) root.style.removeProperty(name);
      if (root.getAttribute('style') === '') root.removeAttribute('style');
    } else {
      for (const [name, colour] of Object.entries(palette(accent))) root.style.setProperty(name, colour);
      root.setAttribute('data-accent', 'custom');
    }
  }

  const api = globalThis.browser || globalThis.chrome;
  const listeners = new Set();
  let stored = DEFAULT, changed = false;
  // The cache holds only what the first paint needs. A failed cache read or
  // write only costs that first paint; storage stays authoritative.
  function readCache() {
    try { const text = globalThis.localStorage?.getItem(CACHE_KEY); return text ? JSON.parse(text) : null; } catch { return null; }
  }
  function writeCache({ mode, accent }) {
    try {
      if (mode === DEFAULT.mode && accent === DEFAULT.accent) globalThis.localStorage?.removeItem(CACHE_KEY);
      else globalThis.localStorage?.setItem(CACHE_KEY, JSON.stringify({ mode, accent }));
    } catch { /* See above. */ }
  }
  function update(value) {
    const next = normalize(value), before = stored;
    stored = next; apply(next); writeCache(next);
    if (!same(before, next)) for (const listener of listeners) listener(next);
  }

  let ready = Promise.resolve({ ok: false, error: 'Extension storage is unavailable.' });
  if (globalThis.document?.documentElement) {
    stored = normalize(readCache());
    apply(stored);
    if (api?.storage?.local) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !(KEY in changes)) return;
        changed = true; update(changes[KEY].newValue);
      });
      // A change that arrives first is newer than this read.
      ready = api.storage.local.get(KEY).then(saved => { if (!changed) update(saved[KEY]); return { ok: true }; },
        error => ({ ok: false, error: error?.message || String(error) }));
    }
  }

  // The default is stored as no value at all, so Reset leaves nothing behind.
  async function save(value) {
    if (!api?.storage?.local) throw new Error('Extension storage is unavailable.');
    const next = normalize(value);
    if (same(next, DEFAULT)) await api.storage.local.remove(KEY); else await api.storage.local.set({ [KEY]: next });
    changed = true; update(next);
    return next;
  }

  globalThis.ModuleEngineTheme = Object.freeze({
    KEY, CACHE_KEY, MODES, DEFAULT, DEFAULT_ACCENT, PRESETS, TOKENS, TEXT_CONTRAST, EDGE_CONTRAST, VARIABLES,
    normalize, palette, cautions, contrast, oklch, apply, save, ready,
    // Shows a choice on this page only, without saving it.
    preview: value => apply(value),
    current: () => stored,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  });
})();
