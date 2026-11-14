/* Bounded URL matching shared by the broker and each native script wrapper. */
(() => {
  'use strict';
  function createMatching(suffixRules = '') {
    const cache = new Map(), MAX_STATES = 512, MAX_WORK = 1000000, MAX_URL = 32768;
    let suffixes;
    const fail = message => { throw new Error(message); };
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
    // Syntax follows native non-Unicode RegExp (including Annex B forms) and is
    // validated by the native parser, but no user expression is ever executed
    // by a native backtracking engine. A Thompson NFA evaluates regular
    // patterns; each lookaround becomes one linear pass that marks every
    // position where it holds. Only backreferences need the bounded
    // backtracking matcher below. Native RegExp tests single characters only.
    function regexProgram(source) {
      return cached('r:' + source, () => {
        if (source.length > 2048) fail('URL regular expressions support at most 2048 characters.');
        try { new RegExp(source, 'i'); } catch (caught) { fail('URL regular expression: ' + caught.message); }
        let position = 0, depth = 0, groupIndex = 0, repeats = 0, backrefs = false;
        const error = message => fail('URL regular expression: ' + message + ' (character ' + (position + 1) + ').');
        const notes = [], names = new Map(), unit = code => '\\u' + code.toString(16).padStart(4, '0');
        const decodeName = name => name.replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})/gi, (_, wide, narrow) => String.fromCodePoint(parseInt(wide || narrow, 16)));
        // Decimal escapes are backreferences only up to the total group count,
        // so count capturing groups (and record names) before parsing.
        let groups = 0;
        for (let i = 0, inClass = false; i < source.length; i++) {
          if (source[i] === '\\') { i++; continue; }
          if (inClass) { inClass = source[i] !== ']'; continue; }
          if (source[i] === '[') inClass = true;
          else if (source[i] === '(' && (source[i + 1] !== '?' || source[i + 2] === '<' && !'=!'.includes(source[i + 3]))) {
            groups++;
            if (source[i + 1] === '?') {
              const name = decodeName(source.slice(i + 3, source.indexOf('>', i)));
              if (!names.has(name)) names.set(name, []);
              names.get(name).push(groups);
            }
          }
        }
        const char = (atom, context, literal) => {
          let predicate; try { predicate = new RegExp('^(?:' + atom + ')$', context.icase ? 'i' : ''); } catch { error('invalid character class or range'); }
          return { type: 'char', predicate, ...(literal !== undefined ? { literal } : {}) };
        };
        const literal = (code, context) => char(unit(code), context, String.fromCharCode(code));
        const hex = count => { const value = source.slice(position, position + count); return value.length === count && /^[0-9a-f]+$/i.test(value) ? parseInt(value, 16) : null; };
        function octal() {
          // Legacy octal escapes take at most three digits and stay below 256.
          let value = +source[position++];
          if (/[0-7]/.test(source[position] || '')) {
            value = value * 8 + +source[position++];
            if (value < 32 && /[0-7]/.test(source[position] || '')) value = value * 8 + +source[position++];
          }
          return value;
        }
        function codeUnit() {
          const next = source[position++], controls = { f: 12, n: 10, r: 13, t: 9, v: 11 };
          if (Object.hasOwn(controls, next)) return controls[next];
          if (next === 'c') {
            if (/[a-z]/i.test(source[position] || '')) return source.charCodeAt(position++) % 32;
            position--; return 92; // A backslash before a non-letter "c" is itself literal.
          }
          if (next === '0' && !/\d/.test(source[position] || '')) return 0;
          if (/[0-7]/.test(next)) { position--; return octal(); }
          for (const [letter, count] of [['x', 2], ['u', 4]]) {
            const value = next === letter ? hex(count) : null;
            if (value !== null) { position += count; return value; }
          }
          if ((next === 'p' || next === 'P') && source[position] === '{')
            notes.push('URL regular expressions have no u flag, so \\' + next + '{…} matches the literal text, as in Violentmonkey.');
          return next.charCodeAt(0); // Identity escape.
        }
        function escape(context) {
          position++;
          const next = source[position];
          if (next === undefined) error('unfinished escape');
          if (next === 'b' || next === 'B') { position++; return { type: 'assert', kind: next === 'b' ? 'boundary' : 'nonboundary' }; }
          if ('dDsSwW'.includes(next)) { position++; return char('\\' + next, context); }
          if (/[1-9]/.test(next)) {
            const digits = /^\d+/.exec(source.slice(position))[0];
            if (+digits <= groups) { position += digits.length; backrefs = true; return { type: 'backref', groups: [+digits], icase: context.icase }; }
            if (next === '8' || next === '9') { position++; return literal(next.charCodeAt(0), context); }
            return literal(octal(), context);
          }
          if (next === 'k' && names.size) {
            const end = source.indexOf('>', position), name = decodeName(source.slice(position + 2, end));
            if (source[position + 1] !== '<' || end < 0 || !names.has(name)) error('invalid named backreference');
            position = end + 1; backrefs = true;
            return { type: 'backref', groups: names.get(name), icase: context.icase };
          }
          return literal(codeUnit(), context);
        }
        function quantifier() {
          const next = source[position]; let min, max, length = 1;
          if (next === '*' || next === '+' || next === '?') { min = next === '+' ? 1 : 0; max = next === '?' ? 1 : Infinity; }
          else if (next === '{') {
            // A brace that does not form a complete quantifier is a literal.
            const repeat = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(position));
            if (!repeat) return null;
            min = +repeat[1]; max = repeat[2] ? repeat[3] ? +repeat[3] : Infinity : min; length = repeat[0].length;
          } else return null;
          const lazy = source[position + length] === '?';
          return { min, max, lazy, length: length + (lazy ? 1 : 0) };
        }
        function group(context) {
          if (++depth > 16) error('groups are nested too deeply');
          position++;
          const rest = source.slice(position, position + 4096); let node, match;
          if (rest.startsWith('?:')) { position += 2; node = disjunction(context); }
          else if ((match = /^\?(<?)([=!])/.exec(rest))) {
            position += match[0].length;
            node = { type: 'look', behind: match[1] === '<', negative: match[2] === '!', node: disjunction(context) };
          } else if ((match = /^\?<[^>]+>/.exec(rest)) || rest[0] !== '?') {
            if (match) position += match[0].length;
            const index = ++groupIndex; node = { type: 'group', index, node: disjunction(context) };
          } else if ((match = /^\?([ims]*)(?:-([ims]*))?:/.exec(rest))) {
            // Modifiers: only i changes URL matching; URLs have no line terminators.
            position += match[0].length;
            node = disjunction({ ...context, icase: match[2]?.includes('i') ? false : match[1].includes('i') || context.icase });
          } else error('unsupported group');
          if (source[position++] !== ')') error('unclosed group');
          depth--; return node;
        }
        function term(context) {
          const first = groupIndex + 1, next = source[position]; let node;
          if (next === '(') node = group(context);
          else if (next === '[') {
            const start = position++; if (source[position] === '^') position++;
            while (position < source.length && source[position] !== ']') position += source[position] === '\\' ? 2 : 1;
            if (source[position++] !== ']') error('unclosed character class');
            node = char(source.slice(start, position), context);
          } else if (next === '\\') node = escape(context);
          else if (next === '^' || next === '$') { position++; node = { type: 'assert', kind: next === '^' ? 'begin' : 'end' }; }
          else if ('*+?'.includes(next) || next === '{' && quantifier()) error('nothing to repeat');
          else { position++; node = next === '.' ? char('.', context) : literal(next.charCodeAt(0), context); }
          const repeat = quantifier();
          if (!repeat) return node;
          position += repeat.length;
          if (repeat.min > 128 || repeat.max !== Infinity && repeat.max > 128) error('repetition bounds must be at most 128');
          return { type: 'repeat', node, min: repeat.min, max: repeat.max, lazy: repeat.lazy, first, last: groupIndex, slot: repeats++ };
        }
        function sequence(context) {
          const nodes = [];
          while (position < source.length && source[position] !== '|' && source[position] !== ')') nodes.push(term(context));
          return { type: 'seq', nodes };
        }
        function disjunction(context) {
          const nodes = [sequence(context)];
          while (source[position] === '|') { position++; nodes.push(sequence(context)); }
          return nodes.length === 1 ? nodes[0] : { type: 'alt', nodes };
        }
        const tree = disjunction({ icase: true });
        if (position !== source.length) error('unexpected closing group');
        // Captures are tracked only for backreferences: three slots per group
        // (start, end, pending start), then one empty-iteration mark per repeat.
        const ins = [], looks = [], captures = backrefs; let compileWork = 100000;
        const add = state => { if (ins.length >= MAX_STATES) error('pattern exceeds 512 matcher states'); ins.push(state); return ins.length - 1; };
        const slot = (group, part) => 3 * (group - 1) + part, mark = repeat => 3 * groups + repeat;
        function compile(node, next, back) {
          // Repeated empty groups may do work without adding any states.
          if (--compileWork < 0) error('pattern exceeds the compilation work limit');
          if (node.type === 'seq') {
            // Backward bodies run their terms in reverse order.
            for (let i = 0; i < node.nodes.length; i++) next = compile(node.nodes[back ? i : node.nodes.length - 1 - i], next, back);
            return next;
          }
          if (node.type === 'alt') {
            const branches = [...new Set(node.nodes.map(child => compile(child, next, back)))];
            return branches.length === 1 ? branches[0] : add({ op: 'split', targets: branches });
          }
          if (node.type === 'char') return add({ op: 'char', predicate: node.predicate, back, next });
          if (node.type === 'assert') return add({ op: 'assert', kind: node.kind, next });
          if (node.type === 'group') {
            if (!captures) return compile(node.node, next, back);
            const close = add({ op: 'close', start: slot(node.index, 0), end: slot(node.index, 1), pending: slot(node.index, 2), back, next });
            return add({ op: 'open', pending: slot(node.index, 2), next: compile(node.node, close, back) });
          }
          if (node.type === 'backref') return add({ op: 'backref', groups: node.groups.map(group => [slot(group, 0), slot(group, 1)]), icase: node.icase, back, next });
          if (node.type === 'look') {
            // The NFA marks lookahead positions with a reversed leftward pass
            // and lookbehind positions with a forward pass. Backtracking runs
            // lookaheads forward and lookbehinds backward from the position.
            const direction = captures ? node.behind : !node.behind, index = looks.length;
            looks.push(null);
            looks[index] = { start: compile(node.node, add({ op: 'accept' }), direction), back: direction, negative: node.negative };
            return add({ op: 'look', look: index, next });
          }
          // Repeat.
          let tail = next;
          if (!captures) {
            if (node.max === Infinity) { tail = add({ op: 'split', targets: [] }); ins[tail].targets = [next, compile(node.node, tail, back)]; }
            else for (let i = node.min; i < node.max; i++) tail = add({ op: 'split', targets: [tail, compile(node.node, tail, back)] });
            for (let i = 0; i < node.min; i++) tail = compile(node.node, tail, back);
            return tail;
          }
          // ECMAScript order: reset inner captures before each iteration, try
          // greedy/lazy choices in priority order and reject empty optional ones.
          const resets = [];
          for (let group = node.first; group <= node.last; group++) resets.push(slot(group, 0), slot(group, 1));
          const iteration = (after, optional) => {
            let entry = compile(node.node, optional ? add({ op: 'progress', slot: mark(node.slot), next: after }) : after, back);
            if (optional) entry = add({ op: 'mark', slot: mark(node.slot), next: entry });
            return resets.length ? add({ op: 'reset', slots: resets, next: entry }) : entry;
          };
          const choose = body => node.lazy ? [next, body] : [body, next];
          if (node.max === Infinity) { tail = add({ op: 'split', targets: [] }); ins[tail].targets = choose(iteration(tail, true)); }
          else for (let i = node.min; i < node.max; i++) tail = add({ op: 'split', targets: choose(iteration(tail, true)) });
          for (let i = 0; i < node.min; i++) tail = iteration(tail, false);
          return tail;
        }
        const start = compile(tree, add({ op: 'accept' }), false);
        // Expand only finite literal prefixes. Unknown constructs keep a broad
        // prefilter; they never incorrectly exclude a valid native injection.
        function prefix(node) {
          if (node.type === 'assert' && node.kind === 'begin') return { values: [''], complete: true, anchored: true };
          // Lookarounds consume nothing and only narrow a match.
          if (node.type === 'look') return { values: [''], complete: true };
          if (node.type === 'group') return prefix(node.node);
          if (node.type === 'char') return { values: [node.literal ?? ''], complete: node.literal !== undefined };
          if (node.type === 'alt') {
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
          if (node.type === 'seq') {
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
        return { ins, start, looks, captures, slots: 3 * groups + repeats, prefix: prefix(tree), notes };
      });
    }
    const word = character => character !== undefined && /[a-z0-9_]/i.test(character);
    function assertion(kind, value, offset) {
      if (kind === 'begin') return offset === 0;
      if (kind === 'end') return offset === value.length;
      return (word(value[offset - 1]) !== word(value[offset])) === (kind === 'boundary');
    }
    // One Thompson pass. The main body stops at its first accept; lookaround
    // bodies scan every start (rightward, or leftward when reversed) and return
    // the positions where an accept is reached.
    function scan(run, start, back, main) {
      const { program: { ins }, value, budget } = run, length = value.length;
      const seen = new Uint32Array(ins.length), found = main ? null : new Uint8Array(length + 1);
      let stamp = 0, active = [];
      for (let step = 0; step <= length; step++) {
        const offset = back ? length - step : step, stack = [...active, start], next = []; stamp++;
        while (stack.length) {
          // Count duplicate visits too: empty alternatives and epsilon loops
          // must not multiply work outside the shared URL budget.
          if (--budget.work < 0) fail('URL matching work limit exceeded.');
          const index = stack.pop(); if (seen[index] === stamp) continue; seen[index] = stamp;
          const state = ins[index];
          if (state.op === 'accept') { if (main) return true; found[offset] = 1; }
          else if (state.op === 'split') stack.push(...state.targets);
          else if (state.op === 'char') {
            const at = back ? offset - 1 : offset;
            if (at >= 0 && at < length && state.predicate.test(value[at])) next.push(state.next);
          } else if (state.op === 'assert' ? assertion(state.kind, value, offset) : lookaround(run, state.look, offset)) stack.push(state.next);
        }
        active = next;
        if (main && !active.length && run.program.prefix.anchored) return false;
      }
      return main ? false : found;
    }
    function lookaround(run, index, offset) {
      const look = run.program.looks[index];
      run.marks[index] ||= scan(run, look.start, look.back, false);
      return Boolean(run.marks[index][offset]) !== look.negative;
    }
    const canonical = character => {
      // ECMAScript non-Unicode case folding for backreferences.
      const upper = character.toUpperCase();
      return upper.length !== 1 || character.charCodeAt(0) >= 128 && upper.charCodeAt(0) < 128 ? character : upper;
    };
    // Bounded backtracking for backreferences, in ECMAScript priority order.
    // Lookarounds are atomic: a successful positive body keeps its captures.
    // Work and choice-point limits make an exhausted search fail closed.
    function backtrack(run) {
      const { program, value, budget } = run, length = value.length;
      const slots = new Array(program.slots).fill(-1), trail = [];
      const set = (index, item) => { trail.push(index, slots[index]); slots[index] = item; };
      const undo = size => { while (trail.length > size) { const old = trail.pop(); slots[trail.pop()] = old; } };
      function search(pc, pos) {
        const choices = [], base = trail.length;
        for (;;) {
          if (--budget.work < 0) fail('URL matching work limit exceeded.');
          const state = program.ins[pc]; let ok = true;
          if (state.op === 'accept') return pos;
          if (state.op === 'split') {
            for (let i = state.targets.length - 1; i > 0; i--) choices.push(state.targets[i], pos, trail.length);
            if (choices.length > 3 * 65536) fail('URL matching work limit exceeded.');
            pc = state.targets[0]; continue;
          }
          if (state.op === 'char') {
            const at = state.back ? pos - 1 : pos;
            ok = at >= 0 && at < length && state.predicate.test(value[at]);
            if (ok) pos += state.back ? -1 : 1;
          } else if (state.op === 'assert') ok = assertion(state.kind, value, pos);
          else if (state.op === 'open') set(state.pending, pos);
          else if (state.op === 'close') { set(state.start, state.back ? pos : slots[state.pending]); set(state.end, state.back ? slots[state.pending] : pos); }
          else if (state.op === 'reset') { for (const index of state.slots) if (slots[index] !== -1) set(index, -1); }
          else if (state.op === 'mark') set(state.slot, pos);
          else if (state.op === 'progress') ok = slots[state.slot] !== pos;
          else if (state.op === 'backref') {
            // An unset group matches empty; duplicate names use the set one.
            const group = state.groups.find(([from, to]) => slots[from] !== -1 && slots[to] !== -1);
            if (group) {
              const [from, to] = [slots[group[0]], slots[group[1]]], size = to - from, at = state.back ? pos - size : pos;
              budget.work -= size;
              ok = at >= 0 && at + size <= length;
              for (let i = 0; ok && i < size; i++) {
                const a = value[from + i], b = value[at + i];
                ok = a === b || state.icase && canonical(a) === canonical(b);
              }
              if (ok) pos = state.back ? at : at + size;
            }
          } else {
            const look = program.looks[state.look], before = trail.length;
            if ((search(look.start, pos) >= 0) === look.negative) { undo(before); ok = false; }
          }
          if (ok) { pc = state.next; continue; }
          if (!choices.length) { undo(base); return -1; }
          undo(choices.pop()); pos = choices.pop(); pc = choices.pop();
        }
      }
      for (let start = 0; start <= (program.prefix.anchored ? 0 : length); start++) if (search(program.start, start) >= 0) return true;
      return false;
    }
    function regexTest(program, value, budget) {
      const run = { program, value, budget, marks: [] };
      return program.captures ? backtrack(run) : scan(run, program.start, false, true);
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
  const prelude = metadata => {
    const usesSuffixes = [...metadata.matches, ...metadata.excludeMatches].some(value => matcher.matchPattern(value).host.endsWith('.tld')) ||
      [...metadata.includes, ...metadata.excludes].some(value => Boolean(matcher.includePattern(value).host));
    return 'const scopeMatcher=(' + createMatching.toString() + ')(' + JSON.stringify(usesSuffixes ? data : '') + ');\n';
  };
  const rules = metadata => JSON.stringify({ matches: metadata.matches, excludeMatches: metadata.excludeMatches, includes: metadata.includes, excludes: metadata.excludes });
  globalThis.BlockAdsMatching = Object.freeze({ ...matcher, create: createMatching,
    guard: metadata => prelude(metadata) + 'if(!scopeMatcher.allows(' + rules(metadata) + ',location.href))return;',
    // True when the native registration alone enforces the script's scope.
    exact: metadata => {
      const native = matcher.prefilter(metadata);
      return !metadata.includes.length && !metadata.excludes.length && native.excludeMatches.length === metadata.excludeMatches.length &&
        JSON.stringify(native.matches) === JSON.stringify(metadata.matches);
    },
    // Raw @unwrap code cannot be wrapped without changing its global
    // declarations, so it runs as a separate script after this guard. Out of
    // scope, the guard defines a non-configurable global that the raw script
    // also declares with `let`: global declaration instantiation then throws
    // before any statement runs or any binding (var, function, let) is created.
    // An early guard runs in its own document-start registration and keeps
    // its listener until the raw script's error arrives; otherwise the raw
    // script runs synchronously after the guard in the same injection.
    rawGuard: (metadata, name, early) => '(()=>{"use strict";let allowed=false;try{' + prelude(metadata) +
      'allowed=scopeMatcher.allows(' + rules(metadata) + ',location.href);}catch{}\nif(allowed)return;const name=' + JSON.stringify(name) + ';\n' +
      // Hide only the expected redeclaration error from the console and page.
      'const quiet=event=>{if(String(event.message).includes(name)){event.preventDefault();event.stopImmediatePropagation();removeEventListener("error",quiet,true);}};\n' +
      'try{addEventListener("error",quiet,true);' + (early ? '' : 'setTimeout(()=>removeEventListener("error",quiet,true),0);') + '}catch{}\n' +
      'Object.defineProperty(globalThis,name,{value:undefined,configurable:false});})();' });
})();
