/* Native upload events in an extension DOM context. No page or external messages. */
(() => {
  'use strict';
  function request(details, signal, emit) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); let ended = false, loading = false;
      const headers = () => xhr.getAllResponseHeaders().split(/\r?\n/).filter(line => !/^set-cookie2?:/i.test(line)).join('\r\n');
      const state = readyState => ({ readyState, status: xhr.status, statusText: xhr.statusText,
        finalUrl: details.url.split('#')[0], responseHeaders: headers() });
      const finish = (error, result) => {
        if (ended) return; ended = true; signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result);
      };
      const abort = () => { finish(signal.reason || new Error('Request aborted.')); xhr.abort(); };
      const tooLarge = () => { finish(new Error('Response exceeds the download size limit.')); xhr.abort(); };
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        // The broker verifies a private redirect guard before starting XHR:
        // Chromium removes Location; Firefox cancels through its blocking observer.
        xhr.open(details.method, details.url); xhr.responseType = 'arraybuffer'; xhr.withCredentials = !details.anonymous;
        for (const [name, value] of Object.entries(details.headers)) xhr.setRequestHeader(name, value);
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 2) {
            if (Number(xhr.getResponseHeader('content-length')) > details.limit) { tooLarge(); return; }
            if (![301,302,303,307,308].includes(xhr.status)) emit({ event: 'readystatechange', ...state(2) });
          }
        };
        xhr.onprogress = event => {
          if (event.loaded > details.limit) { tooLarge(); return; }
          if ([301,302,303,307,308].includes(xhr.status)) return;
          if (!loading) { loading = true; emit({ event: 'readystatechange', ...state(3) }); }
          emit({ event: 'progress', ...state(3), loaded: event.loaded, total: event.total, lengthComputable: event.lengthComputable });
        };
        for (const name of ['loadstart', 'progress', 'load', 'error', 'abort', 'timeout', 'loadend']) xhr.upload.addEventListener(name, event => {
          if (!ended) emit({ event: name, upload: true, loaded: event.loaded, total: event.total, lengthComputable: event.lengthComputable });
        });
        xhr.onload = () => {
          const bytes = new Uint8Array(xhr.response || new ArrayBuffer(0));
          if (bytes.length > details.limit) { tooLarge(); return; }
          finish(null, { status: xhr.status, statusText: xhr.statusText, finalUrl: xhr.responseURL,
            headers: headers(), body: BlockAdsUserScriptNetwork.encode(bytes) });
        };
        xhr.onerror = () => finish(new Error('Upload request failed.'));
        xhr.onabort = () => finish(new Error('Request aborted.'));
        const body = BlockAdsUserScriptNetwork.makeBody(details);
        // A Blob retains the supplied bytes without interpreting them as text.
        xhr.send(body instanceof Uint8Array ? new Blob([body]) : body);
      } catch (error) { finish(error); xhr.abort(); }
    });
  }
  globalThis.BlockAdsXHR = Object.freeze({ request });
  const api = globalThis.browser || globalThis.chrome;
  if (api?.runtime && globalThis.location?.href === api.runtime.getURL('clipboard.html')) api.runtime.onConnect.addListener(port => {
    if (port.name !== 'ME_UPLOAD') return;
    const sender = port.sender;
    if (sender?.id !== api.runtime.id || sender.tab || sender.documentId || sender.url && sender.url !== api.runtime.getURL('background.js')) { port.disconnect(); return; }
    const controller = new AbortController(); let started = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener(details => {
      if (started) { controller.abort(); port.disconnect(); return; } started = true;
      const emit = value => { if (!controller.signal.aborted) { try { port.postMessage(value); } catch { controller.abort(); } } };
      void request(details, controller.signal, emit).then(result => emit({ result }), error => emit({ error: error.message }));
    });
  });
})();
