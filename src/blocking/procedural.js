/* Bounded, reversible page hiding. No filter code, regexes or network requests. */
(() => {
  'use strict';
  const DEFAULT_LIMITS = Object.freeze({ rules: 64, candidates: 5000, operations: 20000, characters: 1048576, milliseconds: 32 });
  class ScanLimit extends Error {}
  function create({ document: doc, onProblem = () => {}, isAlive = () => true, limits = DEFAULT_LIMITS }) {
    const marker = 'data-blockads-procedural-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
    const css = `[${marker}="1"] { display: none !important; }`;
    let key = null, plans = [], hidden = new Set(), timer = null, style = null;
    let suspended = false;
    const observer = new MutationObserver(records => {
      if (records.some(record => {
        if (record.type === 'attributes' && record.attributeName === marker) {
          return hidden.has(record.target) !== (record.target.getAttribute(marker) === '1');
        }
        if (record.target === style && style.textContent === css) return false;
        if (record.type === 'childList' && style?.isConnected &&
            [...record.addedNodes, ...record.removedNodes].every(node => node === style)) return false;
        return true;
      })) schedule();
    });

    function stop() {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      for (const element of hidden) if (element.getAttribute(marker) === '1') element.removeAttribute(marker);
      hidden.clear();
      style?.remove();
      style = null;
    }
    function suspend(reason = 'limit', error) {
      if (suspended) return;
      suspended = true;
      stop();
      onProblem(reason, error);
    }
    function schedule(initial = false) {
      if (timer !== null || suspended || !plans.length) return;
      // Coalesce mutation bursts; one pending scan and no permanent polling loop.
      timer = setTimeout(scan, initial ? 0 : 100);
    }
    function scan() {
      timer = null;
      if (!isAlive()) { clear(); return; }
      if (suspended || !doc.documentElement) return;
      const deadline = performance.now() + limits.milliseconds;
      let candidates = 0, operations = 0, characters = 0;
      const check = (count = 1, chars = 0) => {
        operations += count;
        characters += chars;
        if (operations > limits.operations || characters > limits.characters || performance.now() > deadline) throw new ScanLimit('Scan budget exceeded.');
      };
      const protectedRoot = node => !node || node === doc.documentElement || node === doc.body || node === doc.head;
      const containsText = (element, needle) => {
        const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let tail = '', node;
        while ((node = walker.nextNode())) {
          check(1, node.data.length);
          const text = tail + node.data;
          if (text.includes(needle)) return true;
          tail = needle.length > 1 ? text.slice(-(needle.length - 1)) : '';
        }
        return false;
      };
      const evaluate = (plan, root) => {
        check();
        const selected = root.querySelectorAll(plan.css);
        candidates += selected.length;
        if (candidates > limits.candidates) throw new ScanLimit('Candidate budget exceeded.');
        check();
        let elements = [...selected];
        for (const op of plan.ops) {
          const next = new Set();
          for (const element of elements) {
            check();
            if (op.type === 'text') {
              if (containsText(element, op.value)) next.add(element);
            } else if (op.type === 'has') {
              if (evaluate(op.plan, element).length) next.add(element);
            } else if (op.type === 'upward') {
              let parent = element;
              for (let distance = 1; distance <= (op.count || 10); distance++) {
                check();
                parent = parent.parentElement;
                if (protectedRoot(parent)) break;
                if (op.count ? distance === op.count : parent.matches(op.selector)) { next.add(parent); break; }
              }
            }
          }
          elements = [...next];
        }
        return elements;
      };
      try {
        const desired = new Set();
        for (const plan of plans) for (const element of evaluate(plan, doc)) {
          if (!protectedRoot(element) && element.isConnected) desired.add(element);
        }
        check();
        for (const element of hidden) if (!desired.has(element) && element.getAttribute(marker) === '1') element.removeAttribute(marker);
        hidden = desired;
        for (const element of hidden) if (element.getAttribute(marker) !== '1') element.setAttribute(marker, '1');
        if (!style) { style = doc.createElement('style'); style.id = 'blockads-procedural-shield'; }
        if (style.textContent !== css) style.textContent = css;
        if (!style.isConnected) (doc.head || doc.documentElement).append(style);
      } catch (error) {
        // Never keep a partial or stale hide result when a pass cannot finish.
        // Native selector calls are synchronous; budgets are checked between calls.
        suspend(error instanceof ScanLimit ? 'limit' : 'error', error);
      }
    }
    function clear() {
      stop();
      plans = [];
      key = null;
      suspended = false;
    }
    function setRules(rules) {
      const nextKey = JSON.stringify(rules);
      if (nextKey === key) return;
      clear();
      key = nextKey;
      if (rules.length > limits.rules) { suspend(); return; }
      const probe = doc.createDocumentFragment();
      let invalid = false;
      for (const rule of rules) {
        try {
          plans.push(BlockAdsCosmetic.compileSelector(rule.selector, selector => {
            try { probe.querySelector(selector); return true; } catch { return false; }
          }));
        } catch { invalid = true; }
      }
      if (invalid) onProblem('invalid');
      if (!plans.length) return;
      observer.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true });
      schedule(true);
    }
    return Object.freeze({ setRules, clear });
  }
  globalThis.BlockAdsProcedural = Object.freeze({ create, DEFAULT_LIMITS });
})();
