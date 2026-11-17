/* Appearance page: the theme and accent colour, and whether websites follow a
   dark theme. theme.js validates, saves and applies each choice; every open
   Module Engine page and website follows the saved value. */
(() => {
  'use strict';
  const theme = globalThis.ModuleEngineTheme;
  const { normalizeDomain, domainMatches } = globalThis.BlockAds;
  const { MAX_EXCEPTIONS } = globalThis.ModuleEngineAppearance;
  const byId = id => document.getElementById(id);
  const status = byId('status'), themeHelp = byId('themeHelp'), swatches = byId('swatches'), custom = byId('customAccent');
  const accentValue = byId('accentValue'), caution = byId('accentCaution'), reset = byId('resetAppearance');
  const websitesEnabled = byId('websitesEnabled'), websitesState = byId('websitesState'), exceptionForm = byId('exceptionForm');
  const exceptionInput = byId('exceptionInput'), addException = byId('addException'), exceptionError = byId('exceptionError'), exceptionList = byId('exceptionList');
  const modes = [...document.querySelectorAll('input[name="mode"]')];
  const systemLight = matchMedia('(prefers-color-scheme: light)');
  const CAUTIONS = {
    status: 'This colour is close to the warning and error colours, so those messages may be harder to tell apart.',
    switch: 'This colour is close to a switched-off switch, so switches may be harder to read.'
  };
  const SAVED_MODE = {
    system: 'Saved. Every open Module Engine page now follows your device setting.',
    light: 'Saved. Every open Module Engine page now uses the light theme.',
    dark: 'Saved. Every open Module Engine page now uses the dark theme.'
  };
  const SAVED_ACCENT = 'Saved. Every open Module Engine page now uses this accent colour.';
  // `shown` can be ahead of storage: a colour the picker is still previewing.
  let available = false, shown = theme.current(), saving = Promise.resolve(true);

  for (const preset of theme.PRESETS) {
    const label = document.createElement('label'), input = document.createElement('input');
    const dot = document.createElement('span'), name = document.createElement('span');
    label.className = 'swatch';
    Object.assign(input, { type: 'radio', name: 'accent', value: preset.value, disabled: true });
    dot.className = 'swatch-dot'; dot.setAttribute('aria-hidden', 'true'); dot.style.setProperty('--swatch', preset.value);
    name.textContent = preset.value === theme.DEFAULT.accent ? preset.name + ' (default)' : preset.name;
    label.append(input, dot, name); swatches.append(label);
  }
  const accents = [...swatches.querySelectorAll('input')];

  function notice(text, kind) { status.className = 'notice ' + kind; status.textContent = text; }
  function describeSystem() { themeHelp.textContent = "System follows your device's light or dark setting, currently " + (systemLight.matches ? 'light' : 'dark') + '.'; }
  function describeWebsites(choice) {
    if (!choice.websites) return 'Off. Websites keep their own colours.';
    if (choice.mode === 'dark') return 'On. Light websites are dark now.';
    if (choice.mode === 'light') return 'On, but the theme is light, so websites keep their own colours.';
    return systemLight.matches ? 'On. Your device is light now, so websites keep their own colours until it turns dark.'
      : 'On. Your device is dark now, so light websites are dark.';
  }
  function renderExceptions(hosts) {
    exceptionList.replaceChildren(...hosts.map(host => {
      const item = document.createElement('li'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = host;
      Object.assign(remove, { type: 'button', textContent: 'Remove', disabled: !available });
      remove.setAttribute('aria-label', 'Remove ' + host);
      remove.addEventListener('click', () => choose({ ...shown, websiteExceptions: shown.websiteExceptions.filter(entry => entry !== host) },
        `Saved. ${host} follows the website theme again.`));
      item.append(name, remove);
      return item;
    }));
  }
  function render(choice) {
    shown = choice;
    for (const input of modes) input.checked = input.value === choice.mode;
    for (const input of accents) input.checked = input.value === choice.accent;
    if (custom.value !== choice.accent) custom.value = choice.accent;
    accentValue.textContent = choice.accent + ' · ' + (theme.PRESETS.find(preset => preset.value === choice.accent)?.name || 'Custom');
    const found = theme.cautions(choice.accent);
    caution.textContent = found.map(reason => CAUTIONS[reason]).join(' ');
    caution.hidden = found.length === 0;
    reset.disabled = !available || (choice.mode === theme.DEFAULT.mode && choice.accent === theme.DEFAULT.accent);
    websitesEnabled.checked = choice.websites;
    websitesState.textContent = describeWebsites(choice);
    renderExceptions(choice.websiteExceptions);
  }
  // Shows the choice at once, then saves choices in order. A failed save
  // returns the page to the saved appearance. Resolves whether it was saved.
  function choose(value, done) {
    const next = theme.normalize(value);
    theme.preview(next); render(next);
    saving = saving.then(async () => {
      try { await theme.save(next); notice(done, 'success'); return true; }
      catch (error) {
        const saved = theme.current(); theme.preview(saved); render(saved);
        notice('Could not save your appearance: ' + (error?.message || error), 'error');
        return false;
      }
    });
    return saving;
  }

  for (const input of modes) input.addEventListener('change', () => { if (input.checked) choose({ ...shown, mode: input.value }, SAVED_MODE[input.value]); });
  for (const input of accents) input.addEventListener('change', () => { if (input.checked) choose({ ...shown, accent: input.value }, SAVED_ACCENT); });
  // The picker reports each colour while it is open (input) and fires change
  // when it closes on a new one, so only that final colour is saved.
  custom.addEventListener('input', () => { const next = theme.normalize({ ...shown, accent: custom.value }); theme.preview(next); render(next); });
  custom.addEventListener('change', () => choose({ ...shown, accent: custom.value }, SAVED_ACCENT));
  // Reset leaves the website setting and its sites alone.
  reset.addEventListener('click', () => choose({ ...shown, mode: theme.DEFAULT.mode, accent: theme.DEFAULT.accent }, 'Restored the default theme and accent colour.'));
  websitesEnabled.addEventListener('change', () => choose({ ...shown, websites: websitesEnabled.checked },
    websitesEnabled.checked ? 'Saved. Light websites now follow the dark theme.' : 'Saved. Websites keep their own colours.'));
  exceptionForm.addEventListener('submit', async event => {
    event.preventDefault();
    exceptionError.hidden = true;
    let host;
    try { host = normalizeDomain(exceptionInput.value); }
    catch (error) { exceptionError.textContent = error.message; exceptionError.hidden = false; return; }
    const covering = shown.websiteExceptions.find(domain => domainMatches(host, domain));
    if (covering) { exceptionError.textContent = covering === host ? `${host} is already in the list.` : `${host} is already covered by ${covering}.`; exceptionError.hidden = false; return; }
    // A parent site replaces the subdomains it now covers.
    const kept = shown.websiteExceptions.filter(domain => !domainMatches(domain, host));
    if (kept.length >= MAX_EXCEPTIONS) { exceptionError.textContent = `The list holds up to ${MAX_EXCEPTIONS} sites. Remove one first.`; exceptionError.hidden = false; return; }
    if (await choose({ ...shown, websiteExceptions: [...kept, host] }, `Saved. ${host} keeps its own colours.`)) exceptionInput.value = '';
  });
  systemLight.addEventListener('change', () => { describeSystem(); websitesState.textContent = describeWebsites(shown); });
  // Another page, tab or the popup changed the saved appearance.
  theme.subscribe(render);

  describeSystem(); render(shown);
  void theme.ready.then(result => {
    available = result.ok;
    for (const input of [...modes, ...accents, custom, websitesEnabled, exceptionInput, addException]) input.disabled = !available;
    render(theme.current());
    if (available) notice('Choices save automatically and apply to every open Module Engine page.', 'success');
    else notice('Could not read your saved appearance: ' + result.error, 'error');
  });
})();
