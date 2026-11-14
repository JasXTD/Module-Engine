/* One owned DOM helper, shared by clipboard writes and native XHR uploads. */
(() => {
  'use strict';
  const instances = new WeakMap();
  function create(api) {
    if (instances.has(api)) return instances.get(api);
    let leases = 0, tail = Promise.resolve();
    const serial = work => { const result = tail.then(work); tail = result.catch(() => {}); return result; };
    async function acquire() {
      let released = false;
      await serial(async () => {
        if (!await api.permissions.contains({ permissions: ['offscreen'] })) throw new Error('Allow helper access in the script editor to use upload progress.');
        const url = api.runtime.getURL('src/userscripts/clipboard.html');
        if (!(await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] })).length)
          await api.offscreen.createDocument({ url: 'src/userscripts/clipboard.html', reasons: ['CLIPBOARD', 'BLOBS'], justification: 'Userscript clipboard writes and bounded Blob uploads with native progress.' });
        leases++;
      });
      return () => serial(async () => {
        if (released) return; released = true;
        if (--leases === 0) await api.offscreen.closeDocument();
      });
    }
    async function xhr(details, signal, emit) {
      const release = await acquire();
      try {
        signal.throwIfAborted();
        return await new Promise((resolve, reject) => {
          const port = api.runtime.connect({ name: 'ME_UPLOAD' }); let finished = false;
          const finish = (error, result) => {
            if (finished) return; finished = true;
            signal.removeEventListener('abort', abort); port.disconnect();
            error ? reject(error) : resolve(result);
          };
          const abort = () => finish(signal.reason || new Error('Request aborted.'));
          signal.addEventListener('abort', abort, { once: true });
          port.onDisconnect.addListener(() => finish(new Error('Upload helper disconnected; request was not retried.')));
          port.onMessage.addListener(message => {
            if (message.event) { try { emit(message); } catch (error) { finish(error); } }
            else finish(message.error ? new Error(message.error) : null, message.result);
          });
          try { port.postMessage(details); } catch (error) { finish(error); }
          if (signal.aborted) abort();
        });
      } finally { await release(); }
    }
    const result = Object.freeze({ acquire, xhr }); instances.set(api, result); return result;
  }
  globalThis.BlockAdsOffscreen = Object.freeze({ create });
})();
