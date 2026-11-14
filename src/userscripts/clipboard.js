/* Privileged copy-only DOM helper. Never reads or inserts clipboard HTML. */
(() => {
  'use strict';
  function write({ data, type }) {
    if (typeof data !== 'string' || new TextEncoder().encode(data).length > 1048576 ||
        !['text/plain', 'text/html'].includes(type)) throw new Error('Unsupported clipboard data.');
    let copied = false;
    // Native copy requires a selectable value even when the copy event supplies
    // the final MIME data. Keep it in this private document, never in the page.
    const field = document.createElement('textarea');
    field.readOnly = true; field.value = data || ' ';
    field.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0';
    const copy = event => { event.clipboardData.setData(type, data); event.preventDefault(); copied = true; };
    document.addEventListener('copy', copy);
    try {
      document.body.append(field); field.select();
      if (!document.execCommand('copy') || !copied) throw new Error('The browser refused the clipboard write.');
    } finally { document.removeEventListener('copy', copy); field.remove(); }
  }
  globalThis.BlockAdsClipboard = Object.freeze({ write });
  const api = globalThis.browser || globalThis.chrome;
  if (api?.runtime && globalThis.location?.href === api.runtime.getURL('src/userscripts/clipboard.html')) {
    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.type !== 'ME_CLIPBOARD_WRITE') return false;
      if (sender.id !== api.runtime.id || sender.tab || sender.documentId ||
          sender.url && sender.url !== api.runtime.getURL('src/background/background.js')) return false;
      try { write(message.details); respond({ ok: true }); }
      catch (error) { respond({ ok: false, error: error.message }); }
      return false;
    });
  }
})();
