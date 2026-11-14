/* Bounded URL matching shared by the broker and each native script wrapper. */
(() => {
  'use strict';
  function createMatching(suffixRules = '') {
    const cache = new Map(), MAX_STATES = 512, MAX_WORK = 1000000, MAX_URL = 32768;
    let suffixes;
    const fail = message => { throw new Error(message); };
    const escape = text => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
    function cached(key, build) {
      if (cache.has(key)) return cache.get(key);
      const result = build();
      if (cache.size >= 256) cache.delete(cache.keys().next().value);
      cache.set(key, result); return result;
    }
    function wildcard(pattern, value) {
      const parts = pattern.split('*');
      if (parts.length === 1) return value === pattern;
      if (!value.startsWith(parts[0])) return false;
      let position = parts[0].length;
      for (const part of parts.slice(1, -1)) {
        const found = value.indexOf(part, position); if (found < 0) return false;
        position = found + part.length;
      }
      const tail = parts.at(-1);
      return value.length >= position + tail.length && value.endsWith(tail);
    }
    function publicSuffix(host) {
      if (!suffixRules) fail('The bundled public suffix data is unavailable.');
      suffixes ||= new Set(suffixRules.split('\n'));
      const labels = host.toLowerCase().split('.'); let result = '';
      for (let i = labels.length - 1; i >= 0; i--) {
        const part = labels.slice(i).join('.');
        if (suffixes.has('!' + part)) return labels.slice(i + 1).join('.');
        if (suffixes.has(part) || i + 1 < labels.length && suffixes.has('*.' + labels.slice(i + 1).join('.'))) result = part;
      }
      // Unknown suffixes are not inferred: a stale list must not broaden scope.
      return result;
    }
    function hostMatches(pattern, host, includeRoot = true) {
      if (pattern.endsWith('.tld')) {
        const suffix = publicSuffix(host);
        if (!suffix || host === suffix) return false;
        host = host.slice(0, -suffix.length - 1); pattern = pattern.slice(0, -4);
      }
      return wildcard(pattern, host) || includeRoot && pattern.startsWith('*.') && wildcard(pattern.slice(2), host);
    }
    function matchPattern(value) {
      return cached('m:' + value, () => {
        const parts = /^(\*|http[s*]?):\/\/([^/]+)(\/[^\s]*)$/.exec(value);
        if (!parts || value.length > 2048) fail('Use an HTTP(S) @match pattern, for example https://example.com/*.');
        let [, scheme, authority, path] = parts, host, port = '';
        scheme = scheme === 'http*' ? '*' : scheme;
        if (authority.startsWith('[')) {
          const ip = /^(\[[0-9a-f:.]+\])(?::(\*|\d+))?$/i.exec(authority);
          if (!ip) fail('Invalid IPv6 @match host or port.');
          try { host = new URL('http://' + ip[1]).hostname; } catch { fail('Invalid IPv6 @match host.'); }
          port = ip[2] || '';
        } else {
          const split = /^([^:]+)(?::(\*|\d+))?$/.exec(authority);
          if (!split || /[@\\%?#]/.test(split[1])) fail('Invalid @match host. Credentials are not supported.');
          host = split[1].toLowerCase(); port = split[2] || '';
          if (/[^\x00-\x7f]/.test(host)) {
            const prefix = host.startsWith('*.') ? '*.' : '', bare = host.slice(prefix.length);
            if (bare.includes('*')) fail('Use punycode for internationalized hosts with partial wildcards.');
            try { host = prefix + new URL('http://' + bare).hostname; } catch { fail('Invalid internationalized @match host.'); }
          }
          if (host.length > 253 || host.split('.').some(label => label.length > 63 || !/^[a-z0-9*](?:[a-z0-9*-]*[a-z0-9*])?$/.test(label))) fail('Invalid @match host or wildcard.');
        }
        if (port && port !== '*') {
          if (+port > 65535) fail('Use a port from 0 to 65535, or :*.');
          port = String(+port);
        }
        if (host.endsWith('.tld') && !suffixRules) fail('The bundled public suffix data is unavailable.');
        return { scheme, host, port, path, normalized: scheme + '://' + host + (port ? ':' + port : '') + path };
      });
    }
    function matchURL(rule, url) {
      return (rule.scheme === '*' || url.protocol === rule.scheme + ':') &&
        (!rule.port || rule.port === '*' || rule.port === (url.port || (url.protocol === 'https:' ? '443' : '80'))) &&
        hostMatches(rule.host, url.hostname) && wildcard(rule.path, url.pathname + url.search + (rule.path.includes('#') ? url.hash : ''));
    }
    // Thompson NFA: no user-supplied expression is run by a backtracking engine.
    // Native RegExp is used only for validated, single-character predicates.
    function regexProgram(source) {
      return cached('r:' + source, () => {
        if (source.length > 2048) fail('URL regular expressions support at most 2048 characters.');
        let position = 0, depth = 0;
        const error = message => fail('URL regular expression: ' + message + ' (character ' + (position + 1) + ').');
        function escaped(inClass) {
          const start = position++; const next = source[position++];
          if (!next) error('unfinished escape');
          if (!inClass && (next === 'b' || next === 'B')) return { type: next === 'b' ? 'boundary' : 'nonboundary' };
          if (next === 'x' || next === 'u') {
            const count = next === 'x' ? 2 : 4, hex = source.slice(position, position + count);
            if (hex.length !== count || !/^[a-f0-9]+$/i.test(hex)) error('use fixed-width hexadecimal escapes');
            position += count;
          } else if (next === 'c') {
            if (!/[a-z]/i.test(source[position] || '')) error('invalid control escape'); position++;
          } else if (next === '0') {
            if (/\d/.test(source[position] || '')) error('octal escapes are unsupported');
          } else if (/\d/.test(next)) error('backreferences are unsupported');
          else if (/[a-z]/i.test(next) && !/[dDsSwWfnrtvb]/.test(next)) error('unsupported escape');
          return { type: 'char', atom: source.slice(start, position) };
        }
        function atom() {
          const character = source[position];
          if (character === '(') {
            if (++depth > 16) error('groups are nested too deeply'); position++;
            if (source[position] === '?') {
              if (source.slice(position, position + 2) !== '?:') error('lookarounds and named groups are unsupported'); position += 2;
            }
            const node = alternate();
            if (source[position++] !== ')') error('unclosed group'); depth--; return node;
          }
          if (character === '[') {
            const start = position++; if (source[position] === '^') position++;
            while (position < source.length && source[position] !== ']') {
              if (source[position] === '\\') escaped(true); else position++;
            }
            if (source[position++] !== ']') error('unclosed character class');
            const value = source.slice(start, position);
            try { new RegExp(value, 'i'); } catch { error('invalid character class or range'); }
            return { type: 'char', atom: value };
          }
          if (character === '\\') return escaped(false);
          position++;
          if (character === '^' || character === '$') return { type: character === '^' ? 'begin' : 'end' };
          if ('*+?{}]'.includes(character)) error('unexpected quantifier or bracket');
          return { type: 'char', atom: character === '.' ? '.' : escape(character) };
        }
        function sequence() {
          const nodes = [];
          while (position < source.length && !')|'.includes(source[position])) {
            let node = atom(), min, max, quantifier = source[position];
            if ('*+?'.includes(quantifier || '\0')) {
              position++; min = quantifier === '+' ? 1 : 0; max = quantifier === '?' ? 1 : Infinity;
            } else if (quantifier === '{') {
              const repeat = /^\{(\d+)(?:,(\d*)?)?\}/.exec(source.slice(position));
              if (!repeat) error('invalid repetition'); position += repeat[0].length;
              min = +repeat[1]; max = repeat[0].includes(',') ? repeat[2] ? +repeat[2] : Infinity : min;
              if (min > 128 || max !== Infinity && max > 128 || max < min) error('repetition bounds must be ordered and at most 128');
            }
            if (min !== undefined) {
              if (['begin', 'end', 'boundary', 'nonboundary'].includes(node.type)) error('assertions cannot be repeated');
              if (source[position] === '?') position++; // Greediness does not affect a boolean match.
              node = { type: 'repeat', node, min, max };
            }
            nodes.push(node);
          }
          return { type: 'sequence', nodes };
        }
        function alternate() {
          const nodes = [sequence()];
          while (source[position] === '|') { position++; nodes.push(sequence()); }
          return nodes.length === 1 ? nodes[0] : { type: 'alternate', nodes };
        }
        const tree = alternate(); if (position !== source.length) error('unexpected closing group');
        const states = [];
        const add = state => { if (states.length >= MAX_STATES) error('pattern exceeds 512 matcher states'); states.push(state); return states.length - 1; };
        function compile(node, next) {
          if (node.type === 'sequence') { for (let i = node.nodes.length - 1; i >= 0; i--) next = compile(node.nodes[i], next); return next; }
          if (node.type === 'alternate') {
            const branches = [...new Set(node.nodes.map(child => compile(child, next)))];
            return branches.length === 1 ? branches[0] : add({ type: 'split', targets: branches });
          }
          if (node.type === 'repeat') {
            let tail = next;
            if (node.max === Infinity) { tail = add({ type: 'split', targets: [] }); states[tail].targets = [next, compile(node.node, tail)]; }
            else for (let i = node.min; i < node.max; i++) tail = add({ type: 'split', targets: [tail, compile(node.node, tail)] });
            for (let i = 0; i < node.min; i++) tail = compile(node.node, tail);
            return tail;
          }
          return add({ type: node.type, next, ...(node.atom ? { predicate: new RegExp('^(?:' + node.atom + ')$', 'i') } : {}) });
        }
        const accept = add({ type: 'accept' }), start = compile(tree, accept);
        // Expand only finite literal prefixes. Unknown constructs keep a broad
        // prefilter; they never incorrectly exclude a valid native injection.
        function prefix(node) {
          if (node.type === 'begin') return { values: [''], complete: true, anchored: true };
          if (node.type === 'char') {
            const value = /^\\[\\^$.*+?()[\]{}|/]$/.test(node.atom) ? node.atom.slice(1) : /^[^\\.[\]]$/.test(node.atom) ? node.atom : null;
            return { values: [value || ''], complete: value !== null };
          }
          if (node.type === 'alternate') {
            const parts = node.nodes.map(prefix), values = [...new Set(parts.flatMap(part => part.values))];
            return values.length <= 16 ? { values, complete: parts.every(part => part.complete), anchored: parts.every(part => part.anchored) } : { values: [''], complete: false };
          }
          if (node.type === 'repeat') {
            const item = prefix(node.node);
            if (!item.complete || node.max > 2) return { values: [''], complete: false };
            let values = [''], results = node.min === 0 ? [''] : [];
            for (let i = 1; i <= node.max; i++) { values = values.flatMap(a => item.values.map(b => a + b)); if (i >= node.min) results.push(...values); if (results.length > 16) return { values: [''], complete: false }; }
            return { values: results, complete: true };
          }
          if (node.type === 'sequence') {
            let values = [''], anchored = false;
            for (const [i, child] of node.nodes.entries()) {
              const item = prefix(child); if (i === 0) anchored = Boolean(item.anchored);
              if (values.length * item.values.length > 16) return { values, anchored, complete: false };
              values = values.flatMap(a => item.values.map(b => a + b));
              if (!item.complete) return { values, anchored, complete: false };
            }
            return { values, anchored, complete: true };
          }
          return { values: [''], complete: false };
        }
        return { states, start, prefix: prefix(tree) };
      });
    }
    function regexTest(program, value, budget) {
      const { states, start } = program, seen = new Uint32Array(states.length); let stamp = 0, active = [];
      for (let offset = 0; offset <= value.length; offset++) {
        const stack = [...active, start], next = []; stamp++;
        while (stack.length) {
          // Count duplicate visits too: empty alternatives and epsilon loops
          // must not multiply work outside the shared URL budget.
          if (--budget.work < 0) fail('URL matching work limit exceeded.');
          const index = stack.pop(); if (seen[index] === stamp) continue; seen[index] = stamp;
          const state = states[index];
          if (state.type === 'accept') return true;
          if (state.type === 'split') { stack.push(...state.targets); continue; }
          if (state.type === 'char') { if (offset < value.length && state.predicate.test(value[offset])) next.push(state.next); continue; }
          const boundary = /[a-z0-9_]/i.test(value[offset - 1] || '') !== /[a-z0-9_]/i.test(value[offset] || '');
          if (state.type === 'begin' && offset === 0 || state.type === 'end' && offset === value.length ||
              state.type === 'boundary' && boundary || state.type === 'nonboundary' && !boundary) stack.push(state.next);
        }
        active = next;
        if (!active.length && program.prefix.anchored) return false;
      }
      return false;
    }
    function includePattern(value) {
      return cached('i:' + value, () => {
        if (!value || value.length > 2048) fail('Use a URL glob or /regular expression/ of at most 2048 characters.');
        if (value.startsWith('/')) {
          if (value.length < 2 || !value.endsWith('/')) fail('URL regular expressions must use /pattern/ without flags; matching is case-insensitive.');
          return { regex: regexProgram(value.slice(1, -1)) };
        }
        if (/\s/.test(value)) fail('Whitespace in URL globs must be percent-encoded.');
        const parts = /^(.*?:\/\/)([^/]+)(\/.*)$/.exec(value);
        if (parts && /\.tld(?::(?:\*|\d+))?$/i.test(parts[2])) {
          const authority = matchPattern('*://' + parts[2] + '/*');
          return { scheme: parts[1].toLowerCase(), host: authority.host, port: authority.port, tail: parts[3].toLowerCase() };
        }
        return { glob: value.toLowerCase() };
      });
    }
    function includeTest(rule, url, budget) {
      if (rule.regex) return regexTest(rule.regex, url.href, budget);
      if (rule.glob !== undefined) return wildcard(rule.glob, url.href.toLowerCase());
      return wildcard(rule.scheme, url.protocol + '//') && hostMatches(rule.host, url.hostname, false) &&
        (!rule.port ? !url.port : rule.port === '*' || rule.port === (url.port || (url.protocol === 'https:' ? '443' : '80'))) &&
        wildcard(rule.tail, (url.pathname + url.search + url.hash).toLowerCase());
    }
    function allows(metadata, value) {
      if (typeof value !== 'string' || value.length > MAX_URL || !/^https?:\/\//.test(value) || /[\u0000-\u0020\u007f]/.test(value)) return false;
      try {
        const url = new URL(value), budget = { work: MAX_WORK };
        if (url.href.length > MAX_URL) return false;
        // Evaluate exclusions first; any parsing/work-limit failure denies scope.
        if (metadata.excludeMatches.some(pattern => matchURL(matchPattern(pattern), url)) || metadata.excludes.some(pattern => includeTest(includePattern(pattern), url, budget))) return false;
        return metadata.matches.some(pattern => matchURL(matchPattern(pattern), url)) || metadata.includes.some(pattern => includeTest(includePattern(pattern), url, budget));
      } catch { return false; }
    }
    function nativeGlob(value) {
      const parts = /^(https?:\/\/[^/]+)(.*)$/i.exec(value);
      return (parts ? parts[1].toLowerCase() + parts[2].replace(/[a-z]/gi, '?') : value.replace(/[a-z]/gi, '?')).replaceAll('\\', '*').split('#')[0] + '*';
    }
    function nativeMatch(value) {
      const rule = matchPattern(value); let host = rule.host;
      if (host.endsWith('.tld') || host.startsWith('[')) host = '*';
      else if (host.includes('*') && host !== '*' && !/^\*\.[^*]+$/.test(host)) {
        const suffix = host.slice(host.lastIndexOf('*') + 1), dot = suffix.indexOf('.');
        host = dot >= 0 ? '*.' + suffix.slice(dot + 1) : '*';
      }
      // Ports and fragments are checked by the wrapper/broker, not native APIs.
      return rule.scheme + '://' + host + rule.path.split('#')[0] + (rule.path.includes('#') ? '*' : '');
    }
    function prefilter(metadata) {
      const matches = [...new Set(metadata.matches.map(nativeMatch))], globs = [];
      for (const value of metadata.includes) {
        const rule = includePattern(value);
        if (rule.regex) {
          const prefix = rule.regex.prefix;
          if (!prefix.anchored || prefix.values.some(item => !/^https?:\/\/[^/@?#]+\//i.test(item))) globs.push('http://*', 'https://*');
          else globs.push(...prefix.values.map(nativeGlob));
        } else if (rule.host) {
          // Canonicalize IDNs/default ports; native globs admit a superset.
          globs.push(nativeGlob(rule.scheme + rule.host.slice(0, -4) + '.*' + rule.tail));
        } else globs.push(nativeGlob(value));
      }
      return { matches: matches.length ? matches : ['https://module-engine.invalid/__include_only__'],
        ...(globs.length ? { includeGlobs: [...new Set(globs)] } : {}),
        excludeMatches: metadata.excludeMatches.filter(value => {
          const rule = matchPattern(value);
          return !rule.port && !rule.path.includes('#') && !rule.host.endsWith('.tld') && !rule.host.startsWith('[') && (rule.host === '*' || /^\*\.[^*]+$/.test(rule.host) || !rule.host.includes('*'));
        }) };
    }
    return Object.freeze({ matchPattern, includePattern, allows, prefilter, publicSuffix, regexProgram, regexTest, wildcard });
  }
  const data = globalThis.ModuleEngineSuffixes?.rules || '';
  const matcher = createMatching(data);
  globalThis.BlockAdsMatching = Object.freeze({ ...matcher, create: createMatching,
    guard: metadata => {
      const usesSuffixes = [...metadata.matches, ...metadata.excludeMatches].some(value => matcher.matchPattern(value).host.endsWith('.tld')) ||
        [...metadata.includes, ...metadata.excludes].some(value => Boolean(matcher.includePattern(value).host));
      return 'const scopeMatcher=(' + createMatching.toString() + ')(' + JSON.stringify(usesSuffixes ? data : '') + ');\n' +
        'if(!scopeMatcher.allows(' + JSON.stringify({matches:metadata.matches,excludeMatches:metadata.excludeMatches,includes:metadata.includes,excludes:metadata.excludes}) + ',location.href))return;';
    } });
})();
