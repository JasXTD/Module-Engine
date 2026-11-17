/* Original cosmetic-rule handling. Selectors are data, never executable code. */
(() => {
  "use strict";
  const matches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  const LIMITS = Object.freeze({ text: 100000, rules: 500, selector: 1000 });
  const PROCEDURAL_NAME = /^(?:-abp-|has-text|contains|xpath|matches-|upward|min-text-length|watch-attr|others|remove|style|if$|if-not|nth-ancestor)/i;
  const OPERATORS = new Set(['has', '-abp-has', 'has-text', '-abp-contains', 'upward']);
  const DESCENDANT_OPERATOR = 'Procedural operators must follow their CSS subject directly; a space or combinator before an operator (descendant matching) is unsupported.';
  // True when the text ends in an unescaped combinator: whitespace, >, + or ~.
  function endsWithCombinator(text) {
    if (!/[\s>+~]$/.test(text)) return false;
    let slashes = 0;
    for (let i = text.length - 2; i >= 0 && text[i] === '\\'; i--) slashes++;
    return slashes % 2 === 0;
  }

  // Inspect syntax outside strings and attribute selectors. A procedural-looking
  // string in an attribute is just data. No filter text is ever evaluated as JS.
  function syntax(text) {
    const functions = [], commas = [];
    let quote = '', square = 0, depth = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '\\') { i++; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '[') square++;
      else if (char === ']') square--;
      if (square) continue;
      if (char === ':' && /^:([a-zA-Z-]+)\(/.test(text.slice(i))) {
        const match = /^:([a-zA-Z-]+)\(/.exec(text.slice(i));
        functions.push({ name: match[1], index: i, depth });
      }
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && !depth) commas.push(i);
    }
    return { functions, commas };
  }

  function envelope(selector) {
    if (typeof selector !== 'string' || !selector.trim() || selector.length > LIMITS.selector ||
        /[{}\u0000-\u001f]|\/\*|\*\//.test(selector) || selector.startsWith('+js(')) {
      throw new Error('Invalid selector: scripts, declarations and control characters are unsupported.');
    }
  }

  function safeSelector(selector) {
    envelope(selector);
    if (syntax(selector).functions.some(fn => PROCEDURAL_NAME.test(fn.name))) throw new Error('Unsupported operator in a plain CSS selector.');
    // Reject unbalanced syntax even in a worker, which has no CSS parser.
    const stack = [];
    let quote = "";
    for (let i = 0; i < selector.length; i++) {
      const char = selector[i];
      if (char === "\\") {
        if (++i === selector.length) throw new Error("Incomplete CSS escape.");
        continue;
      }
      if (quote) { if (char === quote) quote = ""; continue; }
      if ((char === ";" || char === "@") && !stack.length) throw new Error("CSS declarations and at-rules are unsupported.");
      if (char === '"' || char === "'") quote = char;
      else if (char === "[" || char === "(") stack.push(char);
      else if ((char === "]" && stack.pop() !== "[") || (char === ")" && stack.pop() !== "(")) throw new Error("Unbalanced CSS selector.");
    }
    if (quote || stack.length) throw new Error("Unbalanced CSS selector.");
    return selector.trim();
  }

  function compileSelector(selector, validateSelector) {
    envelope(selector);
    const budget = { operators: 0 };
    const css = value => {
      const result = safeSelector(value);
      if (validateSelector && !validateSelector(result)) throw new Error('This browser cannot parse that CSS selector.');
      return result;
    };
    function compile(value, depth, relative = false) {
      if (depth > 4) throw new Error('Procedural nesting is limited to four levels.');
      value = value.trim();
      if (relative && /^[+~]/.test(value)) throw new Error('Procedural child matching does not support sibling-relative selectors.');
      if (relative && value.startsWith('>')) value = ':scope ' + value;
      const tokens = syntax(value);
      if (!tokens.functions.some(fn => PROCEDURAL_NAME.test(fn.name))) return { css: css(value), ops: [] };
      const first = tokens.functions.find(fn => fn.depth === 0 && OPERATORS.has(fn.name));
      if (!first) throw new Error('Unsupported or nested procedural operator.');
      const subject = value.slice(0, first.index).trim();
      if (!subject || syntax(subject).commas.length) throw new Error('A procedural rule needs one explicit CSS subject, without a top-level selector list.');
      // `.content :has-text(x)` targets descendants of .content. Trimming the
      // combinator away would hide .content itself, so refuse it instead.
      if (endsWithCombinator(value.slice(0, first.index))) throw new Error(DESCENDANT_OPERATOR);
      const plan = { css: css(subject), ops: [] };
      let tail = value.slice(first.index);
      while (tail) {
        const call = /^:([a-zA-Z-]+)\(/.exec(tail);
        if (!call || !OPERATORS.has(call[1])) throw new Error('Unsupported operator or CSS suffix after a procedure.');
        if (++budget.operators > 8) throw new Error('A procedural rule is limited to eight operators.');
        let nesting = 1, quote = '', end = call[0].length;
        for (; end < tail.length; end++) {
          const char = tail[end];
          if (char === '\\') { end++; continue; }
          if (quote) { if (char === quote) quote = ''; continue; }
          if (char === '"' || char === "'") quote = char;
          else if (char === '(') nesting++;
          else if (char === ')' && --nesting === 0) break;
        }
        if (nesting || quote) throw new Error('Unbalanced procedural argument.');
        let arg = tail.slice(call[0].length, end).trim();
        const name = call[1];
        if (name === 'has' || name === '-abp-has') {
          plan.ops.push({ type: 'has', plan: compile(arg, depth + 1, true) });
        } else if (name === 'upward') {
          if (/^\d+$/.test(arg)) {
            const count = Number(arg);
            if (count < 1 || count > 10) throw new Error('Ancestor distance must be between 1 and 10.');
            plan.ops.push({ type: 'upward', count });
          } else plan.ops.push({ type: 'upward', selector: css(arg) });
        } else {
          if (/^["']/.test(arg)) {
            const delimiter = arg[0];
            if (arg.at(-1) !== delimiter) throw new Error('Unbalanced text quotation.');
            const inner = arg.slice(1, -1);
            let literal = '';
            for (let i = 0; i < inner.length; i++) {
              if (inner[i] === '\\') {
                if (inner[i + 1] !== '\\' && inner[i + 1] !== delimiter) throw new Error('Only quoted backslashes and quotation marks may be escaped.');
                i++;
              } else if (inner[i] === delimiter) throw new Error('Escape quotation marks inside text.');
              literal += inner[i];
            }
            arg = literal;
          } else if (/[\\"']/.test(arg)) throw new Error('Quote text containing quotation marks or backslashes.');
          if (/^\/[\s\S]*\/[a-z]*$/i.test(arg)) throw new Error('Text regular expressions are unsupported; use a literal phrase.');
          if (!arg || arg.length > 200) throw new Error('Literal text must contain 1 to 200 characters.');
          plan.ops.push({ type: 'text', value: arg });
        }
        const rest = tail.slice(end + 1);
        // A space between procedures is a descendant combinator, not chaining.
        if (/^\s/.test(rest) && rest.trim()) throw new Error(DESCENDANT_OPERATOR);
        tail = rest.trim();
      }
      return plan;
    }
    return compile(selector, 0);
  }

  function hostName(value) {
    if (!value || /[\s/\\:*^|@?#\[\]]/.test(value)) throw new Error("Use a hostname without URLs or wildcards.");
    const host = new URL(`https://${value}`).hostname.toLowerCase().replace(/\.$/, "");
    if (host.length > 253 || (!host.includes(".") && host !== "localhost") ||
        host.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error("Invalid hostname.");
    return host;
  }

  function parse(text, validateSelector) {
    if (typeof text !== "string" || text.length > LIMITS.text) throw new Error(`Custom filters must be text under ${LIMITS.text} characters.`);
    const rules = [];
    for (const [index, raw] of text.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("!")) continue;
      try {
        const match = /^([^#]+?)(#@\?#|#\?#|#@#|##)(.+)$/.exec(line);
        if (!match) throw new Error("Expected site.example##selector or site.example#@#selector.");
        const include = [], exclude = [];
        for (const scope of match[1].split(",")) {
          const negative = scope.startsWith("~");
          (negative ? exclude : include).push(hostName(negative ? scope.slice(1) : scope));
        }
        if (!include.length) throw new Error("Custom rules require at least one positive site scope.");
        const selector = match[3].trim();
        const plan = compileSelector(selector, validateSelector);
        rules.push({ include: [...new Set(include)], exclude: [...new Set(exclude)], selector, exception: match[2].includes('@'),
          ...(plan.ops.length || match[2].includes('?') ? { procedure: plan } : {}) });
        if (rules.length > LIMITS.rules) throw new Error(`At most ${LIMITS.rules} custom cosmetic rules are supported.`);
      } catch (error) { throw new Error(`Line ${index + 1}: ${error.message}`); }
    }
    return rules;
  }

  function resolve(data, hostname, { generic = true, custom = [] } = {}) {
    const host = hostname.toLowerCase().replace(/\.$/, "");
    const hide = new Set(), allow = new Set(data.allow?.["*"] || []), procedures = new Map();
    const disableAll = (data.disableAll || []).some(domain => matches(host, domain));
    const disableGeneric = !generic || (data.disableGeneric || []).some(domain => matches(host, domain));
    const genericHide = new Set(disableGeneric ? [] : data.generic || []);
    for (const name of ["hide", "allow"]) {
      const target = name === "hide" ? hide : allow;
      const labels = host.split(".");
      for (let i = 0; i < labels.length; i++) {
        const suffix = labels.slice(i).join(".");
        if (Object.hasOwn(data[name] || {}, suffix)) for (const selector of data[name][suffix]) target.add(selector);
      }
    }
    for (const rule of [...(data.scoped || []), ...(data.procedural || []), ...custom]) {
      if ((rule.include.length && !rule.include.some(domain => matches(host, domain))) ||
          rule.exclude.some(domain => matches(host, domain))) continue;
      if (rule.exception) allow.add(rule.selector);
      else if (rule.procedure) procedures.set(rule.selector, rule.procedure);
      else if (rule.include.length) hide.add(rule.selector);
      else if (!disableGeneric) genericHide.add(rule.selector);
    }
    return { disableAll, disableGeneric, exceptions: [...allow],
      proceduralRules: disableAll ? [] : [...procedures].filter(([selector]) => !allow.has(selector)).map(([selector, plan]) => ({ selector, plan })),
      siteSelectors: [...hide].filter(selector => !allow.has(selector)),
      genericSelectors: [...genericHide].filter(selector => !allow.has(selector)) };
  }
  globalThis.BlockAdsCosmetic = Object.freeze({ parse, resolve, safeSelector, compileSelector, LIMITS });
})();
