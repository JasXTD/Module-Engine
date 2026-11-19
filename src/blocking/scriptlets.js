/* Scriptlet filters. `site##+js(name, arguments)` runs one of the small page
   scripts below in that site's pages. Names, aliases and argument conventions
   follow uBlock Origin's documented filter syntax, so existing filters work;
   the parser and every implementation here are original Module Engine code.

   Arguments are data. They are compared with page values or used as property
   names, CSS selectors and fixed constants; none is ever evaluated, fetched or
   turned into code. Unknown scriptlets, the "trusted" ones that take arbitrary
   values, and calls that would only log are refused, never approximated.

   `select`, `run` and `boot` run in the page and are copied there as source
   text, so they use nothing from this file's scope. */
(() => {
  'use strict';
  const LIMITS = Object.freeze({ body: 1000, args: 12, path: 200 });

  // The text between "+js(" and the final ")" becomes the name and arguments.
  // A comma separates arguments and "\," is a literal comma. An argument may be
  // quoted with ', " or `; a backslash before that quote keeps it, and other
  // backslashes stay, so regular expressions arrive intact. Whitespace around
  // each argument is dropped.
  function splitArguments(text) {
    const args = [], space = /\s/;
    let i = 0;
    for (;;) {
      while (i < text.length && space.test(text[i])) i++;
      const quote = text[i];
      if (quote === "'" || quote === '"' || quote === '`') {
        let value = '', end = i + 1;
        for (; end < text.length && text[end] !== quote; end++) {
          if (text[end] === '\\' && text[end + 1] === quote) end++;
          value += text[end];
        }
        let next = end + 1;
        while (next < text.length && space.test(text[next])) next++;
        // A quote that never closes, or that more text follows, is ordinary text.
        if (end < text.length && (next === text.length || text[next] === ',')) {
          args.push(value);
          if (next === text.length) return args;
          i = next + 1;
          continue;
        }
      }
      let value = '';
      for (; i < text.length && text[i] !== ','; i++) {
        if (text[i] === '\\' && text[i + 1] === ',') i++;
        value += text[i];
      }
      args.push(value.replace(/\s+$/, ''));
      if (i === text.length) return args;
      i++;
    }
  }

  const fail = message => { throw new Error(message); };
  const CONSTANTS = new Set(['undefined', 'false', 'true', 'null', 'noopFunc', 'trueFunc', 'falseFunc', 'throwFunc',
    '', 'emptyStr', '[]', 'emptyArr', '{}', 'emptyObj']);
  // Words set-cookie accepts as values, in any case.
  const COOKIE_WORDS = new Set(['accept', 'reject', 'accepted', 'rejected', 'notaccepted', 'allow', 'disallow', 'deny', 'allowed',
    'denied', 'approved', 'disapproved', 'checked', 'unchecked', 'dismiss', 'dismissed', 'enable', 'disable', 'enabled', 'disabled',
    'essential', 'nonessential', 'forbidden', 'forever', 'hide', 'hidden', 'necessary', 'required', 'ok', 'on', 'off', 'true', 't',
    'false', 'f', 'yes', 'y', 'no', 'n', 'all', 'none', 'functional', 'granted', 'done', 'decline', 'declined', 'closed', 'next',
    'mandatory', 'disagree', 'agree']);
  // The storage scriptlets also accept these, and $remove$ deletes the item.
  const STORAGE_WORDS = new Set(['', 'undefined', 'null', '{}', '[]', 'emptyobj', 'emptyarr', 'emptystr', '$remove$', ...COOKIE_WORDS]);
  const smallInteger = text => /^-?\d{1,5}$/.test(text) && Math.abs(Number(text)) <= 32767;
  const unquoted = text => text.length > 1 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;

  function propertyPath(text) {
    if (!text || text.length > LIMITS.path || !/^[^\s.]+(?:\.[^\s.]+){0,15}$/.test(text)) {
      fail(`"${text}" is not a property path such as adsEnabled or player.config.ads.`);
    }
  }
  // Literal text, or a /regular expression/ with flags. "!" in front negates
  // where the scriptlet allows it.
  function pattern(text, what, negatable = false) {
    const body = negatable && text.startsWith('!') ? text.slice(1) : text;
    const literal = /^\/(.+)\/([a-z]*)$/s.exec(body);
    if (!literal) return;
    if (/[^dgimsuvy]/.test(literal[2])) fail(`The ${what} ${text} uses unknown regular-expression flags.`);
    try { new RegExp(literal[1], literal[2]); } catch { fail(`The ${what} ${text} is not a valid regular expression.`); }
  }
  // Space-separated JSON paths: names joined by dots, [] for every array item and * for every property.
  function jsonPaths(text, what) {
    for (const path of text.split(/\s+/).filter(Boolean)) {
      if (!/^(?:\[\]|\*|[^\s.[\]{}=]+)(?:\.(?:\[\]|\*|[^\s.[\]{}=]+))*$/.test(path)) fail(`The ${what} "${path}" is not a supported JSON path.`);
    }
  }
  function cssSelector(text, what) {
    if (!text.trim() || text.length > 500 || /[{}]|\/\*/.test(text)) fail(`The ${what} "${text}" is not a usable CSS selector.`);
  }
  const responseBody = text => {
    if (['', 'true', 'emptyObj', 'emptyArr', 'emptyStr'].includes(text)) return;
    const length = /^length:(\d{1,6})(?:-(\d{1,6}))?$/.exec(text);
    if (length && Number(length[2] ?? length[1]) <= 500000 && Number(length[1]) <= Number(length[2] ?? length[1])) return;
    fail(`The response "${text}" is unsupported. Use true, emptyObj, emptyArr, emptyStr or length:n.`);
  };
  const requestConditions = (text, names) => {
    if (!text.trim()) fail('Name the requests to stop: part of their address, a /regular expression/ or name:value.');
    for (const token of text.split(/\s+/).filter(Boolean)) {
      const pair = /^([A-Za-z]+):(.*)$/s.exec(token);
      pattern(pair && names.includes(pair[1]) ? pair[2] : token, 'request condition', true);
    }
  };
  const timer = ([text = '', delay = '']) => {
    if (!text && !delay) fail('Give a callback pattern or a delay; calls are not logged.');
    pattern(text, 'callback pattern', true);
    if (delay && !/^!?(?:\d+|\d+-\d*|-\d+)$/.test(delay)) fail(`The delay "${delay}" should be a number of milliseconds or a range such as 1000-5000.`);
  };
  const booster = ([text = '', delay = '', boost = '']) => {
    pattern(text, 'callback pattern');
    if (delay && delay !== '*' && !/^\d+$/.test(delay)) fail(`The delay "${delay}" should be a number of milliseconds or *.`);
    if (boost && !(/^\d*\.?\d+$/.test(boost) && Number(boost) > 0)) fail(`The factor "${boost}" should be a positive number.`);
  };
  const one = value => { if (!['0', '1', ''].includes(value)) fail(`Expected 1 or 0, found "${value}".`); };
  const milliseconds = value => { if (!/^\d{1,7}$/.test(value)) fail(`Expected milliseconds, found "${value}".`); };
  const storage = ([key, value]) => {
    if (!unquoted(key) || unquoted(key).length > 256) fail('Name the storage item to set.');
    if (!STORAGE_WORDS.has(value.toLowerCase()) && !smallInteger(value)) fail(`The value "${value}" is not one of the fixed values storage items may be given.`);
  };
  const classOrAttributes = (names, what, check) => {
    const list = names.split('|').map(name => name.trim());
    if (!list.length || list.some(name => !check.test(name))) fail(`List ${what} separated by |, such as one|two.`);
  };
  const behaviour = text => {
    if (text.split(/\s+/).filter(Boolean).some(word => !['asap', 'stay', 'complete'].includes(word))) fail(`Unknown timing "${text}"; use asap, stay or complete.`);
  };

  // name: { aliases, params (positional count), required, check(positional), named: { option: check } }
  const SCRIPTLETS = {
    'set-constant': { aliases: ['set'], params: 2, required: 2, check([path, value]) {
      propertyPath(path);
      if (!CONSTANTS.has(value) && !smallInteger(value)) fail(`The value "${value}" is not a constant set-constant supports.`);
    } },
    'abort-on-property-read': { aliases: ['aopr'], params: 1, required: 1, check: ([path]) => propertyPath(path) },
    'abort-on-property-write': { aliases: ['aopw'], params: 1, required: 1, check: ([path]) => propertyPath(path) },
    'abort-current-script': { aliases: ['acs', 'abort-current-inline-script', 'acis'], params: 3, required: 1, check([path, text = '', source = '']) {
      propertyPath(path); pattern(text, 'script text pattern'); pattern(source, 'script address pattern');
    } },
    'json-prune': { params: 3, required: 1, check([prune, need = '', stack = '']) {
      if (!prune.trim()) fail('Name the JSON properties to remove; calls are not logged.');
      jsonPaths(prune, 'property');
      if (/^\/.*\/[a-z]*$/s.test(need)) fail('json-prune logging is unsupported; give the properties that must be present.');
      jsonPaths(need, 'required property');
      pattern(stack, 'stack pattern', true);
    } },
    'no-setTimeout-if': { aliases: ['nostif', 'prevent-setTimeout', 'setTimeout-defuser'], params: 2, required: 0, check: timer },
    'no-setInterval-if': { aliases: ['nosiif', 'prevent-setInterval', 'setInterval-defuser'], params: 2, required: 0, check: timer },
    'no-requestAnimationFrame-if': { aliases: ['norafif', 'prevent-requestAnimationFrame'], params: 1, required: 0, check([text = '']) {
      if (!text) fail('Give a callback pattern; calls are not logged.');
      pattern(text, 'callback pattern', true);
    } },
    'nano-setInterval-booster': { aliases: ['nano-sib', 'adjust-setInterval'], params: 3, required: 0, check: booster },
    'nano-setTimeout-booster': { aliases: ['nano-stb', 'adjust-setTimeout'], params: 3, required: 0, check: booster },
    'addEventListener-defuser': { aliases: ['aeld', 'prevent-addEventListener'], params: 2, required: 0,
      named: { elements: value => { if (!['window', 'document'].includes(value)) cssSelector(value, 'element selector'); } },
      check([type = '', handler = '']) {
        if (!type && !handler) fail('Give an event type or a handler pattern; calls are not logged.');
        pattern(type, 'event type'); pattern(handler, 'handler pattern');
      } },
    'no-fetch-if': { aliases: ['prevent-fetch'], params: 3, required: 1, check([conditions, body = '', props = '']) {
      requestConditions(conditions, ['url', 'method', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive']);
      responseBody(body);
      if (!props) return;
      let value;
      try { value = JSON.parse(props); } catch { fail('Response properties must be JSON, such as {"ok":false}.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Response properties must be a JSON object.');
      for (const [key, item] of Object.entries(value)) {
        if (key === 'ok' ? typeof item !== 'boolean' : key === 'type' ? !['basic', 'cors', 'default', 'error', 'opaque'].includes(item)
          : key === 'statusText' ? typeof item !== 'string' || item.length > 100 || /[\u0000-\u001f\u007f]/.test(item) : true) {
          fail(`The response property ${key} is unsupported or has an invalid value.`);
        }
      }
    } },
    'no-xhr-if': { aliases: ['prevent-xhr'], params: 2, required: 1, check([conditions, body = '']) {
      requestConditions(conditions, ['url', 'method']); responseBody(body);
    } },
    'no-window-open-if': { aliases: ['nowoif', 'prevent-window-open', 'window.open-defuser'], params: 3, required: 0, check([text = '', delay = '', decoy = '']) {
      pattern(text, 'address pattern', true);
      if (delay && !/^\d{1,4}$/.test(delay)) fail(`The delay "${delay}" should be a number of seconds.`);
      if (!['', 'obj', 'blank'].includes(decoy)) fail(`Unknown decoy "${decoy}".`);
    } },
    'remove-attr': { aliases: ['ra'], params: 3, required: 1, check([names, selector = '', timing = '']) {
      classOrAttributes(names, 'attribute names', /^[A-Za-z_][\w.:-]*$/);
      if (selector) cssSelector(selector, 'selector');
      behaviour(timing);
    } },
    'remove-class': { aliases: ['rc'], params: 3, required: 1, check([names, selector = '', timing = '']) {
      classOrAttributes(names, 'class names', /^[^\s|]+$/);
      if (selector) cssSelector(selector, 'selector');
      behaviour(timing);
    } },
    'remove-node-text': { aliases: ['rmnt'], params: 2, required: 2, named: { stay: one, quitAfter: milliseconds }, check([node, text]) {
      if (!/^(?:#text|[A-Za-z][A-Za-z0-9-]*)$/.test(node)) fail(`"${node}" is not an element name or #text.`);
      if (!text) fail('Give the text to remove.');
      pattern(text, 'text pattern');
    } },
    'noeval': { aliases: ['noeval-silent', 'silent-noeval'], params: 0, required: 0 },
    'noeval-if': { aliases: ['prevent-eval-if'], params: 1, required: 1, check([text]) {
      if (!text) fail('Give a code pattern; calls are not logged.');
      pattern(text, 'code pattern');
    } },
    'set-local-storage-item': { params: 2, required: 2, check: storage },
    'set-session-storage-item': { params: 2, required: 2, check: storage },
    'set-cookie': { params: 3, required: 2, named: { reload: one, dontOverwrite: one }, check([name, value, path = '']) {
      if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}$/.test(name)) fail(`"${name}" is not a cookie name.`);
      const plain = unquoted(value);
      if (!COOKIE_WORDS.has(plain.toLowerCase()) && !smallInteger(plain)) fail(`The value "${value}" is not one of the fixed values set-cookie may set.`);
      if (path && path !== 'none' && !/^\/[^;\s]*$/.test(path)) fail(`The path "${path}" should start with / or be none.`);
    } },
    'alert-buster': { params: 0, required: 0 }
  };
  const ALIASES = new Map();
  for (const [name, spec] of Object.entries(SCRIPTLETS)) for (const alias of [name, ...(spec.aliases || [])]) ALIASES.set(alias, name);
  // Canonical names with their aliases, for the editor and the guide.
  const NAMES = Object.freeze(Object.fromEntries(Object.entries(SCRIPTLETS).map(([name, spec]) => [name, Object.freeze([...(spec.aliases || [])])])));

  // `+js(name, arguments)` as { name, args }; `+js()` is { name: '', args: [] },
  // which an exception uses to turn off every scriptlet on its sites.
  function parseBody(body) {
    if (typeof body !== 'string' || !body.startsWith('+js(') || !body.endsWith(')')) fail('A scriptlet filter looks like +js(name, arguments).');
    if (body.length > LIMITS.body) fail(`A scriptlet filter is limited to ${LIMITS.body} characters.`);
    if (/[\u0000-\u001f\u007f]/.test(body)) fail('A scriptlet filter cannot contain control characters.');
    const inner = body.slice(4, -1);
    if (!inner.trim()) return { name: '', args: [] };
    const [token, ...args] = splitArguments(inner);
    const given = token.endsWith('.js') ? token.slice(0, -3) : token;
    const name = ALIASES.get(given);
    if (!name) {
      fail(given.startsWith('trusted-') ? `"${given}" takes arbitrary values, so it is not supported.`
        : `Unknown or unsupported scriptlet "${given}". The user guide lists the supported ones.`);
    }
    const spec = SCRIPTLETS[name];
    if (args.length > LIMITS.args) fail(`A scriptlet takes at most ${LIMITS.args} arguments.`);
    const positional = args.slice(0, spec.params), named = args.slice(spec.params);
    if (positional.length < spec.required) fail(`${name} needs ${spec.required} argument${spec.required === 1 ? '' : 's'}.`);
    if (named.length % 2) fail(`${name} takes ${spec.params} argument${spec.params === 1 ? '' : 's'}, then options as name, value pairs.`);
    for (let i = 0; i < named.length; i += 2) {
      const check = Object.hasOwn(spec.named || {}, named[i]) ? spec.named[named[i]] : null;
      if (!check) fail(`${name} does not support the option "${named[i]}".`);
      check(named[i + 1]);
    }
    spec.check?.(positional);
    return { name, args };
  }

  // The calls for one hostname: rules whose sites include it, minus exact
  // exceptions; an exception without a name turns them all off. Rules are
  // { include, exclude, exception, name, args }. Runs in the page as well.
  function select(rules, hostname) {
    'use strict';
    const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
    if (!host || !Array.isArray(rules)) return [];
    const within = domain => host === domain || host.endsWith('.' + domain);
    const calls = new Map(), cancelled = new Set();
    for (const rule of rules) {
      if (!rule || !Array.isArray(rule.include) || !Array.isArray(rule.exclude) || !Array.isArray(rule.args) || typeof rule.name !== 'string') continue;
      if (rule.include.length ? !rule.include.some(within) : !rule.exception) continue;
      if (rule.exclude.some(within)) continue;
      const key = JSON.stringify([rule.name, ...rule.args]);
      if (!rule.exception) { if (rule.name && !calls.has(key)) calls.set(key, { name: rule.name, args: rule.args.slice() }); }
      else if (!rule.name) return [];
      else cancelled.add(key);
    }
    return [...calls].filter(([key]) => !cancelled.has(key)).map(([, call]) => call);
  }

  // Runs the selected scriptlets in the page (main world). It reads the page's
  // own built-ins once, when it starts, so later page changes to them do not
  // reach its helpers. Each call is independent: one that fails changes nothing.
  function run(calls) {
    'use strict';
    if (!Array.isArray(calls) || !calls.length) return;
    const win = globalThis, doc = win.document;
    const define = win.Object.defineProperty, describe = win.Object.getOwnPropertyDescriptor, keysOf = win.Object.keys;
    const hasOwn = win.Object.prototype.hasOwnProperty, apply = win.Reflect.apply, Wrap = win.Proxy;
    const fnSource = win.Function.prototype.toString, regexTest = win.RegExp.prototype.test, includes = win.String.prototype.includes;
    const later = win.setTimeout, listen = win.EventTarget.prototype.addEventListener;
    const isObject = value => value !== null && (typeof value === 'object' || typeof value === 'function');
    const noop = function () {};
    const text = value => {
      try { return typeof value === 'function' ? apply(fnSource, value, []) : win.String(value); } catch { return ''; }
    };
    // Literal text or /regex/flags; empty matches everything; "!" negates where allowed.
    const matcher = (source = '', negatable = false) => {
      let negate = false;
      if (negatable && source.startsWith('!')) { negate = true; source = source.slice(1); }
      let test = () => true;
      const literal = /^\/(.+)\/([a-z]*)$/s.exec(source);
      if (literal) {
        let expression = null;
        try { expression = new win.RegExp(literal[1], literal[2].replace(/[gy]/g, '')); } catch { /* Never matches. */ }
        test = value => expression !== null && apply(regexTest, expression, [text(value)]);
      } else if (source) test = value => apply(includes, text(value), [source]);
      return negate ? value => !test(value) : test;
    };
    // Aborted scripts end with an uncaught ReferenceError; keep those out of the
    // page's error handlers and console.
    const magic = 'ModuleEngine' + win.Math.random().toString(36).slice(2);
    if (calls.some(call => ['abort-on-property-read', 'abort-on-property-write', 'abort-current-script'].includes(call?.name))) {
      try {
        apply(listen, win, ['error', event => {
          if (apply(includes, text(event.message), [magic])) { event.preventDefault(); event.stopImmediatePropagation(); }
        }, true]);
      } catch { /* Errors stay visible. */ }
    }
    const abort = () => new win.ReferenceError(magic);

    // Applies `last(owner, key)` at the end of `path`, starting at the window.
    // A missing object along the way is watched, and the rest of the path is
    // applied to whatever object the page puts there.
    const onPath = (owner, path, last) => {
      const dot = path.indexOf('.');
      if (dot < 0) { last(owner, path); return; }
      const key = path.slice(0, dot), rest = path.slice(dot + 1);
      let value;
      try { value = owner[key]; } catch { return; }
      if (isObject(value)) { onPath(value, rest, last); return; }
      const before = describe(owner, key);
      if (before && !before.configurable) return;
      try {
        define(owner, key, { configurable: true, enumerable: before ? before.enumerable : true,
          get() { return value; },
          set(next) { value = next; if (isObject(next)) onPath(next, rest, last); } });
      } catch { /* The page owns this property. */ }
    };
    const current = (owner, key, before) => {
      try { return before ? ('value' in before ? before.value : before.get ? apply(before.get, owner, []) : undefined) : owner[key]; } catch { return undefined; }
    };
    const constant = raw => {
      if (/^-?\d+$/.test(raw)) return win.Number(raw);
      switch (raw) {
        case 'undefined': return undefined;
        case 'null': return null;
        case 'true': return true;
        case 'false': return false;
        case 'noopFunc': return function () {};
        case 'trueFunc': return function () { return true; };
        case 'falseFunc': return function () { return false; };
        case 'throwFunc': return function () { throw new win.Error(); };
        case '[]': case 'emptyArr': return [];
        case '{}': case 'emptyObj': return {};
        default: return '';
      }
    };
    function setConstant(path, raw) {
      const value = constant(raw);
      onPath(win, path, (owner, key) => {
        const before = describe(owner, key);
        if (before && !before.configurable) return;
        // Never change a property to a value of another type.
        const old = before && 'value' in before ? before.value : undefined;
        if (old !== undefined && old !== null && value !== undefined && value !== null && typeof old !== typeof value) return;
        try { define(owner, key, { configurable: false, enumerable: before ? before.enumerable : true, get() { return value; }, set() {} }); }
        catch { /* The page owns this property. */ }
      });
    }
    function abortOnRead(path) {
      onPath(win, path, (owner, key) => {
        const before = describe(owner, key);
        if (before && !before.configurable) return;
        try { define(owner, key, { configurable: false, get() { throw abort(); }, set() {} }); } catch { /* The page owns this property. */ }
      });
    }
    function abortOnWrite(path) {
      onPath(win, path, (owner, key) => {
        const before = describe(owner, key);
        if (before && !before.configurable) return;
        const value = current(owner, key, before);
        try { define(owner, key, { configurable: false, get() { return value; }, set() { throw abort(); } }); } catch { /* The page owns this property. */ }
      });
    }
    const scriptGetter = describe(win.Document.prototype, 'currentScript')?.get;
    const currentScript = () => { try { return scriptGetter ? apply(scriptGetter, doc, []) : null; } catch { return null; } };
    // An inline script's text, or the decoded body of a data: script.
    const scriptText = script => {
      const inline = text(script.textContent);
      if (inline.trim()) return inline;
      const source = text(script.src), data = /^data:([^,]*),/i.exec(source);
      if (!data) return '';
      try { return /;base64$/i.test(data[1]) ? win.atob(source.slice(data[0].length)) : win.decodeURIComponent(source.slice(data[0].length)); } catch { return ''; }
    };
    function abortCurrentScript(path, needle = '', source = '') {
      const matchesText = matcher(needle), matchesSource = matcher(source), self = currentScript(), Script = win.HTMLScriptElement;
      onPath(win, path, (owner, key) => {
        const before = describe(owner, key);
        if (before && !before.configurable) return;
        let value = current(owner, key, before);
        const getter = before?.get, setter = before?.set;
        const check = () => {
          const script = currentScript();
          if (!(script instanceof Script) || script === self) return;
          if (source) {
            let address = text(script.src);
            try { address = win.decodeURIComponent(address); } catch { /* Keep it encoded. */ }
            if (!matchesSource(address)) return;
          }
          if (needle && !matchesText(scriptText(script))) return;
          throw abort();
        };
        try {
          // Configurable, so scripts this does not target keep their normal access.
          define(owner, key, { configurable: true, enumerable: before ? before.enumerable : true,
            get() { check(); return getter ? apply(getter, this, []) : value; },
            set(next) { check(); if (setter) apply(setter, this, [next]); else value = next; } });
        } catch { /* The page owns this property. */ }
      });
    }

    // [owner, key] pairs a JSON path reaches: [] is every array item, * every property.
    const reach = (root, segments, visit, depth = 0) => {
      if (!isObject(root) || depth > 32) return;
      const [head, ...rest] = segments;
      const names = head === '[]' ? (win.Array.isArray(root) ? keysOf(root) : []) : head === '*' ? keysOf(root) : [head];
      for (const name of names) {
        if (!apply(hasOwn, root, [name])) continue;
        if (!rest.length) visit(root, name);
        else reach(root[name], rest, visit, depth + 1);
      }
    };
    const paths = value => value.split(/\s+/).filter(Boolean).map(path => path.split('.'));
    function jsonPrune(prune, need = '', stack = '') {
      const removals = paths(prune), required = paths(need), inStack = matcher(stack, true);
      const clean = result => {
        try {
          if (!isObject(result) || stack && !inStack(new win.Error().stack)) return result;
          for (const path of required) {
            let found = false;
            reach(result, path, () => { found = true; });
            if (!found) return result;
          }
          for (const path of removals) {
            const found = [];
            reach(result, path, (owner, key) => { found.push([owner, key]); });
            // Last first, so array items are taken out without leaving holes.
            for (let i = found.length - 1; i >= 0; i--) {
              const [owner, key] = found[i];
              try { if (win.Array.isArray(owner) && /^\d+$/.test(key)) owner.splice(win.Number(key), 1); else delete owner[key]; } catch { /* Read-only. */ }
            }
          }
        } catch { /* Leave the data as parsed. */ }
        return result;
      };
      try { win.JSON.parse = new Wrap(win.JSON.parse, { apply: (target, self, args) => clean(apply(target, self, args)) }); } catch { /* Read-only. */ }
      const proto = win.Response?.prototype, then = win.Promise.prototype.then;
      if (typeof proto?.json === 'function') {
        try { proto.json = new Wrap(proto.json, { apply: (target, self, args) => apply(then, apply(target, self, args), [clean]) }); } catch { /* Read-only. */ }
      }
    }

    // Delays: n, min-max, min-, -max; "!" negates. Empty matches any delay.
    const delays = spec => {
      if (!spec) return () => true;
      const negate = spec.startsWith('!'), body = negate ? spec.slice(1) : spec;
      const [low, high] = body.includes('-') ? body.split('-') : [body, body];
      const min = low === '' ? -Infinity : win.Number(low), max = high === '' ? Infinity : win.Number(high);
      const test = value => { const ms = win.Number(value) || 0; return ms >= min && ms <= max; };
      return negate ? value => !test(value) : test;
    };
    const wrapGlobal = (name, handler) => {
      const native = win[name];
      if (typeof native !== 'function') return;
      try { win[name] = new Wrap(native, { apply: handler }); } catch { /* Read-only. */ }
    };
    function defuseTimer(name, needle = '', delay = '') {
      const matches = matcher(needle, true), within = delays(delay);
      // The timer still starts, with a callback that does nothing, so its ID stays valid.
      wrapGlobal(name, (target, self, args) => apply(target, self, matches(args[0]) && within(args[1]) ? [noop, ...args.slice(1)] : args));
    }
    function boostTimer(name, needle = '', delay = '', boost = '') {
      const matches = matcher(needle), wanted = delay === '*' ? null : win.Number(delay || 1000);
      const factor = win.Math.min(50, win.Math.max(0.02, win.Number(boost || 0.05) || 0.05));
      wrapGlobal(name, (target, self, args) => apply(target, self, matches(args[0]) && (wanted === null || win.Number(args[1]) === wanted)
        ? [args[0], (win.Number(args[1]) || 0) * factor, ...args.slice(2)] : args));
    }
    function defuseFrames(needle) {
      const matches = matcher(needle, true);
      wrapGlobal('requestAnimationFrame', (target, self, args) => apply(target, self, matches(args[0]) ? [noop] : args));
    }
    function defuseListeners(type = '', handler = '', ...options) {
      const matchesType = matcher(type), matchesHandler = matcher(handler);
      let elements = null;
      for (let i = 0; i < options.length; i += 2) if (options[i] === 'elements') elements = options[i + 1];
      const matchesTarget = target => {
        if (elements === null) return true;
        if (elements === 'window') return target === win;
        if (elements === 'document') return target === doc;
        try { return target instanceof win.Element && target.matches(elements); } catch { return false; }
      };
      const handlerText = listener => typeof listener === 'function' ? text(listener)
        : isObject(listener) && typeof listener.handleEvent === 'function' ? text(listener.handleEvent) : text(listener);
      const proto = win.EventTarget.prototype;
      try {
        proto.addEventListener = new Wrap(proto.addEventListener, { apply(target, self, args) {
          try { if (matchesType(args[0]) && matchesHandler(handlerText(args[1])) && matchesTarget(self)) return undefined; } catch { /* Register it. */ }
          return apply(target, self, args);
        } });
      } catch { /* Read-only. */ }
    }

    // Request conditions: every space-separated part must match. name:value
    // compares one request property; anything else compares the address.
    const conditions = (spec, names) => spec.split(/\s+/).filter(Boolean).map(token => {
      const pair = /^([A-Za-z]+):(.*)$/s.exec(token);
      return pair && names.includes(pair[1]) ? { key: pair[1], test: matcher(pair[2], true) } : { key: 'url', test: matcher(token, true) };
    });
    const randomText = length => {
      let out = '';
      while (out.length < length) out += win.Math.random().toString(36).slice(2);
      return out.slice(0, length);
    };
    const responseText = directive => {
      if (directive === 'true') return randomText(10);
      if (directive === 'emptyObj') return '{}';
      if (directive === 'emptyArr') return '[]';
      const length = /^length:(\d+)(?:-(\d+))?$/.exec(directive);
      if (!length) return '';
      const min = win.Number(length[1]), max = win.Number(length[2] ?? length[1]);
      return randomText(min + win.Math.floor(win.Math.random() * (max - min + 1)));
    };
    const address = value => { try { return new win.URL(text(value), doc.baseURI).href; } catch { return text(value); } };
    const FETCH = ['method', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive'];
    function preventFetch(spec, directive = '', props = '') {
      const tests = conditions(spec, ['url', ...FETCH]), Request = win.Request, Response = win.Response, resolve = win.Promise.resolve.bind(win.Promise);
      let extra = {};
      try { extra = props ? win.JSON.parse(props) : {}; } catch { return; }
      if (typeof Response !== 'function') return;
      wrapGlobal('fetch', (target, self, args) => {
        const details = { url: '', method: 'GET' };
        try {
          const [input, init] = args;
          if (typeof Request === 'function' && input instanceof Request) {
            details.url = input.url;
            for (const key of FETCH) if (key !== 'body' && key in input) details[key] = input[key];
          } else details.url = address(input);
          if (isObject(init)) for (const key of FETCH) if (key in init) details[key] = init[key];
          details.method = text(details.method).toUpperCase();
          if (!tests.every(({ key, test }) => test(details[key] ?? ''))) return apply(target, self, args);
          const response = new Response(responseText(directive), { status: 200, statusText: typeof extra.statusText === 'string' ? extra.statusText : 'OK' });
          define(response, 'url', { value: details.url });
          define(response, 'type', { value: typeof extra.type === 'string' ? extra.type : 'basic' });
          if (typeof extra.ok === 'boolean') define(response, 'ok', { value: extra.ok });
          return resolve(response);
        } catch { return apply(target, self, args); }
      });
    }
    function preventXhr(spec, directive = '') {
      const tests = conditions(spec, ['url', 'method']), XHR = win.XMLHttpRequest;
      if (typeof XHR !== 'function') return;
      const proto = XHR.prototype, stopped = new win.WeakMap();
      const wrap = (name, handler) => { try { proto[name] = new Wrap(proto[name], { apply: handler }); } catch { /* Read-only. */ } };
      wrap('open', (target, self, args) => {
        try {
          const details = { method: text(args[0]).toUpperCase(), url: address(args[1]), async: args.length < 3 || win.Boolean(args[2]) };
          if (tests.every(({ key, test }) => test(details[key]))) stopped.set(self, details); else stopped.delete(self);
        } catch { stopped.delete(self); }
        return apply(target, self, args);
      });
      wrap('abort', (target, self, args) => { stopped.delete(self); return apply(target, self, args); });
      wrap('send', (target, self, args) => {
        const details = stopped.get(self);
        if (!details) return apply(target, self, args);
        // Complete as an empty, successful response without contacting the server.
        const body = responseText(directive);
        const finish = () => {
          if (stopped.get(self) !== details) return;
          let type = '';
          try { type = self.responseType || ''; } catch { /* Default text. */ }
          let response = body;
          if (type === 'json') { try { response = win.JSON.parse(body); } catch { response = null; } }
          else if (type !== '' && type !== 'text') response = null;
          const value = item => ({ value: item, configurable: true });
          try {
            win.Object.defineProperties(self, { readyState: value(4), status: value(200), statusText: value('OK'), response: value(response),
              responseURL: value(details.url), responseXML: value(null), ...(type === '' || type === 'text' ? { responseText: value(body) } : {}) });
          } catch { return; }
          for (const name of ['readystatechange', 'load', 'loadend']) {
            try { self.dispatchEvent(name === 'readystatechange' ? new win.Event(name) : new win.ProgressEvent(name, { lengthComputable: true, loaded: body.length, total: body.length })); }
            catch { /* A listener failed. */ }
          }
        };
        if (details.async) apply(later, win, [finish, 1]); else finish();
        return undefined;
      });
    }
    function preventWindowOpen(needle = '') {
      const matches = matcher(needle, true);
      // As when the browser blocks a pop-up, the page receives no window.
      wrapGlobal('open', (target, self, args) => {
        const parts = [];
        for (const arg of args) parts.push(text(arg));
        return matches(parts.join(' ')) ? null : apply(target, self, args);
      });
    }

    // Repeats `act` on the elements matching `selector`, as the page changes,
    // from a start that depends on `timing` (asap, stay, complete).
    function sweepElements(selector, act, timing, attributes) {
      const words = timing.split(/\s+/), stay = words.includes('stay'), asap = words.includes('asap'), complete = words.includes('complete');
      let observer = null, queued = false, stopped = false;
      const stop = () => { stopped = true; observer?.disconnect(); observer = null; };
      const sweep = () => {
        queued = false;
        if (stopped) return;
        let nodes;
        try { nodes = doc.querySelectorAll(selector); } catch { stop(); return; }
        for (const node of nodes) { try { act(node); } catch { /* Leave this element. */ } }
      };
      // Watches until the page has loaded, or for as long as it is open with `stay`.
      const start = () => {
        if (stopped) return;
        sweep();
        if (typeof win.MutationObserver === 'function') {
          observer = new win.MutationObserver(() => { if (!queued) { queued = true; apply(later, win, [sweep, 0]); } });
          observer.observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: attributes });
        }
        if (stay) return;
        if (doc.readyState === 'complete') stop();
        else apply(listen, win, ['load', () => apply(later, win, [() => { sweep(); stop(); }, 0]), { once: true }]);
      };
      if (complete) { if (doc.readyState === 'complete') start(); else apply(listen, win, ['load', start, { once: true }]); }
      else if (asap || doc.readyState !== 'loading') start();
      else apply(listen, doc, ['DOMContentLoaded', start, { once: true }]);
    }
    const escape = value => win.CSS?.escape ? win.CSS.escape(value) : value;
    function removeAttributes(names, selector = '', timing = '') {
      const list = names.split('|').map(name => name.trim());
      sweepElements(selector || list.map(name => '[' + escape(name) + ']').join(','), node => { for (const name of list) node.removeAttribute(name); },
        timing, list.map(name => name.toLowerCase()));
    }
    function removeClasses(names, selector = '', timing = '') {
      const list = names.split('|').map(name => name.trim());
      sweepElements(selector || list.map(name => '.' + escape(name)).join(','), node => { for (const name of list) node.classList.remove(name); }, timing, ['class']);
    }
    // Clears matching text as the parser adds it. A script emptied before it
    // runs does nothing; this needs the document-start registration.
    function removeNodeText(nodeName, needle, ...options) {
      const name = nodeName.toLowerCase(), matches = matcher(needle);
      let stay = false, quitAfter = 0;
      for (let i = 0; i < options.length; i += 2) {
        if (options[i] === 'stay') stay = options[i + 1] === '1';
        if (options[i] === 'quitAfter') quitAfter = win.Number(options[i + 1]) || 0;
      }
      const check = node => {
        try {
          if (!node || node.nodeName.toLowerCase() !== name) return;
          if (name === '#text') { if (matches(node.nodeValue)) node.nodeValue = ''; }
          else if (matches(node.textContent)) node.textContent = '';
        } catch { /* Leave this node. */ }
      };
      if (typeof win.MutationObserver !== 'function') return;
      const observer = new win.MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            check(node);
            if (name !== '#text' && node.nodeType === 3) check(node.parentNode);
          }
        }
      });
      observer.observe(doc, { childList: true, subtree: true });
      try {
        if (name === '#text') {
          const walker = doc.createTreeWalker(doc, 4);
          while (walker.nextNode()) check(walker.currentNode);
        } else for (const node of doc.querySelectorAll(name)) check(node);
      } catch { /* Only new nodes. */ }
      const stop = () => observer.disconnect();
      if (quitAfter) apply(later, win, [stop, quitAfter]);
      if (!stay) {
        if (doc.readyState === 'loading') apply(listen, doc, ['DOMContentLoaded', stop, { once: true }]);
        else stop();
      }
    }
    function preventEval(needle = '') {
      const matches = matcher(needle);
      wrapGlobal('eval', (target, self, args) => matches(args[0]) ? undefined : apply(target, self, args));
    }
    function alertBuster() {
      wrapGlobal('alert', (_target, _self, args) => {
        try { win.console.info('[Module Engine] Stopped an alert:', text(args[0])); } catch { /* No console. */ }
        return undefined;
      });
    }
    function setStorageItem(kind, key, raw) {
      let store;
      try { store = win[kind]; } catch { return; }
      if (!store) return;
      const name = key.length > 1 && key.startsWith('"') && key.endsWith('"') ? key.slice(1, -1) : key;
      const word = raw.toLowerCase();
      try {
        if (word === '$remove$') store.removeItem(name);
        else store.setItem(name, word === 'emptyarr' ? '[]' : word === 'emptyobj' ? '{}' : word === 'emptystr' ? '' : raw);
      } catch { /* Storage is full or blocked. */ }
    }
    function setCookie(name, raw, path = '', ...options) {
      let reload = false, keep = false;
      for (let i = 0; i < options.length; i += 2) {
        if (options[i] === 'reload') reload = options[i + 1] === '1';
        if (options[i] === 'dontOverwrite') keep = options[i + 1] === '1';
      }
      const value = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
      const read = () => {
        let all = '';
        try { all = doc.cookie; } catch { return null; }
        for (const part of all.split(';')) {
          const index = part.indexOf('='), key = (index < 0 ? part : part.slice(0, index)).trim();
          if (key === name) return index < 0 ? '' : part.slice(index + 1).trim();
        }
        return null;
      };
      const before = read();
      if (before === value || before !== null && keep) return;
      const attributes = path === 'none' ? [] : ['path=' + (path || '/')];
      if (/^__(?:Secure|Host)-/.test(name)) attributes.push('Secure');
      try { doc.cookie = [name + '=' + value, ...attributes].join('; '); } catch { return; }
      // Reload once, after the cookie actually changed, so the site reads it.
      if (reload && read() === value) win.location.reload();
    }

    const table = new win.Map([
      ['set-constant', setConstant], ['abort-on-property-read', abortOnRead], ['abort-on-property-write', abortOnWrite],
      ['abort-current-script', abortCurrentScript], ['json-prune', jsonPrune],
      ['no-setTimeout-if', (needle, delay) => defuseTimer('setTimeout', needle, delay)],
      ['no-setInterval-if', (needle, delay) => defuseTimer('setInterval', needle, delay)],
      ['no-requestAnimationFrame-if', defuseFrames],
      ['nano-setTimeout-booster', (needle, delay, boost) => boostTimer('setTimeout', needle, delay, boost)],
      ['nano-setInterval-booster', (needle, delay, boost) => boostTimer('setInterval', needle, delay, boost)],
      ['addEventListener-defuser', defuseListeners], ['no-fetch-if', preventFetch], ['no-xhr-if', preventXhr],
      ['no-window-open-if', preventWindowOpen], ['remove-attr', removeAttributes], ['remove-class', removeClasses],
      ['remove-node-text', removeNodeText], ['noeval', () => preventEval()], ['noeval-if', preventEval], ['alert-buster', alertBuster],
      ['set-local-storage-item', (key, value) => setStorageItem('localStorage', key, value)],
      ['set-session-storage-item', (key, value) => setStorageItem('sessionStorage', key, value)],
      ['set-cookie', setCookie]
    ]);
    for (const call of calls) {
      const scriptlet = table.get(call?.name);
      if (!scriptlet || !win.Array.isArray(call.args) || !call.args.every(arg => typeof arg === 'string')) continue;
      try { apply(scriptlet, undefined, call.args); } catch { /* The other scriptlets still run. */ }
    }
  }

  // The document-start registration's entry point. A frame learns its top
  // page's origin from location.ancestorOrigins where the browser provides it,
  // so a frame of a paused page runs nothing.
  function boot(select, run, rules, paused) {
    'use strict';
    try {
      const ancestors = location.ancestorOrigins;
      if (ancestors && ancestors.length) {
        let top = '';
        try { top = new URL(ancestors[ancestors.length - 1]).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* Opaque origin. */ }
        if (top && paused.some(domain => top === domain || top.endsWith('.' + domain))) return;
      }
      run(select(rules, location.hostname));
    } catch { /* The page continues without scriptlets. */ }
  }

  // Source text for a document-start registration: every rule, chosen per
  // frame by its own hostname. `paused` is the sites whose frames run nothing.
  const code = (rules, paused = []) => `(${boot})(${select}, ${run}, ${JSON.stringify(rules)}, ${JSON.stringify(paused)});\n`;

  globalThis.BlockAdsScriptlets = Object.freeze({ parseBody, splitArguments, select, run, boot, code, NAMES, LIMITS });
})();
