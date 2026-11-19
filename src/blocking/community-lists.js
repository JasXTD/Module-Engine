/* EasyList-format conversion for the community layer, shared by the extension's
   list updates and the offline checks. It mirrors ConvertFrom-CommunityLists in
   scripts/community-list-tools.ps1, which builds the bundled rules, and
   tests/community-convert.test.cjs requires both to produce the same rules and
   site hiding data from the bundled snapshots.

   List lines are data: nothing is fetched, resolved or evaluated here. Filters
   that need runtime features Module Engine does not have are skipped and
   counted, never approximated with a broader rule. Generic hiding is compiled
   into stylesheets by the build only (scripts/compile-generic-css.cjs).

   Where PowerShell semantics matter they are reproduced: `-match` ignores case,
   and .NET's trim and \s cover U+0085 but not U+FEFF. */
(() => {
  'use strict';
  const TYPES = Object.freeze({
    script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet', object: 'object',
    xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest', subdocument: 'sub_frame', frame: 'sub_frame',
    ping: 'ping', beacon: 'ping', media: 'media', font: 'font', websocket: 'websocket', other: 'other'
  });
  // Chrome guarantees each extension 30,000 enabled static rules; leave room for
  // Module Engine's own ad, tracker and threat rulesets.
  const MAX_RULES = 29000;
  const DOMAIN_CHUNK = 1000;
  // At most this many advanced (procedural) hiding and scriptlet candidates, as in the build.
  const MAX_PROCEDURAL = 5000;
  const MAX_SCRIPTLETS = 5000;
  // .NET whitespace: Char.IsWhiteSpace for Trim(), and the same set for \s.
  const WS = '\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
  const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');
  const trim = text => text.replace(TRIM, '');
  const HEADER = new RegExp(`^![${WS}]*(Version|Last modified|Title):[${WS}]*(.+)$`, 'is');
  const PROCEDURAL = /:(-abp-|has-text|contains|xpath|matches-|upward|min-text-length|watch-attr|others|remove|style|if\(|if-not|nth-ancestor|matches-path|matches-media)/i;
  const COSMETIC = new RegExp(`^([^${WS}/|^$@#]*)(#@?[?$%]?#|\\$@?\\$)(.+)$`, 's');
  const DOMAIN_ONLY = /^\|\|([^/^*|:?=&]+)\^\|?$/;
  const OPTIONS = /^[A-Za-z0-9~_,=|.*:/\-]+$/;
  const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  const HEADER_NAMES = { version: 'Version', 'last modified': 'Last modified', title: 'Title' };
  // Ordinal order, as .NET's SortedSet with StringComparer.Ordinal.
  const sorted = values => [...values].sort();

  // International names become punycode through the URL parser. Characters it
  // would read as part of a URL are refused first; they could never form a
  // valid label anyway.
  function toAscii(host) {
    if (/[\x00-\x20%/\\?#@:[\]<>^|]/.test(host)) return null;
    try { return new URL(`http://${host}/`).hostname.toLowerCase(); } catch { return null; }
  }

  function communityHost(value) {
    if (!value || value.length > 253) return null;
    let host = value.toLowerCase().replace(/\.+$/, '');
    if (/[^\x21-\x7e]/.test(host)) {
      host = toAscii(host);
      if (!host) return null;
    }
    const labels = host.split('.');
    if (labels.length < 2 || !labels.every(label => LABEL.test(label))) return null;
    return host;
  }

  // Module Engine's own blocked domains: community exceptions never apply to
  // requests for them, nor for their parents or subdomains.
  function protectedTest(domains) {
    const set = new Set(domains);
    return host => {
      const labels = host.split('.');
      for (let i = 0; i < labels.length - 1; i++) if (set.has(labels.slice(i).join('.'))) return true;
      for (const domain of set) if (domain.endsWith('.' + host)) return true;
      return false;
    };
  }

  // A grouping key: equivalent filters with options in any order share it.
  const conditionKey = (action, priority, condition) =>
    `${action}|${priority}|` + Object.keys(condition).sort().map(key => `${key}=${[condition[key]].flat().join(',')}`).join(';');

  // A list's scriptlet filters, checked as a person's own are: unknown names and
  // unsupported arguments are counted, never approximated. Shared with the build
  // (scripts/compile-scriptlets.cjs).
  function compileScriptlets(candidates, parseScriptlet) {
    if (!Array.isArray(candidates) || candidates.length > MAX_SCRIPTLETS) throw new Error('Invalid scriptlet candidate count.');
    const rules = [], skipped = {};
    const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    for (const rule of candidates) {
      if (!rule || !Array.isArray(rule.include) || !Array.isArray(rule.exclude) || typeof rule.exception !== 'boolean' || typeof rule.body !== 'string') {
        throw new Error('Invalid scriptlet candidate.');
      }
      let scriptlet;
      try { scriptlet = parseScriptlet(rule.body); } catch { skip('scriptlet: unsupported scriptlet or arguments'); continue; }
      if (!scriptlet.name && !rule.exception) { skip('scriptlet: no scriptlet named'); continue; }
      rules.push({ include: rule.include, exclude: rule.exclude, exception: rule.exception, name: scriptlet.name, args: scriptlet.args });
    }
    return { rules, skipped };
  }

  // lists: [{ id, title, text }]. protectedDomains: Module Engine's own blocked
  // domains. compileSelector: BlockAdsCosmetic.compileSelector, for advanced
  // hiding. parseScriptlet: BlockAdsScriptlets.parseBody, for scriptlet filters.
  function convert(lists, { protectedDomains = [], compileSelector, parseScriptlet } = {}) {
    if (!Array.isArray(lists) || typeof compileSelector !== 'function' || typeof parseScriptlet !== 'function') throw new Error('Invalid community list input.');
    const isProtected = protectedTest(protectedDomains);
    const protectedSorted = sorted(new Set(protectedDomains));
    const skipped = {};
    const skip = reason => { skipped[reason] = (skipped[reason] || 0) + 1; };
    const hide = new Map(), allow = new Map(), generic = new Set();
    const scoped = [], candidates = [], scriptletCandidates = [];
    const disableGeneric = new Set(), disableAll = new Set();
    const groups = new Map(), singles = new Map();
    const headers = [];
    let limitedExceptions = 0;
    const add = (map, key, value) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(value); };

    for (const list of lists) {
      if (!list || typeof list.text !== 'string') throw new Error('Invalid community list text.');
      const header = {};
      for (const raw of list.text.split(/\r?\n/)) {
        const line = trim(raw);
        if (!line) continue;
        if (line[0] === '!' || line[0] === '[') {
          const match = HEADER.exec(line);
          const name = match && HEADER_NAMES[match[1].toLowerCase()];
          if (name && !Object.hasOwn(header, name)) header[name] = trim(match[2]);
          continue;
        }
        const cosmetic = COSMETIC.exec(line);
        if (cosmetic) {
          const [, domainText, sep] = cosmetic;
          if (!['##', '#@#', '#?#', '#@?#'].includes(sep)) { skip('cosmetic: snippet or HTML filter'); continue; }
          const selector = trim(cosmetic[3]);
          // ##+js(...) and #@#+js(...) are scriptlet filters, checked after the lists are read.
          const isScriptlet = (sep === '##' || sep === '#@#') && selector.startsWith('+js(');
          if (!isScriptlet && (selector.length > 1000 || /[{}\x00-\x1f]|\/\*|\*\//.test(selector) || selector.startsWith('+js('))) {
            skip('cosmetic: procedural or unsafe selector'); continue;
          }
          const isProcedure = !isScriptlet && (sep.includes('?') || PROCEDURAL.test(selector));
          const isException = sep.includes('@');
          if (!domainText) {
            // A scriptlet for every site, or an exception for every site, is not taken from a list.
            if (isScriptlet) { skip('scriptlet: filter without a site'); continue; }
            if (isProcedure) { candidates.push({ include: [], exclude: [], selector, exception: isException }); continue; }
            if (sep === '##') generic.add(selector);
            else add(allow, '*', selector);
            continue;
          }
          const domains = [], excluded = [];
          let invalid = false, dropped = 0;
          for (const scope of domainText.split(',')) {
            const negative = scope.startsWith('~');
            const host = communityHost(negative ? scope.slice(1) : scope);
            if (host) { (negative ? excluded : domains).push(host); continue; }
            // An unsupported site, such as a name.* wildcard, is dropped from a rule's
            // sites: the rule then covers fewer sites, never more. Dropping an excluded
            // site would widen the rule, so that skips the whole rule.
            if (negative) { invalid = true; break; }
            dropped++;
          }
          // A rule whose every site was dropped is skipped: applying only its
          // exclusions would make a site rule generic.
          if (invalid || (dropped && !domains.length)) { skip('cosmetic: wildcard or invalid domain'); continue; }
          // Counted per dropped site, not per rule: the rule itself is kept.
          if (dropped) {
            const partial = 'cosmetic: wildcard or invalid site dropped from a kept rule';
            skipped[partial] = (skipped[partial] || 0) + dropped;
          }
          if (isScriptlet) { scriptletCandidates.push({ include: domains, exclude: excluded, exception: isException, body: selector }); continue; }
          if (isProcedure) { candidates.push({ include: domains, exclude: excluded, selector, exception: isException }); continue; }
          if (excluded.length) { scoped.push({ include: domains, exclude: excluded, selector, exception: sep === '#@#' }); continue; }
          for (const domain of domains) add(sep === '##' ? hide : allow, domain, selector);
          continue;
        }

        const exception = line.startsWith('@@');
        const text = exception ? line.slice(2) : line;
        // Only exact host-wide exceptions have a lossless mapping here.
        // Path/option-specific exceptions stay counted as unsupported.
        const cosmeticException = exception && /\$(generichide|elemhide)$/i.exec(text);
        if (cosmeticException) {
          const kind = cosmeticException[1].toLowerCase();
          const hostMatch = /^\|\|([^/^*|:?=&]+)\^\$(generichide|elemhide)$/i.exec(text);
          const host = hostMatch ? communityHost(hostMatch[1]) : null;
          if (!host) { skip('network: unsupported cosmetic exception'); continue; }
          (kind === 'generichide' ? disableGeneric : disableAll).add(host);
          continue;
        }
        // /.../ is a regular expression, with or without $options; its body may contain $.
        if (text.length > 2 && /^\/.+\/(\$[^$]*)?$/s.test(text)) { skip('network: regular expression'); continue; }
        let pattern = text, options = [];
        const dollar = text.lastIndexOf('$');
        if (dollar >= 0) {
          // Options with quotes, spaces or other syntax are unsupported, not part of the URL.
          if (!OPTIONS.test(text.slice(dollar + 1))) { skip('network: unsupported option syntax'); continue; }
          pattern = text.slice(0, dollar);
          options = text.slice(dollar + 1).split(',');
        }

        const condition = {};
        const types = new Set(), excludedTypes = new Set(), initiators = new Set(), excludedInitiators = new Set();
        let important = false, pageLoad = false, reason = null;
        for (const rawOption of options) {
          const option = trim(rawOption).toLowerCase();
          if (!option) continue;
          const negated = option.startsWith('~');
          const name = option.replace(/^~+/, '');
          let domainOption;
          if (name === 'third-party' || name === '3p') condition.domainType = negated ? 'firstParty' : 'thirdParty';
          else if (name === 'first-party' || name === '1p') condition.domainType = negated ? 'thirdParty' : 'firstParty';
          else if ((domainOption = /^(domain|from)=(.+)$/is.exec(name))) {
            for (const domain of domainOption[2].split('|')) {
              const negative = domain.startsWith('~');
              const host = domain.includes('*') ? null : communityHost(domain.replace(/^~+/, ''));
              if (!host) { reason = 'network: wildcard or invalid domain option'; break; }
              (negative ? excludedInitiators : initiators).add(host);
            }
          }
          else if (name === 'match-case') condition.isUrlFilterCaseSensitive = true;
          else if (name === 'important' && !negated) important = true;
          else if (name === 'popup' && !negated) { types.add('main_frame'); pageLoad = true; }
          else if ((name === 'document' || name === 'doc') && !negated && !exception) { types.add('main_frame'); pageLoad = true; }
          else if (Object.hasOwn(TYPES, name)) (negated ? excludedTypes : types).add(TYPES[name]);
          else reason = `network: unsupported option ${name.replace(/=.*$/s, '=')}`;
          if (reason) break;
        }
        if (!reason && exception && important) reason = 'network: important exception';
        if (reason) { skip(reason); continue; }

        if (types.size) {
          for (const type of excludedTypes) types.delete(type);
          if (!types.size) { skip('network: no resource types left'); continue; }
          condition.resourceTypes = sorted(types);
        } else if (excludedTypes.size) {
          // Without resourceTypes the browser default excludes page loads; keep that.
          excludedTypes.add('main_frame');
          condition.excludedResourceTypes = sorted(excludedTypes);
        }
        if (initiators.size) condition.initiatorDomains = sorted(initiators);
        if (excludedInitiators.size) condition.excludedInitiatorDomains = sorted(excludedInitiators);
        // Browser rules cannot tell a pop-up from a normal page load. A pop-up or
        // page pattern not tied to one host applies only to loads started by
        // another site, so a site's own redirect links keep working.
        if (pageLoad && !exception && !pattern.startsWith('||') && !Object.hasOwn(condition, 'domainType')) condition.domainType = 'thirdParty';
        const action = exception ? 'allow' : 'block';
        const priority = exception ? 2 : important ? 3 : 1;
        const key = conditionKey(action, priority, condition);

        const domainOnly = DOMAIN_ONLY.exec(pattern);
        const anchored = /^\|\|([a-z0-9.-]+)/i.exec(pattern);
        const anchoredHost = anchored ? communityHost(anchored[1]) : null;
        if (exception && anchoredHost && isProtected(anchoredHost)) {
          limitedExceptions++; skip('network: exception for a BlockAds-blocked domain'); continue;
        }
        if (domainOnly) {
          const host = communityHost(domainOnly[1]);
          if (!host) { skip('network: invalid host'); continue; }
          if (!groups.has(key)) groups.set(key, { action, priority, condition, hosts: new Set() });
          groups.get(key).hosts.add(host);
          continue;
        }
        if (/^[|*]*$/.test(pattern) || pattern.length < 4) { skip('network: pattern too short or broad'); continue; }
        if (pattern.startsWith('||*') || /[^\x20-\x7e]/.test(pattern)) { skip('network: unsupported pattern syntax'); continue; }
        condition.urlFilter = pattern;
        if (exception && !anchoredHost && protectedSorted.length) {
          // A path exception could match any host; keep it off Module Engine's domains.
          condition.excludedRequestDomains = protectedSorted;
          limitedExceptions++;
        }
        singles.set(`${key}|${pattern}`, { priority, action: { type: action }, condition });
      }
      headers.push({ id: list.id, title: header.Title ?? list.title, version: header.Version, lastModified: header['Last modified'] });
    }

    // Rules: merged domain groups in chunks, then single patterns, in the
    // order they first appeared. IDs count from 1.
    const rules = [];
    let groupedDomains = 0;
    const groupList = [...groups.values()].map(group => ({ ...group, hosts: sorted(group.hosts) }));
    for (const group of groupList) {
      groupedDomains += group.hosts.length;
      for (let offset = 0; offset < group.hosts.length; offset += DOMAIN_CHUNK) {
        rules.push({ id: rules.length + 1, priority: group.priority, action: { type: group.action },
          condition: { requestDomains: group.hosts.slice(offset, offset + DOMAIN_CHUNK), ...group.condition } });
      }
    }
    for (const rule of singles.values()) rules.push({ id: rules.length + 1, priority: rule.priority, action: rule.action, condition: rule.condition });
    if (rules.length > MAX_RULES) throw new Error(`Community lists produce ${rules.length} rules; the limit is ${MAX_RULES}.`);

    if (candidates.length > MAX_PROCEDURAL) throw new Error('Invalid procedural candidate count.');
    const procedural = [];
    for (const rule of candidates) {
      if (!rule.include.length && !rule.exception) { skip('cosmetic: procedural rule needs positive site scope'); continue; }
      try { procedural.push({ ...rule, procedure: compileSelector(rule.selector) }); }
      catch { skip('cosmetic: unsupported procedural syntax'); }
    }
    const scriptlets = compileScriptlets(scriptletCandidates, parseScriptlet);
    for (const [reason, count] of Object.entries(scriptlets.skipped)) skipped[reason] = (skipped[reason] || 0) + count;
    const toObject = map => Object.fromEntries(sorted(map.keys()).map(key => [key, sorted(map.get(key))]));
    const hideObject = toObject(hide);
    return {
      rules,
      groups: groupList,
      cosmetic: { schemaVersion: 3, hide: hideObject, allow: toObject(allow), generic: sorted(generic), scoped, procedural,
        scriptlets: scriptlets.rules, disableGeneric: sorted(disableGeneric), disableAll: sorted(disableAll) },
      info: { lists: headers, networkRules: rules.length, groupedDomains, cosmeticSites: hide.size,
        cosmeticSelectors: Object.values(hideObject).reduce((sum, list) => sum + list.length, 0),
        exceptionsLimitedForBlockAdsRules: limitedExceptions, genericCosmeticSelectors: generic.size, scopedCosmeticRules: scoped.length,
        proceduralCosmeticRules: procedural.length, scriptletRules: scriptlets.rules.length, cosmeticSiteExceptions: disableGeneric.size + disableAll.size,
        skipped: Object.fromEntries(Object.keys(skipped).sort().map(reason => [reason, skipped[reason]])) }
    };
  }

  globalThis.BlockAdsCommunityLists = Object.freeze({ convert, compileScriptlets, communityHost, conditionKey, MAX_RULES, DOMAIN_CHUNK });
})();
