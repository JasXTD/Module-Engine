/* Local userscript format and registration compiler. Never evaluates script code. */
(() => {
  'use strict';
  const LIMITS = Object.freeze({ scripts: 32, source: 128 * 1024, sources: 1024 * 1024, values: 64 * 1024, library: 3 * 1024 * 1024 });
  const GRANTS = Object.freeze(['none', 'GM.info', 'GM_info', 'GM.addStyle', 'GM_addStyle',
    'GM.getValue', 'GM.setValue', 'GM.deleteValue', 'GM.listValues']);
  const SINGLE = new Set(['name', 'namespace', 'version', 'description', 'run-at', 'inject-into', 'noframes']);
  const INFORMATIONAL = new Set(['author', 'license', 'homepage', 'homepageURL', 'supportURL', 'icon', 'icon64', 'downloadURL', 'updateURL']);
  const bytes = text => new TextEncoder().encode(text).length;
  const fail = message => { throw new Error(message); };
  const unique = values => [...new Set(values)];
  function patterns(value) {
    if (value === '<all_urls>') return ['http://*/*', 'https://*/*'];
    const match = /^(\*|https?):\/\/([^/]+)(\/[^\s#]*)$/.exec(value);
    if (!match || value.length > 2048) fail('Use an HTTP(S) @match pattern, for example https://example.com/*.');
    const [, scheme, rawHost, pathname] = match, host = rawHost.toLowerCase();
    const bare = host.startsWith('*.') ? host.slice(2) : host;
    if (host !== '*' && (!/^[a-z0-9.-]+$/.test(bare) || bare.length > 253 ||
        bare.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)))) {
      fail('Invalid @match host. Ports, credentials and partial host wildcards are not supported.');
    }
    return [scheme + '://' + host + pathname];
  }
  function parse(source) {
    if (typeof source !== 'string' || !source.trim() || bytes(source) > LIMITS.source) fail('A script must contain at most 128 KiB of UTF-8 source.');
    const header = /^\uFEFF?\s*\/\/\s*==UserScript==[ \t]*\r?\n([\s\S]*?)^\s*\/\/\s*==\/UserScript==[ \t]*(?:\r?\n|$)/m.exec(source);
    if (!header || source.slice(0, header.index).trim() || header[1].length > 16384) fail('Start the file with a // ==UserScript== metadata block and close it with // ==/UserScript==.');
    const entries = Object.create(null), warnings = [];
    for (const line of header[1].split(/\r?\n/)) {
      if (/^\s*(?:\/\/\s*)?$/.test(line)) continue;
      const entry = /^\s*\/\/\s*@([\w:-]+)(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
      if (!entry) fail('Metadata lines must use // @key value.');
      const [, key, raw = ''] = entry, value = raw.trim();
      if (INFORMATIONAL.has(key) || /^(name|description):[\w-]+$/.test(key)) {
        if (['icon', 'icon64', 'downloadURL', 'updateURL'].includes(key)) warnings.push('@' + key + ' is ignored; Module Engine does not download script assets or updates.');
        continue;
      }
      if (!SINGLE.has(key) && !['match', 'exclude-match', 'grant'].includes(key)) fail('Unsupported metadata @' + key + '. See Supported userscript features.');
      if (SINGLE.has(key) && entries[key]) fail('Use only one @' + key + ' entry.');
      if (key !== 'noframes' && (!value || value.length > 2048)) fail('Missing or oversized @' + key + ' value.');
      if (key === 'noframes' && value) fail('@noframes takes no value.');
      (entries[key] ||= []).push(value);
    }
    const one = (key, fallback = '') => entries[key]?.[0] ?? fallback;
    const name = one('name'), namespace = one('namespace', 'local.blockads');
    if (!name || name.length > 160 || namespace.length > 512) fail('Provide @name (up to 160 characters) and an optional @namespace (up to 512).');
    const matches = unique((entries.match || []).flatMap(patterns));
    const excludeMatches = unique((entries['exclude-match'] || []).flatMap(patterns));
    if (!matches.length || matches.length > 64 || excludeMatches.length > 64) fail('Provide 1–64 @match patterns and at most 64 @exclude-match patterns.');
    const runAt = one('run-at', 'document-idle').replace('-', '_');
    if (!['document_start', 'document_end', 'document_idle'].includes(runAt)) fail('@run-at must be document-start, document-end or document-idle.');
    const grants = unique(entries.grant || ['none']);
    for (const grant of grants) if (!GRANTS.includes(grant)) fail('Unsupported grant ' + grant + '. Use only the APIs listed under Supported userscript features.');
    if (grants.includes('none') && grants.length !== 1) fail('@grant none cannot be combined with other grants.');
    const injection = one('inject-into', 'content');
    if (!['content', 'page', 'auto'].includes(injection)) fail('@inject-into must be content, page or auto.');
    if (injection === 'page' && (grants.length !== 1 || grants[0] !== 'none')) fail('Page-world scripts require @grant none; privileged helpers stay isolated.');
    return { name, namespace, version: one('version', '1.0'), description: one('description'),
      matches, excludeMatches, grants, runAt, allFrames: !entries.noframes,
      world: injection === 'page' ? 'MAIN' : 'USER_SCRIPT', warnings: unique(warnings) };
  }
  function matchesURL(pattern, value) {
    let url; try { url = new URL(value); } catch { return false; }
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const [, scheme, host, pathname] = /^(\*|https?):\/\/([^/]+)(\/.*)$/.exec(pattern);
    if (scheme !== '*' && url.protocol !== scheme + ':') return false;
    const target = url.hostname.toLowerCase();
    if (host !== '*' && host !== target && !(host.startsWith('*.') && (target === host.slice(2) || target.endsWith('.' + host.slice(2))))) return false;
    // Literal segments avoid exponential regex backtracking on wildcard-heavy
    // paths. The broker shares a worker with the ad-blocking module.
    const valuePath = url.pathname + url.search, parts = pathname.split('*');
    if (parts.length === 1) return valuePath === pathname;
    if (!valuePath.startsWith(parts[0])) return false;
    let position = parts[0].length;
    for (const part of parts.slice(1, -1)) {
      const found = valuePath.indexOf(part, position);
      if (found < 0) return false;
      position = found + part.length;
    }
    const tail = parts.at(-1);
    return valuePath.length >= position + tail.length && valuePath.endsWith(tail);
  }
  const allows = (metadata, url) => metadata.matches.some(pattern => matchesURL(pattern, url)) &&
    !metadata.excludeMatches.some(pattern => matchesURL(pattern, url));
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
        token: script.token, values: validateValues(script.values) };
    });
    const result = { schemaVersion: 1, revision: raw.revision, enabled: raw.enabled, scripts };
    if (total > LIMITS.sources || bytes(JSON.stringify(result)) > LIMITS.library) fail('The script library exceeds its local storage budget (1 MiB of source, 3 MiB total).');
    return result;
  }
  const nativeId = id => 'blockads-user-' + id;
  function registration(script) {
    const metadata = parse(script.source), id = nativeId(script.id);
    const info = { script: { name: metadata.name, namespace: metadata.namespace, version: metadata.version,
      description: metadata.description, matches: metadata.matches, excludes: metadata.excludeMatches, grants: metadata.grants },
      scriptHandler: 'Module Engine', version: '1.9.0' };
    const lines = ['(function () {', "'use strict';"];
    if (metadata.world === 'USER_SCRIPT') {
      if (metadata.grants.some(grant => /^GM\.(getValue|setValue|deleteValue|listValues)$/.test(grant))) lines.push(
        'const __baRuntime = (globalThis.browser || globalThis.chrome).runtime;',
        'const __baJSON = ' + jsonValue.toString() + ';',
        'const __baSend = (operation, args = {}) => __baRuntime.sendMessage({type:"US_VALUE",id:' + JSON.stringify(script.id) + ',token:' + JSON.stringify(script.token) + ',operation,...args}).then(r => {if (!r?.ok) throw new Error(r?.error || "Module Engine script storage unavailable"); return r;});');
      lines.push(
        'const GM_info = Object.freeze(' + JSON.stringify(info) + ');',
        'const GM = {info:GM_info};');
      if (metadata.grants.some(grant => ['GM.addStyle', 'GM_addStyle'].includes(grant))) {
        lines.push('function GM_addStyle(css) { const style=document.createElement("style"); style.textContent=String(css); const attach=()=>{const parent=document.head||document.documentElement;if(!parent)return false;parent.append(style);return true;}; if(!attach()){const observer=new MutationObserver(()=>{if(attach())observer.disconnect();});observer.observe(document,{childList:true,subtree:true});} return style; }');
        if (metadata.grants.includes('GM.addStyle')) lines.push('GM.addStyle = GM_addStyle;');
      }
      for (const grant of metadata.grants) {
        if (grant === 'GM.getValue') lines.push('GM.getValue=(key,fallback)=>__baSend("get",{key}).then(r=>r.exists?r.value:fallback);');
        if (grant === 'GM.setValue') lines.push('GM.setValue=async(key,value)=>{await __baSend("set",{key,value:__baJSON(value)});};');
        if (grant === 'GM.deleteValue') lines.push('GM.deleteValue=key=>__baSend("delete",{key}).then(()=>undefined);');
        if (grant === 'GM.listValues') lines.push('GM.listValues=()=>__baSend("list").then(r=>r.keys);');
      }
      lines.push('Object.freeze(GM);');
    }
    lines.push(script.source, '\n})();', '//# sourceURL=blockads-userscript-' + script.id + '.user.js');
    return { id, matches: metadata.matches, excludeMatches: metadata.excludeMatches, runAt: metadata.runAt,
      allFrames: metadata.allFrames, world: metadata.world,
      ...(metadata.world === 'USER_SCRIPT' ? { worldId: id } : {}), js: [{ code: lines.join('\n') }] };
  }
  globalThis.BlockAdsUserScriptCore = Object.freeze({ LIMITS, GRANTS, bytes, parse, allows, jsonValue,
    validateValues, library, nativeId, registration });
})();
