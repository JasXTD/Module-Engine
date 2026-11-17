/* Bounded HTTP transport. Downloads are data here; only native userScripts run code. */
(() => {
  'use strict';
  const core = BlockAdsUserScriptCore;
  const LIMITS = Object.freeze({ body: 8 * 1024 * 1024, response: 8 * 1024 * 1024, download: 16 * 1024 * 1024,
    budget: 64 * 1024 * 1024, timeout: 30000, downloadTimeout: 120000, redirects: 5 });
  const fail = message => { throw new Error(message); };
  const encode = bytes => {
    let value = '';
    for (let i = 0; i < bytes.length; i += 8192) value += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(value);
  };
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  let api, offscreen, reserved = 0, guardReady, ensureObserver = async () => {};
  const observed = new Map(), transfers = new Set(), GUARD_ID = 950000001, ANONYMOUS_ID = 950000002;
  // Response space reserved before any bytes arrive. Reserving the whole
  // response cap up front let eight idle or long-polling requests (or four
  // downloads) exhaust the shared budget for every script.
  const PROVISIONAL = 256 * 1024, GROWTH = 1024 * 1024;
  // Returns release(); release.grow(bytes) extends the response share to cover
  // `bytes` (bounded by `limit`) and throws when the shared budget is exhausted.
  function reserve(details, limit) {
    const request = (details.body ? Math.floor(details.body.length * 3 / 4) : 0) +
      (details.formData ? core.bytes(JSON.stringify(details.formData)) : 0);
    let held = 0, response = 0, released = false;
    const take = size => {
      if (reserved + size > LIMITS.budget) fail('Userscript transfers are using the 64 MiB buffer budget. Wait for an active transfer to finish.');
      reserved += size; held += size;
    };
    // Native upload-progress XHR buffers its whole response before returning.
    const initial = details.upload ? limit : Math.min(limit, PROVISIONAL);
    take(request + initial); response = initial;
    const release = () => { if (!released) { released = true; reserved -= held; held = 0; } };
    release.grow = bytes => {
      if (released || bytes <= response) return;
      // Grow in steps so a streamed body does not touch the budget per chunk.
      const target = Math.min(limit, Math.max(bytes, response + GROWTH));
      take(target - response); response = target;
    };
    return release;
  }
  const extensionRequest = details => {
    try {
      const origin = new URL(details.initiator || details.documentUrl || details.originUrl), own = new URL(api.runtime.getURL(''));
      return origin.protocol === own.protocol && origin.host === own.host;
    } catch { return false; }
  };
  function configure(browserAPI) {
    if (api === browserAPI) return;
    api = browserAPI;
    guardReady = undefined;
    offscreen = globalThis.BlockAdsOffscreen?.create(api);
    const listener = details => {
      const pending = observed.get(details.url);
      if (pending && extensionRequest(details)) {
        pending.native = details; pending.resolve(details);
        // Firefox's blocking observer sees the original Location. Its DNR header
        // modifications run before this listener, so cancel here before XHR follows.
        if (typeof api.runtime.getBrowserInfo === 'function' && details.url.includes('#me-us-xhr-') && [301,302,303,307,308].includes(details.statusCode)) return { cancel: true };
      }
      return {};
    };
    let bound = false;
    const bind = async () => {
      if (bound || !api.webRequest?.onHeadersReceived) return;
      const firefox = typeof api.runtime.getBrowserInfo === 'function';
      // Firefox exposes an extension's own response headers to blocking listeners.
      // Only our pending private nonce can trigger redirect cancellation.
      if (firefox && !await api.permissions.contains({ permissions: ['webRequestBlocking'] })) return;
      api.webRequest.onHeadersReceived.addListener(listener, { urls: ['<all_urls>'], types: ['xmlhttprequest'] }, ['responseHeaders', ...(firefox ? ['blocking'] : [])]);
      bound = true;
    };
    ensureObserver = bind;
    api.permissions?.onAdded?.addListener(() => { void bind().catch(error => console.warn('[Module Engine] Redirect observer:', error)); });
    api.permissions?.onRemoved?.addListener(change => {
      for (const transfer of transfers) if (change.permissions?.includes('webRequestBlocking') ||
          change.permissions?.includes('offscreen') && transfer.details.upload) transfer.controller.abort(new Error('Browser transfer permission was removed.'));
      if (change.permissions?.includes('webRequestBlocking') && bound) { api.webRequest.onHeadersReceived.removeListener(listener); bound = false; }
    });
    void bind().catch(error => console.warn('[Module Engine] Redirect observer:', error));
  }
  async function uploadGuard() {
    if (!api?.declarativeNetRequest) fail('Native upload progress is unavailable in this environment.');
    if (typeof api.runtime.getBrowserInfo === 'function') {
      if (!await api.permissions.contains({ permissions: ['webRequestBlocking'] })) fail('Allow helper access in the script editor before using Firefox upload progress.');
      await ensureObserver();
    }
    if (!guardReady) guardReady = (async () => {
      const condition = { resourceTypes: ['xmlhttprequest'], initiatorDomains: [new URL(api.runtime.getURL('')).hostname] };
      // Extension host access can make XHR send cookies even withCredentials=false.
      // Strip both directions only for this broker's private anonymous upload URL.
      const rules = [{ id: ANONYMOUS_ID, priority: 100000,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'cookie', operation: 'remove' }], responseHeaders: [{ header: 'set-cookie', operation: 'remove' }] },
        condition: { ...condition, regexFilter: '#me-us-xhr-anon-[a-f0-9-]+$' } }];
      if (typeof api.runtime.getBrowserInfo !== 'function') rules.push({ id: GUARD_ID, priority: 100000,
        action: { type: 'modifyHeaders', responseHeaders: [{ header: 'location', operation: 'remove' }] },
        condition: { ...condition, regexFilter: '#me-us-xhr-(anon-)?[a-f0-9-]+$' } });
      await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: rules.map(rule => rule.id), addRules: rules });
      const installed = await api.declarativeNetRequest.getSessionRules();
      for (const rule of rules) {
        const actual = installed.find(item => item.id === rule.id);
        if (!actual || actual.priority !== rule.priority || actual.action.type !== 'modifyHeaders' ||
            ['requestHeaders', 'responseHeaders'].some(key => (actual.action[key]?.length || 0) !== (rule.action[key]?.length || 0) ||
              rule.action[key]?.some((header, index) => actual.action[key][index].header !== header.header || actual.action[key][index].operation !== header.operation)) ||
            Object.keys(rule.condition).some(key => JSON.stringify(actual.condition[key]) !== JSON.stringify(rule.condition[key]))) fail('The browser could not verify the upload privacy and redirect guards.');
      }
    })().catch(error => { guardReady = undefined; throw error; });
    await guardReady;
  }
  function destination(value, metadata, pageURL) {
    let url; try { url = new URL(value); } catch { fail('Use an absolute HTTP(S) request URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 8192) fail('Use an HTTP(S) URL without embedded credentials.');
    const hosts = metadata.connects, ownHost = new URL(pageURL).hostname;
    if (hosts.length && !hosts.some(host => host === '*' || host === 'self' && url.hostname === ownHost ||
        host !== 'self' && (url.hostname === host.replace(/^\*\./, '') || url.hostname.endsWith('.' + host.replace(/^\*\./, ''))))) fail('Request destination is outside this script’s @connect scope.');
    url.hash = ''; return url.href;
  }
  function decode(value, limit = LIMITS.body) {
    if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4) fail('Invalid or oversized request data.');
    let binary; try { binary = atob(value); } catch { fail('Invalid request data.'); }
    if (binary.length > limit) fail('Request data exceeds its size limit.');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  function makeBody(details) {
    if (!details.formData) return details.body === undefined ? undefined : decode(details.body);
    const form = new FormData();
    for (const entry of details.formData) {
      if (entry.body === undefined) form.append(entry.name, entry.value);
      else form.append(entry.name, new Blob([decode(entry.body)], { type: entry.type }), entry.filename);
    }
    return form;
  }
  // account(bytes) is told the buffered size before it is retained; it may throw.
  async function readBody(response, limit, signal, progress = () => {}, account = () => {}) {
    const total = Number(response.headers.get('content-length')) || 0;
    if (total > limit) { await response.body?.cancel(); fail('Response exceeds the download size limit.'); }
    if (!response.body) return new Uint8Array();
    try { if (total) account(total); }
    catch (error) { await response.body.cancel(); throw error; }
    const reader = response.body.getReader(), chunks = []; let loaded = 0, reported = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        loaded += value.length;
        if (loaded > limit) fail('Response exceeds the download size limit.');
        account(loaded);
        chunks.push(value);
        if (loaded - reported >= 65536) { reported = loaded; progress({ loaded, total, lengthComputable: total > 0 }); }
      }
      progress({ loaded, total, lengthComputable: total > 0 });
      const bytes = new Uint8Array(loaded); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
  async function prepare(metadata, signal) {
    const assets = []; let total = 0;
    for (const spec of core.assetSpecs(metadata)) {
      signal.throwIfAborted();
      const url = new URL(spec.url), expected = url.hash.slice(8).toLowerCase(); url.hash = '';
      const response = await fetch(url.href, { signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      if (!response.ok) fail('Dependency download returned HTTP ' + response.status + '.');
      const bytes = await readBody(response, Math.min(core.LIMITS.asset, core.LIMITS.assets - total), signal);
      total += bytes.length;
      const sha256 = await digest(bytes);
      if (expected && expected !== sha256) fail('Dependency SHA-256 does not match its metadata pin.');
      const mime = (response.headers.get('content-type') || 'application/octet-stream').slice(0, 128);
      if (spec.kind === 'require' && /(?:text\/html|application\/xhtml)/i.test(mime)) fail('@require returned HTML instead of JavaScript.');
      assets.push({ ...spec, body: encode(bytes), mime, sha256 });
    }
    return core.validateAssets(assets, metadata);
  }
  // Codes mark responses that are not a direct userscript, so an intercepted
  // link can return to the browser's ordinary handling of that page.
  const notScript = (message, code) => { throw Object.assign(new Error(message), { code }); };
  async function fetchSource(value, signal) {
    const url = core.sourceURL(value);
    signal.throwIfAborted();
    // Redirects are reported, never followed: approval binds the shown URL to its bytes.
    const response = await fetch(url, { signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    try {
      if (response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) notScript('The URL redirected. Use the final direct userscript URL.', 'SOURCE_REDIRECT');
      if (!response.ok) fail('Script download returned HTTP ' + response.status + '.');
      if (/(?:text\/html|application\/xhtml)/i.test(response.headers.get('content-type') || '')) notScript('The URL returned HTML. Use a direct userscript source URL.', 'SOURCE_NOT_SCRIPT');
      const bytes = await readBody(response, core.LIMITS.source, signal);
      signal.throwIfAborted();
      let source; try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { fail('Userscript source must contain valid UTF-8 text.'); }
      if (!/^\uFEFF?\s*\/\/\s*==UserScript==/.test(source)) notScript('Start the file with a // ==UserScript== metadata block and close it with // ==/UserScript==.', 'SOURCE_NOT_SCRIPT');
      core.parse(source); return source;
    } finally {
      // Also cancel rejected HTTP/MIME/Content-Length responses before reading.
      if (response.body && !response.body.locked) await response.body.cancel();
    }
  }
  async function verify(script) {
    const metadata = core.parse(script.source), specs = core.assetSpecs(metadata);
    if (!specs.length) return;
    const assets = core.validateAssets(script.assets, metadata);
    if (!assets) fail('Prepare and review this script’s dependencies before enabling it.');
    for (const asset of assets) {
      const sha256 = await digest(core.decodeAsset(asset.body)), pin = new URL(asset.url).hash.slice(8).toLowerCase();
      if (asset.sha256 !== sha256 || pin && pin !== sha256) fail('Cached dependency integrity check failed. Prepare it again.');
    }
  }
  function validate(details, metadata, pageURL, download = false) {
    if (!details || typeof details !== 'object' || Array.isArray(details)) fail('Use a request details object.');
    const allowed = ['url', 'method', 'headers', 'body', 'formData', 'upload', 'redirect', 'timeout', 'anonymous', 'responseType', 'overrideMimeType', 'user', 'password'];
    if (Object.keys(details).some(key => !allowed.includes(key))) fail('Unsupported request option.');
    const url = destination(details.url, metadata, pageURL);
    const method = String(details.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) fail('Unsupported HTTP method.');
    const headers = details.headers ?? {};
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 64) fail('Use at most 64 request headers.');
    const safeHeaders = Object.create(null);
    for (const [name, value] of Object.entries(headers)) {
      if (name.length > 256 || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /^(?:sec-|proxy-|cookie|host$|origin$|referer$|user-agent$|content-length$|connection$|accept-(?:charset|encoding)$|transfer-encoding$|upgrade$|via$|te$|trailer$|keep-alive$|access-control-request-|date$|dnt$|expect$|permissions-policy$|set-cookie2?$)/i.test(name) ||
          /^(?:x-http-method|x-http-method-override|x-method-override)$/i.test(name) && /\b(?:CONNECT|TRACE|TRACK)\b/i.test(value) ||
          typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value)) fail('Unsupported or invalid request header: ' + name);
      safeHeaders[name] = value;
    }
    for (const name of ['user', 'password']) if (details[name] !== undefined && (typeof details[name] !== 'string' ||
        core.bytes(details[name]) > 1024 || /[\u0000-\u001f\u007f]/.test(details[name]))) fail('Use a ' + name + ' string of at most 1 KiB without control characters.');
    if (details.user?.includes(':')) fail('HTTP user names cannot contain a colon.');
    // Credentials are sent preemptively as Basic authentication; an explicit
    // Authorization header wins. Cross-origin redirects drop it with all
    // other caller headers. Challenge-based schemes such as Digest are not used.
    if ((details.user || details.password) && !Object.keys(safeHeaders).some(name => name.toLowerCase() === 'authorization')) {
      const credentials = new TextEncoder().encode((details.user || '') + ':' + (details.password || ''));
      safeHeaders.Authorization = 'Basic ' + btoa(String.fromCharCode(...credentials));
    }
    if (core.bytes(JSON.stringify(safeHeaders)) > 32768) fail('Request headers exceed 32 KiB.');
    const responseType = details.responseType || 'text';
    if (!['text', 'json', 'arraybuffer', 'blob', 'document'].includes(responseType)) fail('Unsupported responseType.');
    if (details.timeout !== undefined && (!Number.isFinite(details.timeout) || details.timeout < 0)) fail('Use a nonnegative timeout.');
    if (details.anonymous !== undefined && typeof details.anonymous !== 'boolean') fail('anonymous must be a boolean.');
    if (details.upload !== undefined && typeof details.upload !== 'boolean') fail('Invalid upload event option.');
    if (details.redirect !== undefined && !['follow', 'error'].includes(details.redirect)) fail('redirect supports follow or error.');
    const mime = details.overrideMimeType || '';
    if (typeof mime !== 'string' || mime.length > 128 || /[\r\n]/.test(mime)) fail('Invalid MIME override.');
    let body, formData;
    if (details.body !== undefined || details.formData !== undefined) {
      if (method === 'GET' || method === 'HEAD') fail('GET and HEAD requests cannot contain data.');
      if (details.body !== undefined && details.formData !== undefined) fail('Use one request body.');
      if (details.body !== undefined) { decode(details.body); body = details.body; }
      else {
        if (!Array.isArray(details.formData) || details.formData.length > 256) fail('FormData supports at most 256 entries.');
        if (Object.keys(safeHeaders).some(name => name.toLowerCase() === 'content-type')) fail('Let the browser set Content-Type and the FormData boundary.');
        let total = 0;
        formData = details.formData.map(entry => {
          if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || core.bytes(entry.name) > 1024 || /[\r\n\0]/.test(entry.name)) fail('Invalid FormData entry name.');
          let result;
          if (entry.body === undefined) {
            if (Object.keys(entry).some(key => !['name', 'value'].includes(key)) || typeof entry.value !== 'string') fail('Invalid FormData text entry.');
            total += core.bytes(entry.value); result = { name: entry.name, value: entry.value };
          } else {
            if (Object.keys(entry).some(key => !['name', 'body', 'filename', 'type'].includes(key)) || typeof entry.filename !== 'string' ||
                entry.filename.length > 1024 || /[\r\n\0]/.test(entry.filename) || typeof entry.type !== 'string' || entry.type.length > 128 || /[^\x20-\x7e]/.test(entry.type)) fail('Invalid FormData file entry.');
            total += decode(entry.body, LIMITS.body - total).length;
            result = { name: entry.name, body: entry.body, filename: entry.filename, type: entry.type };
          }
          // Reserve multipart framing as well as content, before constructing it.
          total += core.bytes(entry.name) + core.bytes(entry.filename || '') + 512;
          if (total > LIMITS.body) fail('FormData exceeds the 8 MiB upload limit.');
          return result;
        });
      }
    }
    const timeout = download ? LIMITS.downloadTimeout : LIMITS.timeout;
    return { url, method, headers: safeHeaders, body, formData, upload: details.upload === true, redirect: details.redirect || 'follow',
      scope: { connects: [...metadata.connects], pageURL }, timeout: Math.min(details.timeout || timeout, timeout),
      anonymous: details.anonymous === true, responseType, overrideMimeType: mime };
  }
  async function hop(details, signal, emit, limit) {
    await ensureObserver();
    const key = details.url + '#me-us-' + (details.upload ? 'xhr-' + (details.anonymous ? 'anon-' : '') : 'fetch-') + crypto.randomUUID();
    let resolve, reject;
    const headers = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Normal responses do not await this promise; consume cancellation there too.
    void headers.catch(() => {});
    const abort = () => reject(signal.reason || new Error('Request aborted.'));
    const pending = { resolve }; observed.set(key, pending); signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      let response;
      if (details.upload) {
        await uploadGuard(); signal.throwIfAborted();
        const input = { ...details, url: key, limit };
        try {
          const data = typeof api.runtime.getBrowserInfo === 'function'
            ? await BlockAdsXHR.request(input, signal, emit) : await offscreen.xhr(input, signal, emit);
          const responseHeaders = new Headers();
          for (const line of data.headers.split(/\r?\n/)) { const colon = line.indexOf(':'); if (colon > 0) responseHeaders.append(line.slice(0, colon), line.slice(colon + 1).trim()); }
          response = new Response([204, 205, 304].includes(data.status) ? null : decode(data.body, limit), { status: data.status, statusText: data.statusText, headers: responseHeaders });
        } catch (error) {
          signal.throwIfAborted();
          if (typeof api.runtime.getBrowserInfo !== 'function' || ![301,302,303,307,308].includes(pending.native?.statusCode)) throw error;
          response = new Response(null, { status: pending.native.statusCode });
        }
      } else response = await fetch(key, { method: details.method, headers: details.headers, body: makeBody(details),
        signal, credentials: details.anonymous ? 'omit' : 'include', redirect: 'manual', referrerPolicy: 'no-referrer', cache: 'no-store' });
      signal.throwIfAborted();
      if (response.type === 'opaqueredirect' || [301,302,303,307,308].includes(response.status)) {
        if (details.redirect === 'error') { await response.body?.cancel(); fail('Redirects are disabled for this request.'); }
        let status = response.status, location = response.headers.get('location');
        if (!location && api) {
          if (typeof api.runtime.getBrowserInfo === 'function' && !await api.permissions.contains({ permissions: ['webRequestBlocking'] })) fail('Allow helper access in the script editor to follow Firefox redirects.');
          const native = await headers;
          status = native.statusCode; location = native.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
        }
        await response.body?.cancel();
        if (![301,302,303,307,308].includes(status) || !location) fail('The browser did not expose a usable redirect destination.');
        return { status, location };
      }
      return { response };
    } finally { observed.delete(key); signal.removeEventListener('abort', abort); }
  }
  function redirected(details, status, location) {
    const url = destination(new URL(location, details.url).href, details.scope || { connects: [] }, details.scope?.pageURL || details.url);
    if (details.url.startsWith('https:') && !url.startsWith('https:')) fail('HTTPS redirects cannot downgrade to HTTP.');
    const next = { ...details, url, headers: { ...details.headers } };
    // Never forward caller credentials or custom headers to another origin.
    if (new URL(url).origin !== new URL(details.url).origin) next.headers = {};
    if (status === 303 && details.method !== 'HEAD' || [301,302].includes(status) && details.method === 'POST') {
      next.method = 'GET'; next.body = next.formData = undefined; next.upload = false;
      for (const name of Object.keys(next.headers)) if (/^content-/i.test(name)) delete next.headers[name];
    }
    return next;
  }
  // `budget` is a caller-owned reservation from reserve(); otherwise one is held here.
  async function request(details, controller, emit, { limit = LIMITS.response, budget } = {}) {
    const transfer = { details, controller }; transfers.add(transfer);
    let timeout = false;
    const timer = setTimeout(() => { timeout = true; controller.abort(); }, details.timeout);
    const initial = { readyState: 1, status: 0, statusText: '', finalUrl: details.url, responseHeaders: '' };
    let state = initial, release;
    try {
      if (!budget) release = budget = reserve(details, limit);
      emit({ event: 'loadstart', ...state }); emit({ event: 'readystatechange', ...state });
      let current = details, response;
      for (let count = 0; ; count++) {
        const result = await hop(current, controller.signal, payload => {
          if (!payload.upload) state = { ...state, ...payload };
          emit({ ...state, ...payload });
        }, limit);
        if (result.response) { response = result.response; break; }
        if (count >= LIMITS.redirects) fail('Request exceeded five redirects.');
        current = redirected(current, result.status, result.location);
      }
      state = { readyState: current.upload ? Math.max(2, state.readyState) : 2, status: response.status, statusText: response.statusText, finalUrl: current.url,
        responseHeaders: [...response.headers].filter(([name]) => !/^set-cookie2?$/i.test(name)).map(([name, value]) => name + ': ' + value).join('\r\n'),
        mime: details.overrideMimeType || response.headers.get('content-type') || 'application/octet-stream' };
      if (!current.upload) emit({ event: 'readystatechange', ...state });
      const bytes = await readBody(response, limit, controller.signal, current.upload ? undefined : progress => {
        if (state.readyState !== 3) { state.readyState = 3; emit({ event: 'readystatechange', ...state }); }
        emit({ event: 'progress', ...state, ...progress });
      }, budget.grow);
      controller.signal.throwIfAborted();
      emit({ event: 'load', ...state, readyState: 4, body: encode(bytes) });
    } catch (error) {
      emit({ event: timeout ? 'timeout' : controller.signal.aborted ? 'abort' : 'error', ...initial, readyState: 4,
        error: timeout ? 'Request timed out.' : controller.signal.aborted ? 'Request aborted.' : String(error?.message || error) });
    } finally { clearTimeout(timer); release?.(); transfers.delete(transfer); }
  }
  globalThis.BlockAdsUserScriptNetwork = Object.freeze({ LIMITS, prepare, fetchSource, verify, validate, request, configure, encode, decode, makeBody, reserve, redirected });
})();
