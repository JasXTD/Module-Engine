/* The Appearance setting stored in storage.local, shared by extension pages,
   the popup and the website theme content script. The default is stored as no
   value at all. Each reader validates what it loads: storage may hold an older
   or damaged value. */
(() => {
  'use strict';
  const KEY = 'appearance';
  const MODES = Object.freeze(['system', 'light', 'dark']);
  const DEFAULT_ACCENT = '#c8f23a';
  const MAX_EXCEPTIONS = 500;
  const DEFAULT = Object.freeze({ mode: 'system', accent: DEFAULT_ACCENT, websites: false, websiteExceptions: Object.freeze([]) });
  // Hostnames as BlockAds.normalizeDomain saves them: lowercase DNS labels or IPv4.
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  const validHost = host => typeof host === 'string' && host.length <= 253 && host.split('.').every(label => LABEL.test(label)) &&
    (host.includes('.') || host === 'localhost');

  function normalize(value) {
    const mode = MODES.includes(value?.mode) ? value.mode : DEFAULT.mode;
    const accent = typeof value?.accent === 'string' && /^#[0-9a-f]{6}$/i.test(value.accent) ? value.accent.toLowerCase() : DEFAULT.accent;
    const exceptions = Array.isArray(value?.websiteExceptions) ? value.websiteExceptions.filter(validHost) : [];
    return { mode, accent, websites: value?.websites === true, websiteExceptions: [...new Set(exceptions)].sort().slice(0, MAX_EXCEPTIONS) };
  }
  const same = (left, right) => left.mode === right.mode && left.accent === right.accent && left.websites === right.websites &&
    left.websiteExceptions.length === right.websiteExceptions.length && left.websiteExceptions.every((host, index) => host === right.websiteExceptions[index]);
  // An exception covers its subdomains, as other Module Engine site lists do.
  const excluded = (hostname, exceptions) => {
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return exceptions.some(domain => host === domain || host.endsWith('.' + domain));
  };
  // Whether websites should be dark now; systemDark is the page's prefers-color-scheme.
  const websitesDark = (value, systemDark) => value.websites && (value.mode === 'dark' || value.mode === 'system' && systemDark === true);

  globalThis.ModuleEngineAppearance = Object.freeze({ KEY, MODES, DEFAULT_ACCENT, DEFAULT, MAX_EXCEPTIONS, normalize, same, excluded, websitesDark });
})();
