/* Parse the selected execution form; never evaluate source. */
(() => {
  'use strict';
  function inspect(source) {
    const core = BlockAdsUserScriptCore, diagnostics = [], tokens = [];
    if (typeof source !== 'string' || core.bytes(source) > core.LIMITS.source) return { tokens, diagnostics: [{ message: 'Source exceeds 128 KiB.', kind: 'limit' }] };
    let metadata;
    try { metadata = core.parse(source); }
    catch (error) { diagnostics.push({ kind: 'metadata', message: error.message }); }
    const prefix = metadata?.unwrap ? '' : '(' + (metadata?.topLevelAwait ? 'async ' : '') + 'function(__api){\n"use strict";\n' +
      core.bindings(metadata || { grants: [], world: 'USER_SCRIPT' });
    try { acorn.parse(prefix + source + (metadata?.unwrap ? '' : '\n})'), { ecmaVersion: 'latest', sourceType: 'script' }); }
    catch (error) {
      const offset = Number.isInteger(error.pos) ? Math.min(source.length, error.pos - prefix.length) : undefined;
      const located = Number.isInteger(offset) && offset >= 0;
      const before = located ? source.slice(0, offset).split(/\r\n?|\n|\u2028|\u2029/) : [];
      diagnostics.unshift({ kind: Number.isInteger(error.pos) ? 'syntax' : 'limit',
        message: error.pos >= prefix.length + source.length ? 'Unexpected end of script; check for an unclosed expression or block.' : String(error.message).replace(/ \(\d+:\d+\)$/, ''),
        ...(located ? { offset, line: before.length, column: before.at(-1).length + 1 } : {}) });
    }
    try {
      const lexer = acorn.tokenizer(source, { ecmaVersion: 'latest', onComment: (_block, _text, start, end) => {
        if (tokens.length < 20000) tokens.push({ start, end, kind: 'comment' });
      } });
      while (tokens.length < 20000) {
        const token = lexer.getToken(), label = token.type.label;
        if (label === 'eof') break;
        tokens.push({ start: token.start, end: token.end, kind: token.type.keyword ? 'keyword' :
          ['string', 'template', '`'].includes(label) ? 'string' : ['num', 'regexp'].includes(label) ? 'literal' : 'plain' });
      }
    } catch { /* The parser above supplies the error; retain tokens before it. */ }
    tokens.sort((a, b) => a.start - b.start);
    const bidi = core.bidiControls(source);
    for (const { offset, line, column, escape } of bidi.locations) diagnostics.push({ kind: 'bidi', severity: 'warning', offset, line, column,
      message: 'Hidden direction control U+' + escape.slice(2) + ' (' + escape + '). Review the escaped source before enabling.' +
        (bidi.count > bidi.locations.length ? ' Showing the first 20 of ' + bidi.count + ' controls.' : '') });
    return { tokens, diagnostics };
  }
  globalThis.BlockAdsLint = Object.freeze({ inspect });
})();
