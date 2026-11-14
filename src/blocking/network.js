/* Original, deliberately bounded custom request-filter compiler. Input is data. */
(() => {
  'use strict';
  const TYPES = Object.freeze(['main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other']);
  const OPTIONS = Object.freeze({document:'main_frame',subdocument:'sub_frame',stylesheet:'stylesheet',script:'script',image:'image',font:'font',object:'object',xmlhttprequest:'xmlhttprequest',xhr:'xmlhttprequest',ping:'ping',media:'media',websocket:'websocket',other:'other'});
  const LIMITS = Object.freeze({text:100000,line:2000,rules:500,domains:100});
  // Same priority as Always Allowed (allow wins a tie), below reported threats
  // and explicit domain blocks. Custom exceptions affect matching requests only.
  const PRIORITY = 4;
  function hostname(value) {
    if (!value || /[\s/\\:@?#*^|%]/u.test(value)) throw new Error('Use a hostname without a scheme, port or wildcard.');
    let host;
    try { host = new URL('https://' + value).hostname.toLowerCase().replace(/\.$/, ''); }
    catch { throw new Error('Invalid hostname.'); }
    if (host.length > 253 || (!host.includes('.') && host !== 'localhost') ||
        host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
        (/^[0-9.]+$/.test(host) && value.replace(/\.$/,'') !== host)) {
      throw new Error('Use a DNS hostname, localhost or a full dotted IPv4 address; IPv6 is unsupported.');
    }
    return host;
  }
  function patternCondition(pattern) {
    let host, filter;
    if (/[\s\\#<>"]/u.test(pattern)) throw new Error('URL patterns cannot contain spaces, backslashes, fragments or markup.');
    if (pattern.startsWith('||')) {
      const match = /^\|\|([^/^|]+)([\^/].*)$/.exec(pattern);
      if (!match) throw new Error('Use ||host^ or ||host/path*. A hostname boundary is required.');
      host = hostname(match[1]);
      filter = '||' + host + match[2];
    } else {
      const match = /^\|(https?|wss?):\/\/([^/]+)(\/.*)$/.exec(pattern);
      if (!match || /[@%\\]/.test(match[2])) throw new Error('Use ||host^ or an anchored HTTP(S)/WS(S) URL such as |https://host/path.');
      let url;
      try { url = new URL(match[1] + '://' + match[2] + '/'); }
      catch { throw new Error('Invalid URL authority or port.'); }
      host = hostname(url.hostname);
      filter = '|' + url.protocol + '//' + host + (url.port ? ':' + url.port : '') + match[3];
    }
    const tail = filter.slice(filter.startsWith('||') ? 2 : 1);
    if (/[^\x21-\x7e]/.test(filter) || /\|(?!$)/.test(tail) || /%(?![0-9a-f]{2})/i.test(filter)) {
      throw new Error('Encode non-ASCII URL paths and literal percent signs; | is allowed only at the end of a pattern.');
    }
    // A second host condition prevents a domain-looking substring elsewhere in
    // a URL from expanding the intended destination scope.
    return {requestDomains:[host],urlFilter:filter};
  }
  function compileLine(line) {
    const exception = line.startsWith('@@');
    const parts = (exception ? line.slice(2) : line).split('$');
    if (parts.length > 2 || (parts.length === 2 && !parts[1])) throw new Error('Use one nonempty $option list; encode a literal dollar sign as %24.');
    const condition = patternCondition(parts[0]);
    const includeTypes = new Set(), excludeTypes = new Set(), seen = new Set();
    let party, sites, matchCase = false;
    for (const option of parts.length === 2 ? parts[1].split(',') : []) {
      const negative = option.startsWith('~'), name = negative ? option.slice(1) : option;
      if (Object.hasOwn(OPTIONS, name)) {
        const type = OPTIONS[name];
        if (seen.has('type:' + type)) throw new Error('Repeated or contradictory resource type: ' + name);
        seen.add('type:' + type); (negative ? excludeTypes : includeTypes).add(type);
      } else if (['third-party','3p','first-party','1p'].includes(name)) {
        if (party) throw new Error('Use only one first/third-party condition.');
        const third = ['third-party','3p'].includes(name) !== negative;
        party = third ? 'thirdParty' : 'firstParty';
      } else if (option === 'match-case') {
        if (seen.has(option)) throw new Error('Repeated match-case option.');
        seen.add(option); matchCase = true;
      } else if (option.startsWith('domain=')) {
        if (sites) throw new Error('Use only one domain= option.');
        const values = option.slice(7).split('|');
        if (values.length > LIMITS.domains) throw new Error('At most 100 initiating sites are allowed per rule.');
        sites = {include:[],exclude:[]};
        const used = new Set();
        for (const value of values) {
          const excluded = value.startsWith('~'), host = hostname(excluded ? value.slice(1) : value);
          if (used.has(host)) throw new Error('Repeated or contradictory initiating site: ' + host);
          used.add(host); sites[excluded ? 'exclude' : 'include'].push(host);
        }
      } else throw new Error('Unsupported option: ' + (option || '(empty)') + '. Nothing was applied.');
    }
    condition.resourceTypes = TYPES.filter(type => (!includeTypes.size || includeTypes.has(type)) && !excludeTypes.has(type));
    if (!condition.resourceTypes.length) throw new Error('The resource-type selection is empty.');
    if (party) condition.domainType = party;
    if (sites?.include.length) condition.initiatorDomains = sites.include.sort();
    if (sites?.exclude.length) condition.excludedInitiatorDomains = sites.exclude.sort();
    if (matchCase) condition.isUrlFilterCaseSensitive = true;
    return {priority:PRIORITY,action:{type:exception ? 'allow' : 'block'},condition};
  }
  function parse(text) {
    if (typeof text !== 'string' || text.length > LIMITS.text) throw new Error('Custom network filters must be text of at most 100,000 characters.');
    const rules = [], seen = new Set();
    for (const [index, raw] of text.split('\n').entries()) {
      const line = raw.trim();
      try {
        if (line.startsWith('!#')) throw new Error('Preprocessor directives and remote includes are unsupported.');
        if (!line || line.startsWith('!')) continue;
        if (line.length > LIMITS.line) throw new Error('A filter may contain at most 2,000 characters.');
        const rule = compileLine(line), key = JSON.stringify(rule);
        if (seen.has(key)) continue;
        seen.add(key); rules.push(rule);
        if (rules.length > LIMITS.rules) throw new Error('At most 500 custom network rules are allowed.');
      } catch (error) { throw new Error('Line ' + (index + 1) + ': ' + error.message); }
    }
    return rules;
  }
  globalThis.BlockAdsNetwork = Object.freeze({parse, LIMITS, TYPES, PRIORITY});
})();
