/* Highlight beneath the native textarea, preserving its selection, IME and undo. */
(() => {
  'use strict';
  function create() {
    const el = id => document.getElementById(id), input = el('scriptSource'), highlight = el('sourceHighlight'), gutter = el('sourceLines');
    const status = el('syntaxStatus'), jump = el('syntaxJump'), marker = el('sourceErrorLine');
    let worker, pending = false, revision = 0, source, debounce, timeout, diagnostic;
    function stop() { clearTimeout(timeout); worker?.terminate(); worker = undefined; pending = false; }
    function sync() {
      highlight.scrollTop = gutter.scrollTop = input.scrollTop; highlight.scrollLeft = input.scrollLeft;
      marker.style.top = (12 + ((diagnostic?.line || 1) - 1) * 20 - input.scrollTop) + 'px';
    }
    function show(result) {
      diagnostic = result.diagnostics[0];
      status.textContent = diagnostic ? (diagnostic.line ? 'Line ' + diagnostic.line + ', column ' + diagnostic.column + ': ' : '') + diagnostic.message
        : 'No syntax errors found. Runtime errors still appear in the page console.';
      status.classList.toggle('error-text', Boolean(diagnostic));
      input.setAttribute('aria-invalid', String(diagnostic?.kind === 'syntax'));
      jump.hidden = !Number.isInteger(diagnostic?.offset); marker.hidden = !diagnostic?.line;
      const fragment = document.createDocumentFragment(); let offset = 0;
      for (const token of result.tokens) {
        if (token.kind === 'plain') continue;
        if (token.start < offset || token.end > source.length) continue;
        if (token.start > offset) fragment.append(document.createTextNode(source.slice(offset, token.start)));
        const span = document.createElement('span'); span.className = 'syntax-' + token.kind; span.textContent = source.slice(token.start, token.end); fragment.append(span); offset = token.end;
      }
      fragment.append(document.createTextNode(source.slice(offset) + '\n ')); highlight.replaceChildren(fragment); sync();
    }
    function update(value) {
      if (source === value) return;
      source = value; const current = ++revision;
      clearTimeout(debounce); if (pending) stop();
      diagnostic = undefined; marker.hidden = jump.hidden = true; input.removeAttribute('aria-invalid');
      highlight.textContent = source + '\n ';
      const lines = source.split('\n').length;
      gutter.textContent = Array.from({ length: lines }, (_, index) => index + 1).join('\n') + '\n ';
      gutter.style.width = (String(lines).length + 2) + 'ch'; sync();
      status.classList.remove('error-text'); status.textContent = 'Checking syntax…';
      debounce = setTimeout(() => {
        try {
          if (!worker) {
            worker = new Worker('userscripts-editor-worker.js');
            worker.onmessage = event => {
              if (event.data.revision !== revision) return;
              clearTimeout(timeout); pending = false; show(event.data);
            };
            worker.onerror = event => { event.preventDefault(); stop(); show({ tokens: [], diagnostics: [{ message: 'Syntax checker is unavailable. Your draft is preserved.' }] }); };
          }
          pending = true;
          timeout = setTimeout(() => { stop(); show({ tokens: [], diagnostics: [{ message: 'Syntax check exceeded two seconds. Simplify the source or try again after editing.' }] }); }, 2000);
          worker.postMessage({ revision: current, source });
        } catch (error) { stop(); show({ tokens: [], diagnostics: [{ message: 'Syntax checker could not start: ' + error.message }] }); }
      }, 150);
    }
    input.addEventListener('scroll', sync);
    jump.addEventListener('click', () => {
      if (!Number.isInteger(diagnostic?.offset)) return;
      input.focus(); input.setSelectionRange(diagnostic.offset, Math.min(source.length, diagnostic.offset + 1));
      input.scrollTop = Math.max(0, (diagnostic.line - 3) * 20); sync();
    });
    addEventListener('pagehide', () => { clearTimeout(debounce); stop(); });
    return Object.freeze({ update, sync });
  }
  globalThis.BlockAdsEditor = Object.freeze({ create });
})();
