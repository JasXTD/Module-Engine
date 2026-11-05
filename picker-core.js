/* Original DOM selector generation. No page text, URLs or executable filters. */
(() => {
  'use strict';
  const MAX_MATCHES = 100;
  const safeToken = value => /^[a-zA-Z_][a-zA-Z0-9_-]{0,79}$/.test(value);
  function selectable(element, doc = document) {
    return Boolean(element?.nodeType === 1 && element.isConnected && element.getRootNode() === doc &&
      ![doc.documentElement, doc.head, doc.body].includes(element) && !doc.head?.contains(element) &&
      !element.hasAttribute('data-blockads-picker') && !['script', 'style', 'link', 'meta', 'title'].includes(element.localName));
  }
  function selectorFor(element, doc = document) {
    if (!selectable(element, doc)) throw new Error('Choose a page element below the document body.');
    const unique = selector => { const found = doc.querySelectorAll(selector); return found.length === 1 && found[0] === element; };
    const parts = [];
    let current = element;
    for (let depth = 0; depth < 16 && selectable(current, doc); depth++, current = current.parentElement) {
      if (safeToken(current.id)) {
        const candidate = ['#' + CSS.escape(current.id), ...parts].join(' > ');
        if (candidate.length <= 1000 && unique(candidate)) return candidate;
      }
      const tag = CSS.escape(current.localName);
      const classes = [...current.classList].filter(safeToken).slice(0, 3);
      const base = tag + classes.map(name => '.' + CSS.escape(name)).join('');
      let candidate = [base, ...parts].join(' > ');
      if (candidate.length <= 1000 && unique(candidate)) return candidate;
      const siblings = [...current.parentElement.children].filter(node => node.localName === current.localName && node.namespaceURI === current.namespaceURI);
      parts.unshift(base + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')');
      candidate = parts.join(' > ');
      if (candidate.length <= 1000 && unique(candidate)) return candidate;
    }
    const candidate = 'body > ' + parts.join(' > ');
    if (candidate.length <= 1000 && unique(candidate)) return candidate;
    throw new Error('This element needs a longer selector. Choose a nearby container instead.');
  }
  function inspect(selector, doc = document) {
    const plan = BlockAdsCosmetic.compileSelector(selector, css => {
      try { doc.querySelector(css); return true; } catch { return false; }
    });
    if (plan.ops.length) throw new Error('Use plain CSS here; advanced filters can be edited in My lists.');
    const nodes = doc.querySelectorAll(plan.css);
    if (!nodes.length) throw new Error('Nothing matches this selector on the current page.');
    if (nodes.length > MAX_MATCHES) throw new Error('More than 100 elements match. Narrow the selector before saving.');
    if ([...nodes].some(node => !selectable(node, doc))) throw new Error('This selector includes the document root or picker controls. Narrow it first.');
    return { selector: plan.css, nodes: [...nodes] };
  }
  globalThis.BlockAdsPickerCore = Object.freeze({ selectable, selectorFor, inspect, MAX_MATCHES });
})();
