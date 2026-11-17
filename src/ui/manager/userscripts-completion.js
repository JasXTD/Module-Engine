/* Metadata-only suggestions. Source remains plain text and is never evaluated. */
(() => {
  'use strict';
  const core = BlockAdsUserScriptCore;
  function suggest(source, caret, end = caret) {
    if (typeof source !== 'string' || source.length > core.LIMITS.source || !Number.isInteger(caret) || caret < 0 || caret > source.length || end !== caret) return null;
    const header = /^\uFEFF?\s*\/\/[ \t]*==UserScript==[ \t]*\r?\n/.exec(source);
    if (!header || caret < header[0].length || caret - header[0].length > 16384) return null;
    const before = source.slice(header[0].length, caret);
    if (/^[ \t]*\/\/[ \t]*==\/UserScript==[ \t]*\r?$/m.test(before)) return null;
    const line = source.lastIndexOf('\n', caret - 1) + 1, prefix = source.slice(line, caret);
    const match = /^([ \t]*\/\/[ \t]*@)([\w:-]*)([ \t]+)?([\w.-]*)$/.exec(prefix);
    if (!match) return null;
    const value = Boolean(match[3]), key = match[2], typed = value ? match[4] : key;
    const options = value ? core.METADATA.values[key] : core.METADATA.keys;
    if (!options) return null;
    const from = caret - typed.length, tail = /^[\w:.-]*/.exec(source.slice(caret))[0];
    const to = caret + tail.length;
    const token = source.slice(from, to), items = options.filter(item => item.toLowerCase().startsWith(typed.toLowerCase()) && item !== token);
    // exact: the token is already a complete option, such as GM_setValue while
    // GM_setValues remains. Typing must not then let Enter replace it.
    return items.length ? { from, to, items, kind: value ? '@' + key : 'Metadata key', exact: options.includes(token) } : null;
  }
  function attach(input) {
    const list = document.getElementById('sourceSuggestions'), button = document.getElementById('showSuggestions');
    const status = document.getElementById('completionStatus');
    let result, original, caret, selected = 0, composing = false, inserting = false;
    function hide() { result = undefined; list.hidden = true; input.removeAttribute('aria-activedescendant'); input.removeAttribute('aria-controls'); }
    function choose(index) {
      selected = (index + result.items.length) % result.items.length;
      for (let i = 0; i < list.children.length; i++) list.children[i].setAttribute('aria-selected', String(i === selected));
      input.setAttribute('aria-activedescendant', list.children[selected].id);
      list.children[selected].scrollIntoView({ block: 'nearest' });
    }
    function show(explicit = false) {
      if (composing || inserting || input.disabled) { hide(); return; }
      result = suggest(input.value, input.selectionStart, input.selectionEnd);
      // Longer options for a complete token appear only on request (Ctrl+Space).
      if (result?.exact && !explicit) result = null;
      if (!result) { hide(); if (explicit) status.textContent = 'Place the caret after @ in the metadata block, or in a grant, run-at or inject-into value.'; return; }
      original = input.value; caret = input.selectionStart;
      list.replaceChildren(...result.items.map((text, index) => {
        const option = document.createElement('li'); option.id = 'sourceSuggestion' + index; option.setAttribute('role', 'option'); option.textContent = text;
        // Keep textarea focus through pointer and compatibility mouse events.
        // Firefox extension pages can still dispatch mousedown after pointerdown.
        for (const type of ['pointerdown', 'mousedown']) option.addEventListener(type, event => event.preventDefault());
        option.addEventListener('click', () => accept(index)); return option;
      }));
      list.hidden = false; input.setAttribute('aria-controls', list.id);
      const line = input.value.slice(0, input.selectionStart).split('\n').length;
      list.style.top = Math.max(4, Math.min(12 + line * 20 - input.scrollTop, input.clientHeight - Math.min(180, list.scrollHeight) - 8)) + 'px';
      choose(0); status.textContent = result.kind + ' suggestions. Up or down to choose, Enter or Tab to insert, Escape to close.';
    }
    function accept(index) {
      if (!result || input.disabled || composing || input.value !== original || input.selectionStart !== caret || input.selectionEnd !== caret) { hide(); return; }
      const { from, to, items } = result, text = items[index];
      hide(); input.focus(); input.setSelectionRange(from, to); inserting = true;
      try {
        // insertText preserves the native undo buffer. No HTML or script evaluation.
        // This legacy editing command is exercised in all three browser suites.
        document.execCommand('insertText', false, text);
        if (input.value === original.slice(0, from) + text + original.slice(to)) {
          input.dispatchEvent(new Event('input', { bubbles: true })); status.textContent = 'Inserted ' + text + '. Undo with Ctrl+Z.';
        } else status.textContent = 'Insertion is unavailable in this browser. Type the suggested text manually.';
      } catch { status.textContent = 'Suggestion insertion is unavailable. Your draft is preserved; type the text manually.'; }
      finally { inserting = false; }
    }
    input.addEventListener('input', event => { if (!event.isComposing) show(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing || composing || input.disabled) return;
      if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space') { event.preventDefault(); show(true); return; }
      if (!result) return;
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault();
        if (event.key === 'Escape') hide();
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') choose(selected + (event.key === 'ArrowDown' ? 1 : -1));
        else accept(selected);
      } else if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) hide();
    });
    input.addEventListener('compositionstart', () => { composing = true; hide(); });
    input.addEventListener('compositionend', () => { composing = false; show(); });
    input.addEventListener('pointerdown', hide); input.addEventListener('scroll', hide); input.addEventListener('blur', hide);
    button.addEventListener('click', () => { if (!input.disabled) { input.focus(); show(true); } });
    return Object.freeze({ hide });
  }
  globalThis.BlockAdsCompletion = Object.freeze({ suggest, attach });
})();
