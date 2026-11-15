/* Local userscript format and registration compiler. Never evaluates script code. */
(() => {
  'use strict';
  const LIMITS = Object.freeze({ scripts: 32, source: 128 * 1024, sources: 1024 * 1024, values: 64 * 1024,
    asset: 256 * 1024, assets: 1024 * 1024, library: 3 * 1024 * 1024 });
  const METHODS = ['info', 'addStyle', 'addElement', 'openInTab', 'setClipboard', 'notification', 'download', 'getValue', 'setValue', 'deleteValue', 'listValues',
    'getValues', 'setValues', 'deleteValues', 'addValueChangeListener', 'removeValueChangeListener',
    'registerMenuCommand', 'unregisterMenuCommand', 'getResourceText', 'getResourceURL', 'xmlhttpRequest', 'cookie'];
  const GRANTS = Object.freeze(['none', 'unsafeWindow', ...METHODS.flatMap(name => ['GM.' + name, 'GM_' + name]), 'GM.getResourceUrl', 'GM.xmlHttpRequest']);
  const FLAGS = new Set(['noframes', 'top-level-await', 'unwrap']);
  const SINGLE = new Set(['name', 'namespace', 'version', 'description', 'run-at', 'inject-into', ...FLAGS]);
  const INFORMATIONAL = new Set(['author', 'license', 'homepage', 'homepageURL', 'supportURL', 'icon', 'icon64', 'downloadURL', 'updateURL']);
  const REPEATED = Object.freeze(['match', 'exclude-match', 'include', 'exclude', 'grant', 'require', 'resource', 'connect', 'tag']);
  const METADATA = Object.freeze({ keys: Object.freeze([...SINGLE, ...REPEATED, ...INFORMATIONAL]), flags: Object.freeze([...FLAGS]),
    values: Object.freeze({ grant: GRANTS, 'run-at': Object.freeze(['document-start', 'document-body', 'document-end', 'document-idle']),
      'inject-into': Object.freeze(['auto', 'content', 'page']) }) });
  const bytes = text => new TextEncoder().encode(text).length;
  const fail = message => { throw new Error(message); };
  const unique = values => [...new Set(values)];
  const matching = globalThis.BlockAdsMatching;
  function patterns(value) {
    if (value === '<all_urls>') return ['http://*/*', 'https://*/*'];
    return [matching.matchPattern(value).normalized];
  }
  function parse(source) {
    if (typeof source !== 'string' || !source.trim() || bytes(source) > LIMITS.source) fail('A script must contain at most 128 KiB of UTF-8 source.');
    // Keep the closing marker on its own line: \s* could start between CR and LF
    // and leave the preceding metadata value with a stray carriage return.
    const header = /^\uFEFF?\s*\/\/\s*==UserScript==[ \t]*\r?\n([\s\S]*?)^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*(?:\r?\n|$)/m.exec(source);
    if (!header || source.slice(0, header.index).trim() || header[1].length > 16384) fail('Start the file with a // ==UserScript== metadata block and close it with // ==/UserScript==.');
    const entries = Object.create(null), informational = Object.create(null), warnings = [];
    for (const line of header[1].split(/\r?\n/)) {
      if (/^\s*(?:\/\/\s*)?$/.test(line)) continue;
      const entry = /^\s*\/\/\s*@([\w:-]+)(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
      if (!entry) fail('Metadata lines must use // @key value.');
      const [, key, raw = ''] = entry, value = raw.trim();
      if (INFORMATIONAL.has(key) || /^(name|description):[\w-]+$/.test(key)) {
        informational[key] = value;
        if (['icon', 'icon64'].includes(key)) warnings.push('@' + key + ' does not trigger icon downloads.');
        if (key === 'downloadURL') warnings.push('@downloadURL supplies updates after you install this script through Install from URL. Every update needs your review.');
        if (key === 'updateURL') warnings.push('@updateURL is used to check the version after you install this script through Install from URL.');
        continue;
      }
      if (!SINGLE.has(key) && !REPEATED.includes(key)) fail('Unsupported metadata @' + key + '. See Supported userscript features.');
      if (SINGLE.has(key) && entries[key]) fail('Use only one @' + key + ' entry.');
      if (!FLAGS.has(key) && (!value || value.length > 2048)) fail('Missing or oversized @' + key + ' value.');
      if (FLAGS.has(key) && value) fail('@' + key + ' takes no value.');
      (entries[key] ||= []).push(value);
    }
    const one = (key, fallback = '') => entries[key]?.[0] ?? fallback;
    const name = one('name'), namespace = one('namespace', 'local.blockads');
    if (!name || name.length > 160 || namespace.length > 512) fail('Provide @name (up to 160 characters) and an optional @namespace (up to 512).');
    const matches = unique((entries.match || []).flatMap(patterns));
    const excludeMatches = unique((entries['exclude-match'] || []).flatMap(patterns));
    const globs = key => unique(entries[key] || []).map(value => {
      warnings.push(...matching.includePattern(value).regex?.notes || []);
      return value;
    });
    const includes = globs('include'), excludes = globs('exclude');
    if (!matches.length && !includes.length || [matches, excludeMatches, includes, excludes].some(list => list.length > 64)) fail('Provide @match or @include; each rule type supports up to 64 entries.');
    const runAt = one('run-at', 'document-end').replace('-', '_');
    if (!['document_start', 'document_body', 'document_end', 'document_idle'].includes(runAt)) fail('@run-at must be document-start, document-body, document-end or document-idle.');
    const unwrap = Boolean(entries.unwrap), topLevelAwait = Boolean(entries['top-level-await']);
    if (unwrap && topLevelAwait) fail('@unwrap cannot be combined with @top-level-await.');
    if (unwrap) {
      if (runAt === 'document_body') fail('@unwrap supports document-start, document-end and document-idle, not document-body.');
      warnings.push('@unwrap runs raw global code in the selected world. All @grant entries are ignored; no GM APIs or unsafeWindow alias are supplied.');
      // Scopes the browser cannot enforce natively get a separate pre-check
      // script; see BlockAdsMatching.rawGuard.
      if (!matching.exact({ matches, excludeMatches, includes, excludes })) warnings.push('This @unwrap scope is checked before the raw script starts. On pages that only the browser’s broader scope admits, no script code runs. Firefox may log one “redeclaration” error in the console for a skipped isolated script.');
    }
    const grants = unwrap ? [] : unique(entries.grant || ['none']);
    for (const grant of grants) if (!GRANTS.includes(grant)) fail('Unsupported grant ' + grant + '. Use only the APIs listed under Supported userscript features.');
    if (grants.includes('none') && grants.length !== 1) fail('@grant none cannot be combined with other grants.');
    const injection = one('inject-into', 'content');
    if (!['content', 'page', 'auto'].includes(injection)) fail('@inject-into must be content, page or auto.');
    const pageBridge = !unwrap && (injection === 'auto' || injection === 'page' && grants.some(grant => /^GM[._]/.test(grant)));
    if (pageBridge) warnings.push('Page execution shares the site’s JavaScript environment. Site code may interfere with the script, observe its data or invoke its granted helpers. Use content mode for isolation.');
    if (unwrap && injection === 'auto') warnings.push('@unwrap keeps native global declarations: auto retains isolated execution. Choose page explicitly for raw page-global code.');
    if (grants.includes('unsafeWindow')) warnings.push(injection !== 'content'
      ? 'unsafeWindow is the real page window during page execution, or the isolated global when auto falls back to content.'
      : 'unsafeWindow refers to this isolated world, as in content injection mode. Use page or auto for page JavaScript globals.');
    const requires = unique(entries.require || []).map(assetURL);
    const resources = (entries.resource || []).map(value => {
      const match = /^(\S+)\s+(\S+)$/.exec(value);
      if (!match || match[1].length > 128) fail('@resource requires a name and an absolute asset URL.');
      return { name: match[1], url: assetURL(match[2]) };
    });
    if (requires.length > 8 || resources.length > 16 || new Set(resources.map(item => item.name)).size !== resources.length) fail('Use at most 8 @require entries and 16 uniquely named @resources.');
    const connects = unique(entries.connect || []).map(value => {
      const host = value.toLowerCase();
      if (host !== '*' && host !== 'self' && (!/^(?:\*\.)?[a-z0-9.-]+$/.test(host) || host.length > 253 ||
          host.replace(/^\*\./, '').split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))) fail('Use @connect self, *, or a hostname (optionally *.example.com).');
      return host;
    });
    if (connects.length > 64) fail('Use at most 64 @connect entries.');
    return { name, namespace, version: one('version', '1.0'), explicitVersion: one('version'), description: one('description'),
      matches, excludeMatches, includes, excludes, grants, runAt, allFrames: !entries.noframes,
      world: injection === 'page' || injection === 'auto' && !unwrap ? 'MAIN' : 'USER_SCRIPT', injection, pageBridge, requires, resources, connects, informational,
      unwrap, topLevelAwait, tags: tags(entries.tag || []), metaStr: header[1], explicitRunAt: one('run-at'), warnings: unique(warnings) };
  }
  function tags(value) {
    if (!Array.isArray(value) || value.length > 16 || value.some(tag => typeof tag !== 'string' ||
        !tag.trim() || tag.trim().length > 64 || /[,\u0000-\u001f\u007f]/.test(tag))) fail('Use up to 16 tags, each 1–64 characters, without commas or control characters.');
    return unique(value.map(tag => tag.trim()));
  }
  function assetURL(value) {
    let url; try { url = new URL(value); } catch { fail('Use an absolute HTTPS asset URL, or HTTP on localhost for local development.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.href.length > 2048) fail('Assets require HTTPS (HTTP is allowed only on localhost), without URL credentials.');
    if (url.hash && !/^#sha256=[a-f0-9]{64}$/i.test(url.hash)) fail('Asset fragments must use #sha256=<64 hex characters>.');
    return url.href;
  }
  function sourceURL(value) {
    let url;
    try { if (typeof value !== 'string' || value.length > 2048 || /[\r\n\t]/.test(value)) throw new Error(); url = new URL(value); }
    catch { fail('Use an absolute HTTPS userscript URL, or HTTP on localhost for local development.'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || url.protocol === 'http:' && local) || url.username || url.password || url.hash || url.href.length > 2048)
      fail('Script URLs require HTTPS (HTTP only on localhost), without credentials or fragments.');
    return url.href;
  }
  function compareVersions(a, b) {
    // Dotted numeric segments, optionally suffixed with letters (ignored, as in
    // Violentmonkey). Compare digit strings to avoid large-number precision loss.
    const parts = value => typeof value === 'string' && value.length <= 2048 && /^\d+[a-z]*(?:\.\d+[a-z]*)*$/i.test(value)
      ? value.split('.').map(part => /^\d+/.exec(part)[0].replace(/^0+(?=\d)/, '')) : null;
    const left = parts(a), right = parts(b); if (!left || !right) return null;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const x = left[i] || '0', y = right[i] || '0';
      if (x !== y) return x.length !== y.length ? Math.sign(x.length - y.length) : x > y ? 1 : -1;
    }
    return 0;
  }
  function sourceReview(source, url, script) {
    const metadata = parse(source), previous = script ? parse(script.source) : null;
    if (previous && (metadata.name !== previous.name || metadata.namespace !== previous.namespace))
      fail('The downloaded @name or @namespace changed. The installed script was preserved.');
    return { source, sourceURL: sourceURL(url), metadata,
      ...(script ? { id: script.id, revision: script.revision, previousSource: script.source, previousSourceURL: script.sourceURL ?? null } : {}),
      versionChange: previous ? compareVersions(metadata.explicitVersion, previous.explicitVersion) : null,
      unchanged: Boolean(script && script.source === source && script.sourceURL === sourceURL(url)) };
  }
  const assetSpecs = metadata => [...metadata.requires.map(url => ({ kind: 'require', url })),
    ...metadata.resources.map(({ name, url }) => ({ kind: 'resource', name, url }))];
  function decodeAsset(value) {
    if (typeof value !== 'string' || value.length > Math.ceil(LIMITS.asset / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('Invalid or oversized cached asset.');
    return Uint8Array.from(atob(value), character => character.charCodeAt(0));
  }
  function validateAssets(value, metadata) {
    if (value == null) return null;
    const specs = assetSpecs(metadata);
    if (!Array.isArray(value) || value.length !== specs.length) fail('The cached dependencies do not match this script. Prepare them again.');
    let total = 0;
    return value.map((entry, index) => {
      const expected = specs[index];
      if (!entry || entry.kind !== expected.kind || entry.name !== expected.name || entry.url !== expected.url ||
          typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.mime !== 'string' ||
          entry.mime.length > 128 || /[\r\n]/.test(entry.mime)) fail('Invalid cached dependency metadata.');
      const data = decodeAsset(entry.body); total += data.length;
      if (data.length > LIMITS.asset || total > LIMITS.assets) fail('Dependencies support 256 KiB each and 1 MiB per script.');
      if (entry.kind === 'require') {
        try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { fail('@require must contain valid UTF-8 JavaScript.'); }
      }
      return { ...expected, sha256: entry.sha256, mime: entry.mime, body: entry.body };
    });
  }
  const allows = (metadata, url) => matching.allows(metadata, url);
  function jsonValue(value, depth = 0, count = { value: 0 }) {
    // Self-contained so the same validator can be bundled into the script world
    // before Chrome's JSON messaging could silently coerce unsupported values.
    const fail = message => { throw new Error(message); };
    if (depth > 20 || ++count.value > 10000) fail('Script values are too deeply nested or too large.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(item => jsonValue(item, depth + 1, count));
    if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === null ||
        Object.getPrototypeOf(Object.getPrototypeOf(value)) === null)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item, depth + 1, count)]));
    }
    fail('GM values must be JSON-compatible: strings, finite numbers, booleans, null, arrays or plain objects.');
  }
  function validateValues(values) {
    if (!values || Array.isArray(values) || typeof values !== 'object') fail('Invalid script value store.');
    const result = jsonValue(values);
    if (Object.keys(result).length > 256 || Object.keys(result).some(key => !key || key.length > 256) || bytes(JSON.stringify(result)) > LIMITS.values) fail('Each script can store up to 256 keys and 64 KiB of JSON values.');
    return result;
  }
  function library(raw) {
    if (raw === undefined) return { schemaVersion: 1, revision: 0, enabled: false, scripts: [] };
    if (!raw || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.revision) || raw.revision < 0 ||
        typeof raw.enabled !== 'boolean' || !Array.isArray(raw.scripts) || raw.scripts.length > LIMITS.scripts) fail('The userscript library is invalid. Its saved data has been preserved.');
    const ids = new Set(), identities = new Set(); let total = 0;
    const scripts = raw.scripts.map(script => {
      if (!script || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(script.id) || ids.has(script.id) ||
          !Number.isSafeInteger(script.revision) || script.revision < 1 || typeof script.enabled !== 'boolean' ||
          !/^[a-f0-9]{64}$/.test(script.token)) fail('A saved userscript record is invalid. Its data has been preserved.');
      ids.add(script.id);
      const metadata = parse(script.source), identity = JSON.stringify([metadata.namespace, metadata.name]);
      if (identities.has(identity)) fail('A script with this @name and @namespace already exists. Edit the saved script instead.');
      identities.add(identity); total += bytes(script.source);
      return { id: script.id, revision: script.revision, enabled: script.enabled, source: script.source,
        token: script.token, autoPageApproved: script.autoPageApproved === true, values: validateValues(script.values), assets: validateAssets(script.assets, metadata),
        tags: tags(script.tags ?? []), sourceURL: script.sourceURL == null ? null : sourceURL(script.sourceURL) };
    });
    const result = { schemaVersion: 1, revision: raw.revision, enabled: raw.enabled, scripts };
    if (total > LIMITS.sources || bytes(JSON.stringify(result)) > LIMITS.library) fail('The script library exceeds its local storage budget (1 MiB of source, 3 MiB total).');
    return result;
  }
  const nativeId = (id, order) => 'blockads-user-' + (order === undefined ? '' : String(order).padStart(2, '0') + '-') + id;
  function safeMenuIcon(value) {
    // Remote icons would make simply opening the popup a network request.
    return typeof value === 'string' && value.length <= 32768 &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/i.test(value) ? value : '';
  }
  // Serialized into the native isolated world. Context and callbacks never cross
  // the broker boundary; response bytes use base64 on Chromium's JSON channel.
  function scriptRequests(send, active, report, downloading = false, normalize) {
    const jobs = new Map(); let sequence = 0, ready = false;
    const callbacks = ['onloadstart', 'onreadystatechange', 'onprogress', 'onload', 'onerror', 'onabort', 'ontimeout', 'onloadend'];
    const invoke = (job, name, response) => { try { job.details['on' + name]?.(response); } catch (error) { report(error); } };
    const empty = () => ({ readyState: 0, status: 0, statusText: '', finalUrl: '', responseHeaders: '', responseText: '', response: null });
    function event(message) {
      const job = jobs.get(message.requestId); if (!job) return;
      if (message.upload) {
        job.uploadStarted = true;
        if (message.event === 'loadend') job.uploadEnded = true;
        job.uploadProgress = { lengthComputable: Boolean(message.lengthComputable), loaded: message.loaded || 0, total: message.total || 0, context: job.details.context };
        try { job.details.upload?.['on' + message.event]?.(job.uploadProgress); }
        catch (error) { report(error); }
        return;
      }
      const response = { ...empty(), ...message, context: job.details.context }; delete response.type; delete response.requestId; delete response.event; delete response.body;
      if (message.body !== undefined) {
        const binary = atob(message.body), bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const mime = message.mime || 'application/octet-stream', type = job.details.responseType || 'text';
        let text;
        if (!['arraybuffer', 'blob'].includes(type)) {
          let decoder; try { decoder = new TextDecoder(/charset\s*=\s*["']?([^;"'\s]+)/i.exec(mime)?.[1] || 'utf-8'); } catch { decoder = new TextDecoder(); }
          text = decoder.decode(bytes);
        }
        if (type === 'arraybuffer') response.response = bytes.buffer;
        else if (type === 'blob') response.response = new Blob([bytes], { type: mime });
        else if (type === 'json') { try { response.response = JSON.parse(text); } catch { response.response = null; } }
        else if (type === 'document') {
          const xmlType = /(?:application\/xml|text\/xml|application\/xhtml\+xml|image\/svg\+xml)/i.exec(mime)?.[0] || 'text/html';
          response.response = response.responseXML = new DOMParser().parseFromString(text, xmlType);
        } else response.response = response.responseText = text;
      }
      const terminal = ['load', 'error', 'abort', 'timeout'].includes(message.event);
      if (terminal) {
        jobs.delete(job.id); job.release?.();
        if (message.event !== 'load' && job.uploadStarted && !job.uploadEnded) {
          job.uploadEnded = true;
          for (const name of [message.event, 'loadend']) try { job.details.upload?.['on' + name]?.(job.uploadProgress); } catch (error) { report(error); }
        }
        invoke(job, 'readystatechange', response);
      }
      invoke(job, message.event, response);
      if (terminal) {
        invoke(job, 'loadend', response);
        if (message.event === 'load') job.resolve?.(response);
        else job.reject?.(Object.assign(new Error(message.error || 'Request failed.'), response));
      }
    }
    async function dispatch(job) {
      if (job.sent || !ready || !jobs.has(job.id)) return;
      job.sent = true;
      try {
        const { details } = job, payload = {};
        for (const name of ['url', 'method', 'headers', 'timeout', 'anonymous', 'responseType', 'overrideMimeType', 'redirect', 'user', 'password']) if (details[name] != null) payload[name] = details[name];
        if (details.upload) payload.upload = true;
        payload.url = new URL(String(details.url), location.href).href;
        if (downloading) {
          Object.assign(payload, normalize('download', details), { method: 'GET', responseType: 'blob' });
        }
        if (details.data != null) {
          let bytes;
          const encode = data => {
            let binary = '';
            // Copy indexed bytes instead of invoking a cross-compartment typed
            // array's species constructor through subarray() in Firefox.
            for (let i = 0; i < data.length; i += 8192) {
              const chunk = []; for (let j = i; j < Math.min(data.length, i + 8192); j++) chunk.push(data[j]);
              binary += String.fromCharCode(...chunk);
            }
            return btoa(binary);
          };
          if (typeof FormData !== 'undefined' && details.data instanceof FormData) {
            const entries = [...details.data];
            if (entries.length > 256) throw new Error('FormData supports at most 256 entries.');
            let total = 0;
            // Count all entries before reading any files, including duplicate names.
            for (const [name, value] of entries) {
              total += new TextEncoder().encode(name).length + 512 + (typeof value === 'string' ? new TextEncoder().encode(value).length : value.size + new TextEncoder().encode(value.name || 'blob').length);
              if (total > 8388608) throw new Error('FormData exceeds the 8 MiB upload limit.');
            }
            payload.formData = [];
            for (const [name, value] of entries) {
              if (!jobs.has(job.id) || !active()) return;
              payload.formData.push(typeof value === 'string' ? { name, value } : { name, body: encode(new Uint8Array(await value.arrayBuffer())), filename: value.name || 'blob', type: value.type });
            }
          } else if (typeof details.data === 'string' || details.data instanceof URLSearchParams) {
            bytes = new TextEncoder().encode(String(details.data));
            if (details.data instanceof URLSearchParams && !Object.keys(payload.headers || {}).some(name => name.toLowerCase() === 'content-type'))
              payload.headers = { ...payload.headers, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };
          } else if (details.data instanceof Blob) {
            if (details.data.size > 8388608) throw new Error('Request data exceeds 8 MiB.');
            bytes = new Uint8Array(await details.data.arrayBuffer());
            if (details.data.type && !Object.keys(payload.headers || {}).some(name => name.toLowerCase() === 'content-type')) payload.headers = { ...payload.headers, 'Content-Type': details.data.type };
          } else if (details.data instanceof ArrayBuffer) bytes = new Uint8Array(details.data);
          else if (ArrayBuffer.isView(details.data)) bytes = new Uint8Array(details.data.buffer, details.data.byteOffset, details.data.byteLength);
          else if (typeof ReadableStream !== 'undefined' && details.data instanceof ReadableStream) {
            // Read the whole stream within the upload limit, then send it as a
            // binary body. The browser bridge does not stream request bodies.
            const reader = details.data.getReader(), chunks = []; let total = 0, finished = false;
            job.release = () => { void reader.cancel().catch(() => {}); };
            try {
              for (;;) {
                const { value, done } = await reader.read();
                // Abort cancels the reader, which ends a pending read as done.
                if (!jobs.has(job.id) || !active()) break;
                if (done) { finished = true; break; }
                if (!ArrayBuffer.isView(value)) throw new TypeError('ReadableStream request data must produce Uint8Array chunks.');
                total += value.byteLength;
                if (total > 8388608) throw new Error('Request data exceeds 8 MiB.');
                chunks.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
              }
            } finally {
              job.release = undefined;
              if (!finished) void reader.cancel().catch(() => {});
              reader.releaseLock();
            }
            if (!finished) return;
            bytes = new Uint8Array(total); let offset = 0;
            // Index copies avoid cross-world typed-array constructors in Firefox.
            for (const chunk of chunks) for (let i = 0; i < chunk.length; i++) bytes[offset++] = chunk[i];
          } else throw new Error('Supported request data: string, URLSearchParams, FormData, Blob, ArrayBuffer, typed array or ReadableStream.');
          if (bytes) {
            if (bytes.length > 8388608) throw new Error('Request data exceeds 8 MiB.');
            payload.body = encode(bytes);
          }
        }
        if (!jobs.has(job.id) || !active()) return;
        await send(downloading ? 'download' : 'request', { requestId: job.id, details: payload });
      } catch (error) { event({ requestId: job.id, event: 'error', readyState: 4, error: error.message }); }
    }
    function create(details, modern) {
      if (!active()) throw new Error('This userscript is inactive. Reload the page.');
      if (!details || typeof details !== 'object' || Array.isArray(details) || details.url == null) throw new Error('Use request details with a URL.');
      const allowed = downloading ? ['url', 'name', 'headers', 'timeout', 'anonymous', 'redirect', 'user', 'password', 'saveAs', 'conflictAction', 'context', ...callbacks]
        : ['url', 'method', 'headers', 'data', 'timeout', 'anonymous', 'responseType', 'overrideMimeType', 'redirect', 'user', 'password', 'upload', 'context', ...callbacks];
      if (Object.keys(details).some(name => !allowed.includes(name)) || callbacks.some(name => details[name] !== undefined && typeof details[name] !== 'function')) throw new Error('Unsupported request option or callback.');
      if (['user', 'password'].some(name => details[name] != null && typeof details[name] !== 'string')) throw new TypeError('user and password must be strings.');
      if (details.upload !== undefined && (!details.upload || typeof details.upload !== 'object' || Array.isArray(details.upload) ||
          Object.keys(details.upload).some(name => !callbacks.includes(name) || name === 'onreadystatechange' || typeof details.upload[name] !== 'function'))) throw new Error('Use upload callbacks such as upload.onprogress.');
      if (jobs.size >= 4) throw new Error('At most four network requests per script instance.');
      if (downloading) { normalize('download', details); details = { ...details, responseType: 'blob' }; }
      const job = { id: String(++sequence), details: { ...details, ...(details.upload ? { upload: { ...details.upload } } : {}), ...(details.headers ? { headers: { ...details.headers } } : {}) }, sent: false };
      const result = modern ? new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; }) : {};
      result.abort = () => {
        if (!jobs.has(job.id)) return;
        event({ requestId: job.id, event: 'abort', readyState: 4, error: 'Request aborted.' });
        if (job.sent && ready && active()) void send(downloading ? 'abortDownload' : 'abortRequest', { requestId: job.id }).catch(report);
      };
      jobs.set(job.id, job); void dispatch(job); return result;
    }
    return { legacy: details => create(details, false), modern: details => create(details, true), event,
      ready: () => { ready = true; for (const job of jobs.values()) void dispatch(job); },
      disconnect: () => { ready = false; for (const job of [...jobs.values()]) event({ requestId: job.id, event: 'error', readyState: 4, error: 'Userscript connection closed; request was not retried.' }); } };
  }
  // Serialized into the selected world with a native runtime or page adapter.
  // Legacy reads hydrate from the isolated broker before source execution.
  function runUserScript(config, run, jsonValue, scriptRequests, safeMenuIcon, tabOptions, scriptActions, normalizeAction, runtimeOverride) {
    const grants = new Set(config.grants), has = name => grants.has('GM.' + name) || grants.has('GM_' + name);
    // Page-world configs carry neither the install ID nor the capability:
    // site code can read packets there, so the isolated page host adds both.
    const credentials = config.token ? { id: config.id, token: config.token } : {};
    let diagnostics = 0;
    const diagnostic = error => {
      // Only existing native messaging worlds participate. Capture is opt-in in
      // the background; error text is untrusted and the original error still runs.
      try {
        if ((!config.token && !runtimeOverride) || !config.grants.some(grant => /^GM[._]/.test(grant) && !/^GM[._](info|addStyle|addElement|getResourceText|getResourceURL|getResourceUrl)$/.test(grant)) || diagnostics++ >= 10) return;
        const native = runtimeOverride || (globalThis.browser || globalThis.chrome)?.runtime;
        if (typeof native?.sendMessage !== 'function') return;
        void Promise.resolve(native.sendMessage({ type: 'US_VALUE', operation: 'diagnostic', ...credentials,
          message: String(error?.message ?? error).slice(0, 2048), stack: typeof error?.stack === 'string' ? error.stack.slice(0, 8192) : '' })).catch(() => {});
      } catch { /* Diagnostics must never change script error behavior. */ }
    };
    const report = error => { console.error('[Module Engine userscript]', error); diagnostic(error); };
    const copy = value => value === undefined ? undefined : jsonValue(value);
    const key = value => { if (typeof value !== 'string' || !value || value.length > 256) throw new Error('Use a nonempty storage key of at most 256 characters.'); return value; };
    const keys = value => { if (!Array.isArray(value) || value.length > 256) throw new Error('Use an array of up to 256 storage keys.'); return [...new Set(value.map(key))]; };
    const store = value => {
      const result = jsonValue(value);
      if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Use a plain object of storage values.');
      keys(Object.keys(result));
      if (new TextEncoder().encode(JSON.stringify(result)).length > 65536) throw new Error('Each script can store up to 256 keys and 64 KiB of JSON values.');
      return result;
    };
    const storage = config.grants.some(grant => /^GM[._](?:getValue|getValues|setValue|setValues|deleteValue|deleteValues|listValues|addValue|removeValue)/.test(grant));
    const network = has('xmlhttpRequest') || grants.has('GM.xmlHttpRequest');
    const cacheRequired = config.grants.some(grant => /^GM_(?:getValue|getValues|listValues)$/.test(grant)) || has('addValueChangeListener');
    const desktop = has('setClipboard') || has('notification') || has('download');
    const readyRequired = cacheRequired || has('cookie');
    const channelRequired = readyRequired || has('registerMenuCommand') || has('unregisterMenuCommand') || network || has('openInTab') || desktop;
    const runtime = storage || channelRequired ? runtimeOverride || (globalThis.browser || globalThis.chrome)?.runtime : null;
    if ((storage || channelRequired) && typeof runtime?.sendMessage !== 'function' || channelRequired && typeof runtime?.connect !== 'function') {
      report(new Error('Native userscript messaging is unavailable. Chrome/Edge allow 10 isolated script worlds per document. Reduce overlapping scopes or enable browser access, then reload.'));
      return;
    }
    let baseline = {}, cache = {}, revision = -1, authoritativeRemote = false, tail = Promise.resolve(), connectionId, port;
    let stopped = false, suspended = false, started = false, generation = 0, observer, channelTimer, retryTimer, retry = 0, nextListener = 0;
    const pending = [], listeners = new Map(), menus = new Map();
    const send = async (operation, args = {}, epoch = generation) => {
      if (stopped || suspended || epoch !== generation) throw new Error('This userscript is inactive. Reload the page.');
      const response = await runtime.sendMessage({ type: 'US_VALUE', ...credentials,
        operation, ...args, ...(connectionId ? { connectionId } : {}) });
      if (!response?.ok) throw new Error(response?.error || 'Module Engine script API unavailable.');
      const completionOnly = /^(set|delete)(Many)?$/.test(operation) || operation === 'cookie' && ['set', 'delete'].includes(args.method);
      if (!completionOnly && (stopped || suspended || epoch !== generation)) throw new Error('This userscript is inactive after navigation. Reload the page.');
      return response;
    };
    const requests = network ? scriptRequests(send, () => !stopped && !suspended, report) : null;
    const downloads = has('download') ? scriptRequests(send, () => !stopped && !suspended, report, true, normalizeAction) : null;
    const actions = desktop ? scriptActions(send, () => !stopped && !suspended, report, normalizeAction) : null;
    const tabHandles = new Map(), elementWatches = new Set();
    const clearElements = () => { for (const watch of elementWatches) watch.disconnect(); elementWatches.clear(); };
    let nextTab = 0, tabsReady = false;
    const tabClosed = id => {
      const job = tabHandles.get(id); if (!job) return;
      tabHandles.delete(id); job.closed = true;
      try { job.callback?.(); } catch (error) { report(error); }
    };
    const disconnectTabs = () => {
      tabsReady = false;
      for (const job of tabHandles.values()) {
        job.available = false;
        if (!job.sent) job.closed = true;
      }
      // An existing tab can remain open. Do not report a fabricated close event
      // or replay an accepted opening when the native worker reconnects.
      tabHandles.clear();
    };
    const closeTab = job => {
      if (job.closed) return;
      if (!job.available || stopped || suspended) throw new Error('This tab handle is no longer connected.');
      if (job.closing) return;
      job.closeRequested = true;
      if (!job.opened) return;
      job.closing = true;
      void send('closeTab', { tabHandle: job.id }).catch(error => { job.closing = false; report(error); });
    };
    const dispatchTab = job => {
      if (!tabsReady || job.sent || !job.available) return;
      job.sent = true;
      void send('openTab', { tabHandle: job.id, details: job.details }).catch(error => {
        if (tabHandles.get(job.id) !== job) return;
        tabHandles.delete(job.id); job.closed = true; job.available = false; report(error);
      });
    };
    const tabEvent = message => {
      const job = tabHandles.get(message.tabHandle); if (!job) return;
      if (message.event === 'closed') tabClosed(job.id);
      else if (message.event === 'opened') { job.opened = true; if (job.closeRequested) closeTab(job); }
      else if (message.event === 'close-error') { job.closing = false; report(new Error(message.error)); }
      else if (message.event === 'unavailable') {
        tabHandles.delete(job.id); job.available = false; report(new Error(message.error));
      }
      else if (message.event === 'error') {
        tabHandles.delete(job.id); job.closed = true; job.available = false;
        report(new Error(message.error));
      }
    };
    const resourceURLs = new Map();
    const resource = name => {
      const value = config.resources.find(item => item.name === String(name));
      if (!value) throw new Error('Unknown @resource: ' + name);
      return { bytes: Uint8Array.from(atob(value.body), character => character.charCodeAt(0)), mime: value.mime };
    };
    const overlay = (values, patch) => {
      const result = new Map(Object.entries(values));
      for (const name of patch.remove || []) result.delete(name);
      for (const [name, value] of Object.entries(patch.put || {})) result.set(name, value);
      return Object.fromEntries(result);
    };
    function refresh(remote) {
      if (!cacheRequired) return;
      const previous = cache;
      cache = pending.reduce((values, item) => item.generation === generation ? overlay(values, item.patch) : values, baseline);
      if (stopped || suspended) return;
      const current = cache;
      for (const [id, item] of [...listeners]) {
        if (!listeners.has(id) || JSON.stringify(previous[item.key]) === JSON.stringify(current[item.key]) &&
            Object.hasOwn(previous, item.key) === Object.hasOwn(current, item.key)) continue;
        try { item.callback(item.key, Object.hasOwn(previous, item.key) ? copy(previous[item.key]) : undefined,
          Object.hasOwn(current, item.key) ? copy(current[item.key]) : undefined, remote); } catch (error) { report(error); }
      }
    }
    function snapshot(message, remote = true) {
      if (!cacheRequired) return;
      if (!Number.isSafeInteger(message.revision) || message.revision <= revision) return;
      if (message.values) baseline = store(message.values);
      else if (message.keys) baseline = Object.fromEntries(keys(message.keys).map(name => [name, null]));
      else return;
      revision = message.revision; authoritativeRemote = remote; refresh(remote);
    }
    function write(operation, args, patch) {
      if (stopped || suspended) throw new Error('This userscript is inactive. Reload the page.');
      if (pending.length >= 64) throw new Error('Too many pending GM storage writes.');
      store(cacheRequired ? overlay(cache, patch) : patch.put || {});
      const item = { patch, generation }; pending.push(item);
      let committed = false;
      const work = tail.then(() => send(operation, args, item.generation)).then(response => {
        committed = true;
        if (stopped || suspended || item.generation !== generation) return;
        // A newer remote snapshot may have arrived while this write awaited its
        // reply. Never replace it with the older acknowledgement.
        if (cacheRequired && !response.values && !response.keys && response.revision > revision) {
          baseline = overlay(baseline, patch); revision = response.revision;
        }
        snapshot(response, false);
      });
      const settled = work.finally(() => { pending.splice(pending.indexOf(item), 1); refresh(committed && authoritativeRemote); });
      tail = settled.catch(() => {});
      // Establish ordering before callbacks can make a reentrant write.
      refresh(false);
      return settled;
    }
    const queryKeys = query => {
      if (Array.isArray(query)) return keys(query);
      if (!query || typeof query !== 'object' || !(Object.getPrototypeOf(query) === null || Object.getPrototypeOf(Object.getPrototypeOf(query)) === null)) throw new Error('Use an array of keys or a plain object of default values.');
      return keys(Object.keys(query));
    };
    const pick = (values, query) => {
      if (query === undefined) return copy(values);
      if (Array.isArray(query)) return Object.fromEntries(keys(query).filter(name => Object.hasOwn(values, name)).map(name => [name, copy(values[name])]));
      return Object.fromEntries(queryKeys(query).map(name => [name, Object.hasOwn(values, name) ? copy(values[name]) : query[name]]));
    };
    const local = {
      getResourceText: name => new TextDecoder().decode(resource(name).bytes),
      getResourceURL: name => {
        name = String(name);
        if (!resourceURLs.has(name)) { const item = resource(name); resourceURLs.set(name, URL.createObjectURL(new Blob([item.bytes], { type: item.mime }))); }
        return resourceURLs.get(name);
      },
      getValue: (name, fallback) => Object.hasOwn(cache, key(name)) ? copy(cache[name]) : fallback,
      getValues: query => pick(cache, query), listValues: () => Object.keys(cache),
      setValue: (name, value) => { name = key(name); value = copy(value); return write('set', { key: name, value }, { put: { [name]: value } }); },
      setValues: values => { values = store(values); return write('setMany', { values }, { put: values }); },
      deleteValue: name => { name = key(name); return write('delete', { key: name }, { remove: [name] }); },
      deleteValues: names => { names = keys(names); return write('deleteMany', { keys: names }, { remove: names }); },
      addValueChangeListener: (name, callback) => {
        key(name); if (typeof callback !== 'function' || listeners.size >= 256) throw new Error('Use a callback; at most 256 value listeners per script instance.');
        const id = ++nextListener; listeners.set(id, { key: name, callback }); return id;
      },
      removeValueChangeListener: id => { listeners.delete(id); },
      addElement: (...args) => {
        if (stopped || suspended) throw new Error('This userscript is inactive. Reload the page.');
        const explicit = typeof args[0] !== 'string';
        const [parent, tag, attributes = {}] = explicit ? args : [null, ...args];
        if (typeof tag !== 'string' || !attributes || typeof attributes !== 'object' || Array.isArray(attributes) ||
            explicit && (!parent || ![1, 11].includes(parent.nodeType))) throw new TypeError('Use a tag name, optional parent element or shadow root, and an attributes object.');
        const element = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) {
          if (typeof value !== 'string') throw new TypeError('Element attribute values must be strings.');
          if (name === 'textContent') element.textContent = value;
          else element.setAttribute(name, value);
        }
        const attach = () => {
          if (element.parentNode) return true;
          const target = explicit ? parent : /^(script|style|link|meta)$/i.test(tag) ? document.head || document.documentElement : document.body || document.documentElement;
          if (!target) return false;
          Node.prototype.appendChild.call(target, element); return true;
        };
        if (!attach()) {
          if (elementWatches.size >= 64) throw new Error('Too many elements waiting for the document root.');
          const watch = new MutationObserver(() => { if (attach()) { watch.disconnect(); elementWatches.delete(watch); } });
          elementWatches.add(watch); watch.observe(document, { childList: true, subtree: true });
        }
        element.then = callback => { delete element.then; return Promise.resolve(callback ? callback(element) : element); };
        return element;
      },
      openInTab: (url, options) => {
        if (stopped || suspended) throw new Error('This userscript is inactive. Reload the page.');
        const details = tabOptions(url, options, location.href);
        if (tabHandles.size >= 8) throw new Error('At most eight connected tab handles per script instance.');
        const job = { id: String(++nextTab), details, closed: false, available: true, sent: false };
        tabHandles.set(job.id, job);
        const control = Object.freeze({ get closed() { return job.closed; }, close: () => closeTab(job),
          get onclose() { return job.callback; }, set onclose(value) {
            if (value !== undefined && typeof value !== 'function') throw new TypeError('onclose must be a function or undefined.');
            job.callback = value;
          } });
        dispatchTab(job); return control;
      }
    };
    local.addStyle = css => local.addElement('style', { textContent: String(css) });
    if (actions) { local.setClipboard = actions.clipboard; local.notification = actions.notification; }
    const asynchronous = {
      getValue: async (name, fallback) => { key(name); await tail; const r = await send('get', { key: name }); return r.exists ? r.value : fallback; },
      getValues: async query => { const names = query === undefined ? undefined : queryKeys(query); await tail; return pick((await send('getMany', { ...(names === undefined ? {} : { query: names }) })).values, query); },
      listValues: async () => { await tail; return (await send('list')).keys; }
    };
    let menuScheduled = false, menuSending = false, menuDirty = false;
    const publishMenus = () => {
      if (!has('registerMenuCommand') && !has('unregisterMenuCommand')) return;
      menuDirty = true;
      if (menuScheduled || menuSending || !connectionId || stopped || suspended) return;
      menuScheduled = true;
      queueMicrotask(() => {
        menuScheduled = false;
        if (!connectionId || stopped || suspended) return;
        menuDirty = false; menuSending = true;
        void send('menus', { menus: [...menus.values()].map(({ callback, ...item }) => item) }).catch(report).finally(() => {
          menuSending = false;
          if (menuDirty) publishMenus();
        });
      });
    };
    local.registerMenuCommand = (caption, callback, options = {}) => {
      if (typeof options === 'string') options = { accessKey: options };
      if (!options || typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).some(name => !['id', 'accessKey', 'autoClose', 'title', 'icon'].includes(name))) throw new Error('Unsupported menu options.');
      const id = String(options.id ?? caption);
      if (typeof caption !== 'string' || !caption.trim() || caption.length > 256 || !id || id.length > 128 ||
          typeof callback !== 'function' || options.title !== undefined && (typeof options.title !== 'string' || options.title.length > 512) ||
          options.accessKey !== undefined && (typeof options.accessKey !== 'string' || options.accessKey.length > 1) ||
          options.autoClose !== undefined && typeof options.autoClose !== 'boolean') throw new Error('Invalid menu command.');
      if (!menus.has(id) && menus.size >= 32) throw new Error('At most 32 menu commands per script instance.');
      menus.set(id, { id, caption, callback, title: options.title || '', accessKey: options.accessKey || '', autoClose: options.autoClose !== false, icon: safeMenuIcon(options.icon) });
      publishMenus(); return id;
    };
    local.unregisterMenuCommand = id => { menus.delete(String(id)); publishMenus(); };
    const api = { GM: { info: Object.freeze(config.info) }, GM_info: Object.freeze(config.info) };
    for (const name of Object.keys(local)) {
      if (grants.has('GM.' + name)) api.GM[name] = asynchronous[name] || (/^(set|delete|getResource)/.test(name) ? async (...args) => local[name](...args) : local[name]);
      if (grants.has('GM_' + name)) api['GM_' + name] = /^(set|delete)/.test(name)
        ? (...args) => { void local[name](...args).catch(report); } : local[name];
    }
    if (grants.has('GM.getResourceUrl')) api.GM.getResourceUrl = async name => local.getResourceURL(name);
    if (grants.has('GM_xmlhttpRequest')) api.GM_xmlhttpRequest = requests.legacy;
    if (grants.has('GM.xmlhttpRequest')) api.GM.xmlhttpRequest = requests.modern;
    if (grants.has('GM.xmlHttpRequest')) api.GM.xmlHttpRequest = requests.modern;
    if (grants.has('GM_download')) api.GM_download = (details, name) => downloads.legacy(typeof details === 'string' ? { url: details, name } : details);
    if (grants.has('GM.download')) api.GM.download = (details, name) => downloads.modern(typeof details === 'string' ? { url: details, name } : details);
    if (has('cookie')) {
      const cookie = Object.freeze(Object.fromEntries(['list', 'set', 'delete'].map(method => [method, (details = {}, callback) => {
        if (callback !== undefined && typeof callback !== 'function') throw new TypeError('Cookie callback must be a function.');
        const epoch = generation;
        const result = Promise.resolve().then(() => send('cookie', { method, details: copy(details) }, epoch)).then(response => {
          if (method === 'list' && (stopped || suspended)) throw new Error('This userscript is inactive. Reload the page.');
          return method === 'list' ? response.cookies : undefined;
        });
        if (callback === undefined) return result;
        void result.then(value => method === 'list' ? callback(value, undefined) : callback(undefined),
          error => method === 'list' ? callback(undefined, error.message) : callback(error.message)).catch(report);
      }])));
      if (grants.has('GM_cookie')) api.GM_cookie = cookie;
      if (grants.has('GM.cookie')) api.GM.cookie = cookie;
    }
    Object.freeze(api.GM);
    function start() {
      if (started || stopped || suspended) return;
      if (config.runAt === 'document_body' && !document.body) {
        if (!observer) { observer = new MutationObserver(start); observer.observe(document, { childList: true, subtree: true }); }
        return;
      }
      observer?.disconnect(); started = true;
      // Let normal browser error reporting show the original userscript stack.
      let result;
      try { result = run.call(globalThis, api); }
      catch (error) { diagnostic(error); throw error; }
      if (config.topLevelAwait) void result.catch(report);
    }
    function disconnectChannel() {
      // disconnect() does not deliver onDisconnect to its own native Port.
      // Clear local ownership/timers before closing so stale events are ignored.
      const current = port; port = null; connectionId = undefined;
      clearTimeout(channelTimer); channelTimer = undefined;
      current?.disconnect();
    }
    function stop(error) {
      stopped = true;
      clearTimeout(retryTimer); retryTimer = undefined;
      observer?.disconnect(); observer = undefined;
      clearElements(); disconnectTabs(); requests?.disconnect(); downloads?.disconnect(); actions?.disconnect();
      disconnectChannel(); report(error);
    }
    function connect() {
      if (stopped || suspended || port) return;
      let current;
      // The page adapter ignores a name; its host names the native port.
      try { current = config.token ? runtime.connect({ name: 'US_CHANNEL:' + config.id + ':' + config.token }) : runtime.connect(); }
      catch (error) { stop(error); return; }
      port = current;
      let ready = false;
      channelTimer = setTimeout(() => {
        if (port === current && !ready && !stopped && !suspended) stop(new Error('Userscript channel timed out. Reload the page.'));
      }, 10000);
      current.onMessage.addListener(message => {
        if (port !== current || stopped || suspended) return;
        if (message.type === 'ready') {
          clearTimeout(channelTimer); channelTimer = undefined; ready = true; retry = 0; connectionId = message.connectionId; snapshot(message);
          publishMenus(); requests?.ready(); downloads?.ready(); actions?.ready(); tabsReady = true;
          for (const job of tabHandles.values()) dispatchTab(job);
          if (readyRequired) start();
        } else if (message.type === 'values') snapshot(message, message.origin !== connectionId);
        else if (message.type === 'request') requests?.event(message);
        else if (message.type === 'download') downloads?.event(message);
        else if (message.type === 'action') actions?.event(message);
        else if (message.type === 'tab') tabEvent(message);
        else if (message.type === 'menu') {
          const item = menus.get(message.id);
          if (item) { try { item.callback(new MouseEvent('click', message.event || {})); } catch (error) { report(error); } }
        } else if (message.type === 'revoked') {
          stop(new Error(message.error));
        }
      });
      current.onDisconnect.addListener(() => {
        void runtime.lastError;
        if (port !== current) return;
        clearTimeout(channelTimer); channelTimer = undefined;
        port = null; connectionId = undefined;
        requests?.disconnect();
        downloads?.disconnect(); actions?.disconnect();
        disconnectTabs();
        if (!stopped && !suspended) {
          // Native ports disconnect when an MV3 worker restarts. Bound retries
          // so a denied browser capability cannot cause a reconnect storm.
          if (retry < 3) retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, 250 * 2 ** retry++);
          else stop(new Error('Userscript connection lost. Reload the page.'));
        }
      });
    }
    if (storage || channelRequired || config.runAt === 'document_body' || config.resources.length || has('addElement') || has('addStyle')) {
      addEventListener('pagehide', event => {
        if (!event.isTrusted || suspended) return;
        suspended = true; generation++; clearTimeout(retryTimer); retryTimer = undefined; observer?.disconnect(); observer = undefined; requests?.disconnect(); downloads?.disconnect(); actions?.disconnect(); disconnectTabs(); disconnectChannel();
        refresh(false);
        clearElements();
        if (!event.persisted) { stopped = true; for (const url of resourceURLs.values()) URL.revokeObjectURL(url); resourceURLs.clear(); } });
      addEventListener('pageshow', event => { if (event.isTrusted && event.persisted && suspended && !stopped) { suspended = false; retry = 0; if (channelRequired) connect(); else start(); } });
    }
    if (channelRequired) connect();
    if (!readyRequired) start();
  }
  function bindings(metadata) {
    return (metadata.world === 'MAIN' && !metadata.pageBridge ? '' : 'const {' + ['GM', ...METHODS.map(name => 'GM_' + name)].join(',') + '}=__api;\n') +
      (metadata.grants.includes('unsafeWindow') ? 'const unsafeWindow=globalThis;\n' : '');
  }
  const nativeWorld = metadata => metadata.pageBridge ? 'USER_SCRIPT' : metadata.world;
  // Older auto scripts ran isolated. Only an individual enable action opts a
  // saved script into the new page-first behavior; startup must not widen access.
  function executionMetadata(script) {
    const metadata = parse(script.source);
    return metadata.injection === 'auto' && !script.autoPageApproved
      ? { ...metadata, world: 'USER_SCRIPT', pageBridge: false } : metadata;
  }
  function registration(script, order) {
    const metadata = executionMetadata(script), id = nativeId(script.id, order);
    const assets = validateAssets(script.assets, metadata);
    if (assetSpecs(metadata).length && !assets) fail('Prepare and review this script’s dependencies before enabling it.');
    const info = { script: { name: metadata.name, namespace: metadata.namespace, version: metadata.version,
      description: metadata.description, matches: metadata.matches, excludes: metadata.excludes, includes: metadata.includes,
      excludeMatches: metadata.excludeMatches, grant: metadata.grants, grants: metadata.grants, runAt: metadata.runAt.replace('_', '-'),
      require: metadata.requires, resources: metadata.resources, connect: metadata.connects, tags: metadata.tags,
      unwrap: metadata.unwrap, topLevelAwait: metadata.topLevelAwait, ...metadata.informational },
      uuid: script.id, injectInto: metadata.world === 'MAIN' ? 'page' : 'content', scriptMetaStr: metadata.metaStr,
      scriptWillUpdate: false, scriptHandler: 'Module Engine', version: '1.9.0',
      scriptSource: script.source };
    // Site code can read page-world runtime data, so page-world GM_info gets
    // the identity-derived pageUUID. Content worlds keep the install ID.
    const pageInfo = { ...info, uuid: pageUUID(metadata) };
    const dependencies = (assets || []).filter(asset => asset.kind === 'require').map(asset => new TextDecoder().decode(decodeAsset(asset.body)) + '\n;');
    const lines = metadata.unwrap ? [...dependencies, script.source] : ['(function () {', "'use strict';"];
    // Native userScripts combine match patterns OR include globs (unlike content
    // scripts). Coarse native globs avoid spending worlds on unrelated pages;
    // this bounded guard and the broker enforce exact URL/fragment semantics.
    if (!metadata.unwrap) {
      lines.push(matching.guard(metadata));
      // Only isolated worlds hold the install ID and capability. Native MAIN
      // scripts never message the broker, and the page bridge strips both below.
      const config = { ...(nativeWorld(metadata) === 'USER_SCRIPT' ? { id: script.id, token: script.token } : {}),
        grants: metadata.grants, info: metadata.world === 'MAIN' ? pageInfo : info, runAt: metadata.runAt, topLevelAwait: metadata.topLevelAwait,
        resources: (assets || []).filter(asset => asset.kind === 'resource') };
      const invoke = (options, runtime = '') => ['(' + runUserScript.toString() + ')(' + JSON.stringify(options) + ',' + (metadata.topLevelAwait ? 'async ' : '') + 'function(__api){',
        bindings(metadata), ...dependencies, script.source, '\n},' + jsonValue.toString() + ',' + scriptRequests.toString() + ',' + safeMenuIcon.toString() + ',' + tabOptions.toString() +
        ',' + BlockAdsUserScriptActions.client.toString() + ',' + BlockAdsUserScriptActions.normalize.toString() + (runtime ? ',' + runtime : '') + ');'].join('\n');
      if (metadata.pageBridge) {
        // pageRun becomes the text of an inline page script, which site code can
        // read (document.currentScript) while it runs. It holds no install ID.
        const { id: _identity, token: _private, ...pageConfig } = config, page = BlockAdsUserScriptPage;
        // Explicit page mode never falls back; avoid bundling a second copy of
        // its source, dependencies and GM runtime into the native registration.
        const fallback = metadata.injection === 'auto' ? invoke({ ...config, info: { ...info, injectInto: 'content' } }) : '';
        lines.push('(' + page.host.toString() + ')(' + JSON.stringify({ id: script.id, token: script.token, mode: metadata.injection, event: startEvent(metadata), sourceName: sourceName(metadata) }) +
          ',function(runtime){"use strict";\n' + invoke(pageConfig, 'runtime') + '\n},' + JSON.stringify(page.client.toString()) + ',function(){\n' +
          fallback + '\n});');
      } else lines.push(invoke(config));
      lines.push('})();');
    }
    // Raw code that needs an exact scope check declares the guard's sentinel.
    const sentinel = rawSentinel(metadata);
    if (sentinel) lines.push(';let ' + sentinel + ';');
    lines.push('//# sourceURL=' + sourceName(metadata));
    // Chrome still requires a nonempty matches array even for include-only
    // scripts. A reserved .invalid URL satisfies its schema without broadening
    // registration to every page; the exact guard never grants it extra scope.
    return { id: id + (metadata.pageBridge ? '-1' : ''), ...matching.prefilter(metadata), runAt: metadata.runAt === 'document_body' ? 'document_start' : metadata.runAt,
      allFrames: metadata.allFrames, world: nativeWorld(metadata),
      ...(nativeWorld(metadata) === 'USER_SCRIPT' ? { worldId: nativeId(script.id) } : {}),
      js: [...(sentinel && !earlyGuard(metadata) ? [{ code: matching.rawGuard(metadata, sentinel, false) }] : []), { code: lines.join('\n') }] };
  }
  function rawSentinel(metadata) {
    if (!metadata.unwrap || matching.exact(metadata)) return '';
    // Page code can list this global on excluded pages. Like sourceName, it
    // hashes the identity: the install ID is unique to every user, and a source
    // hash is unique to a user who customized the script.
    return '__moduleEngineScope_' + identityHash(metadata);
  }
  // A 64-bit hash of @name and @namespace, which are unique in the library and
  // the same for every user of a script. Page-visible names use it.
  const identityHash = metadata => digest(metadata.name + '\n' + metadata.namespace);
  // A deterministic 64-bit text fingerprint for names, not a security hash.
  function digest(text) {
    let first = 0x811c9dc5, second = 0x9747b28c;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      first = Math.imul(first ^ code, 0x01000193); second = Math.imul(second ^ code, 0x5bd1e995) ^ second >>> 15;
    }
    return [first, second].map(value => (value >>> 0).toString(16).padStart(8, '0')).join('');
  }
  // The //# sourceURL name. Page code reads it in stack traces whenever a
  // page-world frame is on the stack, so it must not carry the install ID.
  // It derives from @name and @namespace only: every user of a script shares
  // it, it is stable across edits (DevTools breakpoints keep working), and
  // the hash separates scripts whose truncated names match. The slug keeps
  // letters, marks, digits, _ and - only, so it cannot end the comment.
  function sourceName(metadata) {
    const slug = Array.from(metadata.name.replace(/[^\p{L}\p{M}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')).slice(0, 64).join('');
    return 'blockads-userscript-' + (slug || 'script') + '.' + identityHash(metadata) + '.user.js';
  }
  // The event that tells this script's MAIN bootstrap to run its page script.
  // Page code running during that script sees it as window.event, so it uses
  // the identity hash rather than the install ID.
  const startEvent = metadata => 'me-page-start-' + identityHash(metadata);
  // GM_info.uuid in the page world: a UUID-shaped (RFC 9562 version 8) hash of
  // @name and @namespace. Like the names above, every user of a script shares
  // it and it is stable across sites, edits and reinstalls. Unlike the install
  // ID, it is not unique per installation.
  function pageUUID(metadata) {
    const text = metadata.name + '\n' + metadata.namespace, hex = digest('GM_info.uuid\n' + text) + digest(text + '\nGM_info.uuid');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(13, 16) + '-' + (8 | parseInt(hex[16], 16) & 3).toString(16) + hex.slice(17, 20) + '-' + hex.slice(20);
  }
  // Page listeners registered before a later run-at would see the skipped
  // script's error event. A separate document-start guard listens first.
  const earlyGuard = metadata => metadata.world === 'MAIN' && metadata.runAt !== 'document_start';
  function registrations(script, order) {
    const metadata = executionMetadata(script), runner = registration(script, order), sentinel = rawSentinel(metadata);
    if (sentinel && earlyGuard(metadata)) return [{ id: nativeId(script.id, order) + '-0', ...matching.prefilter(metadata), runAt: 'document_start',
      allFrames: metadata.allFrames, world: 'MAIN', js: [{ code: matching.rawGuard(metadata, sentinel, true) }] }, runner];
    if (!metadata.pageBridge) return [runner];
    return [{ id: nativeId(script.id, order) + '-0', ...matching.prefilter(metadata), runAt: 'document_start', allFrames: metadata.allFrames, world: 'MAIN',
      js: [{ code: '(' + BlockAdsUserScriptPage.bootstrap.toString() + ')(' + JSON.stringify(startEvent(metadata)) + ');' }] }, runner];
  }
  function tabOptions(value, options = {}, base) {
    if (typeof value !== 'string' || !value || value.length > 4096) throw new TypeError('Use an HTTP(S) tab URL of at most 4096 characters.');
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096) throw new Error('Tab URLs require HTTP(S), without embedded credentials.');
    if (typeof options === 'boolean') options = { active: !options };
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['active', 'insert', 'pinned', 'container'].includes(key) ||
      options[key] !== undefined && (key === 'container' ? !Number.isSafeInteger(options[key]) || options[key] < 0 || options[key] > 2147483647 : typeof options[key] !== 'boolean')))
      throw new TypeError('Tab options support active, insert and pinned booleans and a nonnegative integer container.');
    // container is a Firefox userContextId: 0 is the default container.
    return { url: url.href, active: options.active !== false, insert: options.insert !== false, pinned: options.pinned === true,
      ...(options.container !== undefined ? { container: options.container } : {}) };
  }
  globalThis.BlockAdsUserScriptCore = Object.freeze({ LIMITS, GRANTS, METADATA, bytes, parse, allows, jsonValue, tabOptions,
    validateValues, library, nativeId, nativeWorld, registration, registrations, assetSpecs, validateAssets, decodeAsset, safeMenuIcon,
    sourceURL, compareVersions, sourceReview, tags, bindings });
})();
