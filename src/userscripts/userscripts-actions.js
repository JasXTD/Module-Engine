/* Optional browser capabilities, separate from ad blocking. */
(() => {
  'use strict';
  const errorText = error => error?.message || String(error);
  function normalize(kind, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Use helper options.');
    const string = (value, limit, label) => {
      if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) throw new TypeError(label + ' must be a string within its size limit.');
      return value;
    };
    if (kind === 'clipboard') {
      if (Object.keys(input).some(key => !['data', 'type'].includes(key))) throw new Error('Unsupported clipboard option.');
      const type = input.type ?? 'text/plain';
      if (!['text', 'html', 'text/plain', 'text/html'].includes(type)) throw new Error('Clipboard supports text/plain or text/html.');
      return { data: string(input.data, 1048576, 'Clipboard data'), type: type === 'text' ? 'text/plain' : type === 'html' ? 'text/html' : type };
    }
    if (kind === 'notification') {
      if (Object.keys(input).some(key => !['text', 'title', 'image', 'silent', 'tag'].includes(key))) throw new Error('Unsupported notification option.');
      const text = string(input.text, 4096, 'Notification text'), title = string(input.title ?? '', 256, 'Notification title');
      if (!text.trim()) throw new Error('Notification text is required.');
      const tag = string(input.tag ?? '', 128, 'Notification tag'), image = input.image ?? '';
      if (typeof image !== 'string' || image && (image.length > 32768 || !/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(image))) throw new Error('Notification images must be small inline raster data URLs.');
      if (input.silent !== undefined && typeof input.silent !== 'boolean') throw new TypeError('silent must be a boolean.');
      return { text, title, image, tag, silent: input.silent === true };
    }
    if (kind === 'download') {
      const name = string(input.name, 240, 'Download filename');
      if (!name || name !== name.trim() || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Use a single valid filename, without directories or reserved device names.');
      if (input.saveAs !== undefined && typeof input.saveAs !== 'boolean') throw new TypeError('saveAs must be a boolean.');
      // The filename has no directories, so overwrite can only replace a file
      // with this exact name in the browser's download folder.
      const conflictAction = input.conflictAction ?? 'uniquify';
      if (!['uniquify', 'overwrite', 'prompt'].includes(conflictAction)) throw new Error('conflictAction must be uniquify, overwrite or prompt.');
      return { name, saveAs: input.saveAs === true, conflictAction };
    }
    throw new Error('Unknown helper.');
  }
  function permissions(grants, firefox = false) {
    const has = name => grants.includes('GM_' + name) || grants.includes('GM.' + name);
    const network = has('xmlhttpRequest') || grants.includes('GM.xmlHttpRequest');
    return [...new Set([...(has('setClipboard') ? ['clipboardWrite', ...(!firefox ? ['offscreen'] : [])] : []),
      ...(has('notification') ? ['notifications'] : []), ...(has('download') ? ['downloads'] : []),
      // Firefox requires cookie access to open a tab in a container.
      ...(has('cookie') || firefox && has('openInTab') ? ['cookies'] : []),
      ...(firefox && (network || has('download')) ? ['webRequestBlocking'] : []), ...(!firefox && network ? ['offscreen'] : [])])];
  }
  // The calling tab's top-level site and registrable domain. Unknown suffixes
  // use the Public Suffix List default rule (the last label), like browsers.
  function topLevel(value) {
    const url = new URL(value), host = url.hostname; let domain = host;
    if (!host.startsWith('[') && !/^\d+(?:\.\d+){3}$/.test(host) && host.includes('.')) {
      const suffix = BlockAdsMatching.publicSuffix(host) || host.slice(host.lastIndexOf('.') + 1);
      if (host !== suffix) domain = host.split('.').slice(-suffix.split('.').length - 1).join('.');
    }
    return { site: url.protocol + '//' + domain, domain };
  }
  function cookieOptions(method, input, metadata, pageURL, context = {}) {
    const shared = ['url', 'name', 'storeId', 'partitionKey', 'firstPartyDomain'];
    const options = {
      list: [...shared, 'domain', 'path', 'secure', 'session'],
      set: [...shared, 'value', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expirationDate'],
      delete: shared
    };
    if (!Object.hasOwn(options, method) || !input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !options[method].includes(key))) throw new Error('Unsupported cookie operation or option.');
    const details = { ...input }, own = new URL(pageURL);
    if (details.url !== undefined && (typeof details.url !== 'string' || details.url.length > 4096 || /[\s\u0000-\u001f]/.test(details.url))) throw new Error('Use an absolute HTTP(S) cookie URL without credentials.');
    const url = new URL(details.url ?? pageURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an absolute HTTP(S) cookie URL without credentials.');
    const allowed = host => host === own.hostname || metadata.connects.some(rule => rule === '*' || rule === 'self' && host === own.hostname ||
      rule !== 'self' && (host === rule.replace(/^\*\./, '') || host.endsWith('.' + rule.replace(/^\*\./, ''))));
    if (!allowed(url.hostname)) throw new Error('Cookie destination requires an explicit @connect entry; the default is the current host.');
    url.hash = ''; details.url = url.href;
    for (const name of ['name', 'value', 'domain', 'path', 'storeId']) if (details[name] !== undefined &&
        (typeof details[name] !== 'string' || new TextEncoder().encode(details[name]).length > (name === 'value' ? 4096 : 1024) ||
          /[\u0000-\u001f\u007f]/.test(details[name]))) throw new Error('Invalid or oversized cookie ' + name + '.');
    if (method === 'delete' && details.name === undefined) throw new Error('Cookie deletion requires a name.');
    if (details.path !== undefined && !details.path.startsWith('/')) throw new Error('Cookie paths must start with /.');
    if (details.domain !== undefined) {
      const domain = details.domain.replace(/^\./, '').toLowerCase();
      if (!domain || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ||
          !(url.hostname === domain || url.hostname.endsWith('.' + domain))) throw new Error('Cookie domain must match the requested URL.');
      // Setting a parent-domain cookie also affects siblings, so that domain
      // needs its own authorization instead of inheriting the child host's.
      if (method === 'set' && !allowed(domain)) throw new Error('Setting a parent-domain cookie requires an explicit @connect entry for that domain.');
    }
    for (const name of ['secure', 'httpOnly', 'session']) if (details[name] !== undefined && typeof details[name] !== 'boolean') throw new Error('Cookie ' + name + ' must be a boolean.');
    if (details.sameSite !== undefined && !['unspecified', 'no_restriction', 'lax', 'strict'].includes(details.sameSite)) throw new Error('Unsupported cookie sameSite value.');
    if (details.expirationDate !== undefined && (!Number.isFinite(details.expirationDate) || details.expirationDate < 0)) throw new Error('Use a finite, nonnegative cookie expirationDate.');
    // Partitioned storage is limited to the calling page's own top-level site.
    // An omitted or empty topLevelSite would address every partition.
    if (details.partitionKey !== undefined || details.firstPartyDomain !== undefined) {
      const top = topLevel(context.topURL ?? pageURL), key = details.partitionKey;
      if (key !== undefined) {
        if (!key || typeof key !== 'object' || Array.isArray(key) || Object.keys(key).some(name => !['topLevelSite', 'hasCrossSiteAncestor'].includes(name)) ||
            key.topLevelSite !== top.site || key.hasCrossSiteAncestor !== undefined && typeof key.hasCrossSiteAncestor !== 'boolean')
          throw new Error('partitionKey.topLevelSite must be this tab’s top-level site, ' + top.site + '. Other partitions are not exposed.');
        details.partitionKey = { ...key };
      }
      if (details.firstPartyDomain !== undefined) {
        if (!context.firefox) throw new Error('firstPartyDomain is available only in Firefox.');
        if (details.firstPartyDomain !== '' && details.firstPartyDomain !== top.domain) throw new Error('firstPartyDomain must be empty or this tab’s first-party domain, ' + top.domain + '.');
      }
    }
    return details;
  }
  async function cookieRequest(api, method, input, metadata, sender, pageURL, verify, onWriteDispatch) {
    // A subframe's partition is keyed by its tab's top-level page. Without a
    // tab URL, partition options fail closed instead of using the frame's site.
    const topURL = sender.frameId === 0 ? pageURL : sender.tab?.url;
    const details = cookieOptions(method, input, metadata, pageURL, { topURL: topURL ?? 'about:invalid', firefox: typeof api.runtime.getBrowserInfo === 'function' });
    const check = async () => {
      if (!api.cookies || !await api.permissions.contains({ permissions: ['cookies'] })) throw new Error('Allow cookie access in Modules & scripts before using GM_cookie.');
      await verify();
    };
    await check();
    const stores = await api.cookies.getAllCookieStores();
    const store = stores.find(item => item.tabIds.includes(sender.tab.id));
    if (!store || details.storeId !== undefined && details.storeId !== store.id) throw new Error('Cookies are restricted to the calling tab’s cookie store.');
    details.storeId = store.id;
    await check();
    if (method !== 'list') onWriteDispatch();
    const result = await api.cookies[method === 'list' ? 'getAll' : method === 'delete' ? 'remove' : 'set'](details);
    if (method !== 'list') {
      // Once submitted, a native write cannot be cancelled. Preserve its actual
      // outcome; a later revocation must not turn success into a false failure.
      if (method === 'set' && !result) throw new Error('The browser did not set the cookie.');
      return { ok: true };
    }
    await check();
    // Browsers can return partitioned entries alongside unpartitioned cookies.
    // Keep only the partition this call was allowed to address.
    const cookies = result.filter(cookie => (!cookie.partitionKey?.topLevelSite || cookie.partitionKey.topLevelSite === details.partitionKey?.topLevelSite) &&
      (!cookie.firstPartyDomain || cookie.firstPartyDomain === details.firstPartyDomain));
    if (cookies.length > 256 || new TextEncoder().encode(JSON.stringify(cookies)).length > 1048576) throw new Error('Cookie results exceed 256 entries or 1 MiB. Narrow the URL or name filter.');
    return { ok: true, cookies };
  }
  // Serialized into each native userscript world. Callbacks never cross worlds.
  function client(send, active, report, normalize) {
    const jobs = new Map(); let sequence = 0, ready = false;
    function finish(job, error) {
      jobs.delete(job.id); job.finished = true; job.error = error;
      if (error) { job.reject?.(error); job.removeReject?.(error); if (job.kind === 'notification') report(error); }
      else {
        job.resolve?.(); job.removeResolve?.();
        try { if (job.kind === 'notification') job.callbacks.ondone?.(); } catch (caught) { report(caught); }
      }
    }
    function remove(job) {
      if (job.finished) return job.error ? Promise.reject(job.error) : Promise.resolve();
      if (!active()) return Promise.reject(new Error('This notification is no longer connected.'));
      if (job.removal) return job.removal;
      job.removal = new Promise((resolve, reject) => { job.removeResolve = resolve; job.removeReject = reject; });
      if (!job.sent) finish(job);
      else void send('removeNotification', { actionId: job.id }).catch(error => {
        job.removal = undefined; job.removeReject(error); job.removeResolve = job.removeReject = undefined;
      });
      return job.removal;
    }
    function dispatch(job) {
      if (!ready || job.sent || !jobs.has(job.id)) return;
      job.sent = true;
      void send(job.kind, { actionId: job.id, details: job.details }).catch(error => {
        if (jobs.get(job.id) === job) finish(job, error);
      });
    }
    function create(kind, details, callbacks = {}) {
      if (!active()) throw new Error('This userscript is inactive. Reload the page.');
      details = normalize(kind, details);
      if (jobs.size >= 8) throw new Error('Too many pending desktop helpers.');
      const job = { id: String(++sequence), kind, details, callbacks }; jobs.set(job.id, job);
      const result = kind === 'notification' ? Object.freeze({ remove: () => remove(job) })
        : new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      dispatch(job); return result;
    }
    return {
      clipboard: (data, type) => create('clipboard', { data, type }),
      notification: (options, title, image, onclick) => {
        if (typeof options === 'string') options = { text: options, title, image, onclick };
        if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Use notification options or text.');
        const { onclick: click, ondone, ...details } = options;
        if ([click, ondone].some(value => value !== undefined && typeof value !== 'function')) throw new TypeError('Notification callbacks must be functions.');
        return create('notification', details, { onclick: click, ondone });
      },
      event: message => {
        const job = jobs.get(message.actionId); if (!job) return;
        if (message.event === 'click') { try { job.callbacks.onclick?.(); } catch (error) { report(error); } }
        else if (message.event === 'done') finish(job);
        else if (message.event === 'error') finish(job, new Error(message.error || 'Desktop helper failed.'));
      },
      ready: () => { ready = true; for (const job of jobs.values()) dispatch(job); },
      disconnect: () => { ready = false; for (const job of [...jobs.values()]) finish(job, new Error('Userscript connection closed; desktop action was not retried.')); }
    };
  }
  function create(api, isLive) {
    const jobs = new Map(), rates = new Map();
    let clipboardTail = Promise.resolve(), notificationCleanup;
    const offscreen = BlockAdsOffscreen.create(api);
    const alive = job => !job.cancelled && jobs.get(job.key) === job && isLive(job.connection);
    function emit(job, event, payload = {}) {
      if (!alive(job)) return;
      try { job.connection.port.postMessage({ type: job.kind === 'download' ? 'download' : 'action',
        ...(job.kind === 'download' ? { requestId: job.id } : { actionId: job.id }), ...payload, event }); }
      catch { drop(job.connection); }
    }
    function forget(job) {
      job.releaseBudget?.();
      if (job.objectURL) { URL.revokeObjectURL(job.objectURL); job.objectURL = undefined; }
      if (jobs.get(job.key) === job) jobs.delete(job.key);
    }
    function finish(job, event, payload) { emit(job, event, payload); forget(job); }
    async function allowed(job) {
      const permission = job.kind === 'clipboard' ? 'clipboardWrite' : job.kind === 'notification' ? 'notifications' : 'downloads';
      if (!await api.permissions.contains({ permissions: [permission] })) throw new Error('Allow ' + permission + ' in Modules & scripts before using this helper.');
      if (!alive(job)) throw new Error('This userscript is inactive.');
    }
    async function copy(details, job) {
      if (typeof document !== 'undefined') return BlockAdsClipboard.write(details);
      if (!await api.permissions.contains({ permissions: ['offscreen'] }) || !api.offscreen) throw new Error('Allow clipboard helper access in Modules & scripts.');
      const release = await offscreen.acquire();
      try {
        await allowed(job);
        const response = await api.runtime.sendMessage({ type: 'ME_CLIPBOARD_WRITE', details });
        if (!response?.ok) throw new Error(response?.error || 'Clipboard helper did not respond.');
      } finally { await release(); }
    }
    async function clearNativeNotification(id) {
      if (!api.notifications) throw new Error('Notification permission is unavailable for cleanup.');
      return api.notifications.clear(id);
    }
    async function clearNotification(job) {
      if (job.nativeId !== undefined) await clearNativeNotification(job.nativeId);
      finish(job, 'done');
    }
    async function cancelDownload(job) {
      if (job.nativeId !== undefined) await api.downloads.cancel(job.nativeId);
    }
    function cancel(job) {
      if (job.cancelled) return;
      job.cancelled = true; job.controller?.abort();
      if (job.nativeId !== undefined && !job.creating) {
        const work = job.kind === 'notification' ? clearNativeNotification(job.nativeId) : cancelDownload(job);
        void work.catch(error => console.warn('[Module Engine] Helper cleanup:', error)).finally(() => forget(job));
      }
      // Pending native creation remains counted until it returns, then is
      // cleared/cancelled. Never retry it or delete a completed user file.
    }
    function drop(connection) { for (const job of jobs.values()) if (job.connection === connection) cancel(job); }
    async function notify(job, details, scriptName) {
      await prepareNotifications();
      await allowed(job);
      if (job.removeRequested) { finish(job, 'done'); return; }
      if (details.tag) for (const previous of [...jobs.values()]) if (previous !== job && previous.kind === 'notification' &&
          previous.connection === job.connection && previous.tag === details.tag) {
        emit(previous, 'done'); cancel(previous);
      }
      job.tag = details.tag;
      const id = 'me-us-' + crypto.randomUUID();
      job.nativeId = id;
      await api.notifications.create(id, { type: 'basic', iconUrl: details.image || api.runtime.getURL('icons/icon128.png'),
        title: scriptName + ' · ' + (details.title || 'Module Engine'), message: details.text,
        // Firefox rejects this Chromium-only field, including silent:false.
        ...(typeof api.runtime.getBrowserInfo === 'function' ? {} : { silent: details.silent }) });
      if (!alive(job) || job.removeRequested) {
        await clearNativeNotification(id);
        finish(job, 'done');
      }
    }
    async function download(job, details, file) {
      await allowed(job);
      job.releaseBudget = BlockAdsUserScriptNetwork.reserve(details, BlockAdsUserScriptNetwork.LIMITS.download);
      let loaded;
      await BlockAdsUserScriptNetwork.request(details, job.controller, payload => {
        if (payload.event === 'load') loaded = payload;
        else {
          emit(job, payload.event, payload);
          if (['error', 'abort', 'timeout'].includes(payload.event)) job.transportFailed = true;
        }
      }, { limit: BlockAdsUserScriptNetwork.LIMITS.download, budget: job.releaseBudget });
      if (!alive(job) || job.transportFailed) { forget(job); return; }
      if (!loaded || loaded.status < 200 || loaded.status >= 300) throw new Error('Download returned HTTP ' + (loaded?.status || 0) + '.');
      await allowed(job);
      job.response = loaded;
      job.creating = true;
      // Firefox disallows data: download URLs. Its background document owns a
      // Blob URL until completion/cancellation; Chromium workers use data:.
      const url = typeof api.runtime.getBrowserInfo === 'function'
        ? (job.objectURL = URL.createObjectURL(new Blob([BlockAdsUserScriptNetwork.decode(loaded.body, BlockAdsUserScriptNetwork.LIMITS.download)], { type: 'application/octet-stream' })))
        : 'data:application/octet-stream;base64,' + loaded.body;
      const id = await api.downloads.download({ url,
        filename: file.name, saveAs: file.saveAs, conflictAction: file.conflictAction });
      job.nativeId = id; job.creating = false;
      if (!alive(job)) { try { await cancelDownload(job); } finally { forget(job); } return; }
      const items = await api.downloads.search({ id });
      if (!items.length) throw new Error('The browser lost the download record.');
      downloadState(job, items[0].state, items[0].error);
    }
    function downloadState(job, state, error) {
      if (state === 'complete') finish(job, 'load', job.response);
      else if (state === 'interrupted') finish(job, error === 'USER_CANCELED' ? 'abort' : 'error', { readyState: 4, error: error || 'Download interrupted.' });
    }
    function request(message, script, metadata, connection) {
      if (!connection) throw new Error('Desktop helpers require a native userscript connection.');
      const id = message.actionId ?? message.requestId;
      if (typeof id !== 'string' || !/^[0-9]{1,16}$/.test(id)) throw new Error('Invalid helper handle.');
      const kind = message.operation === 'removeNotification' ? 'notification' : message.operation === 'abortDownload' ? 'download' : message.operation;
      const key = connection.id + ':' + kind + ':' + id;
      if (message.operation === 'removeNotification') {
        const job = jobs.get(key); if (!job) return { ok: true };
        job.removeRequested = true;
        if (job.nativeId !== undefined && !job.creating) void clearNotification(job).catch(error => finish(job, 'error', { error: errorText(error) }));
        return { ok: true };
      }
      if (message.operation === 'abortDownload') {
        const job = jobs.get(key);
        if (job) { emit(job, 'abort', { readyState: 4, error: 'Download aborted.' }); cancel(job); }
        return { ok: true };
      }
      let details, file;
      if (kind === 'download') {
        const { name, saveAs, conflictAction, ...networkDetails } = message.details || {};
        file = normalize('download', { name, saveAs, conflictAction });
        // Reject before transferring: Firefox has not implemented this native value.
        if (file.conflictAction === 'prompt' && typeof api.runtime.getBrowserInfo === 'function') throw new Error('Firefox does not support conflictAction "prompt". Use saveAs: true to choose the destination.');
        details = BlockAdsUserScriptNetwork.validate(networkDetails, metadata, connection.sender.url, true);
        if (details.method !== 'GET' || details.responseType !== 'blob' || details.body !== undefined || details.formData || details.upload) throw new Error('Downloads require a GET request for binary data.');
      } else details = normalize(kind, message.details);
      const current = [...jobs.values()];
      if (jobs.has(key) || current.length >= 32 || current.filter(job => job.connection.scriptId === script.id).length >= 8 ||
          current.filter(job => job.connection === connection).length >= 4) throw new Error('Too many active desktop helpers.');
      const rateKey = script.id + ':' + kind, now = performance.now(), rate = rates.get(rateKey);
      if (rate && now - rate.start < 60000 && rate.count >= 32) throw new Error('At most 32 desktop actions of each kind per script per minute.');
      for (const [key, value] of rates) if (now - value.start >= 60000) rates.delete(key);
      rates.set(rateKey, { start: rate && now - rate.start < 60000 ? rate.start : now, count: rate && now - rate.start < 60000 ? rate.count + 1 : 1 });
      const job = { key, id, kind, connection, controller: new AbortController() }; jobs.set(key, job);
      let work;
      if (kind === 'clipboard') {
        // Serial clipboard writes preserve call order without holding controls.
        work = clipboardTail.then(async () => { await allowed(job); await copy(details, job); finish(job, 'done'); });
        clipboardTail = work.catch(() => {});
      } else if (kind === 'notification') {
        job.creating = true;
        work = notify(job, details, metadata.name).finally(() => { job.creating = false; });
      } else work = download(job, details, file);
      void work.catch(error => {
        finish(job, 'error', { readyState: 4, error: errorText(error) });
        if (job.nativeId !== undefined) {
          const cleanup = job.kind === 'notification' ? clearNativeNotification(job.nativeId) : cancelDownload(job);
          void cleanup.catch(error => console.warn('[Module Engine] Helper cleanup:', error));
        }
      });
      return { ok: true };
    }
    const bound = new WeakSet();
    function listen(event, callback) {
      if (event && !bound.has(event)) { event.addListener(callback); bound.add(event); }
    }
    function bindEvents() {
      listen(api.notifications?.onClicked, id => { for (const job of jobs.values()) if (job.kind === 'notification' && job.nativeId === id) emit(job, 'click'); });
      listen(api.notifications?.onClosed, id => { for (const job of jobs.values()) if (job.kind === 'notification' && job.nativeId === id) finish(job, 'done'); });
      listen(api.downloads?.onChanged, delta => { for (const job of jobs.values()) if (job.kind === 'download' && job.nativeId === delta.id) downloadState(job, delta.state?.current, delta.error?.current); });
    }
    function prepareNotifications() {
      // A restarted worker cannot restore callbacks in old document worlds.
      // Clear only our userscript notifications; never replay them.
      if (!notificationCleanup) notificationCleanup = (async () => {
        if (!api.notifications || !await api.permissions.contains({ permissions: ['notifications'] })) return;
        const existing = await api.notifications.getAll();
        for (const id of Object.keys(existing)) if (id.startsWith('me-us-') && ![...jobs.values()].some(job => job.nativeId === id)) await clearNativeNotification(id);
      })().catch(error => { notificationCleanup = undefined; throw error; });
      return notificationCleanup;
    }
    bindEvents();
    void prepareNotifications().catch(error => console.warn('[Module Engine] Notification cleanup:', error));
    api.permissions?.onAdded?.addListener(change => {
      bindEvents();
      if (change.permissions?.includes('notifications')) {
        notificationCleanup = undefined;
        void prepareNotifications().catch(error => console.warn('[Module Engine] Notification cleanup:', error));
      }
    });
    api.permissions?.onRemoved?.addListener(change => {
      for (const job of jobs.values()) if ((change.permissions || []).some(permission => (job.kind === 'clipboard' ? ['clipboardWrite', 'offscreen'] : job.kind === 'download' ? ['downloads'] : ['notifications']).includes(permission))) {
        emit(job, 'error', { readyState: 4, error: 'Browser helper permission was removed.' }); cancel(job);
      }
    });
    return Object.freeze({ request, drop });
  }
  globalThis.BlockAdsUserScriptActions = Object.freeze({ normalize, permissions, client, create, cookieOptions, cookieRequest });
})();
