/* Parse source as the native strict function body; never evaluate it. */
(() => {
  'use strict';
  function inspect(source) {
    const core = BlockAdsUserScriptCore, diagnostics = [], tokens = [];
    if (typeof source !== 'string' || core.bytes(source) > core.LIMITS.source) return { tokens, diagnostics: [{ message: 'Source exceeds 128 KiB.', kind: 'limit' }] };
    let metadata;
    try { metadata = core.parse(source); }
    catch (error) { diagnostics.push({ kind: 'metadata', message: error.message }); }
    const prefix = '(function(__api){\n"use strict";\n' + (metadata?.world === 'MAIN' ? '' :
      'const {' + ['GM', ...core.GRANTS.filter(grant => grant.startsWith('GM_'))].join(',') + '}=__api;\n');
    try { acorn.parse(prefix + source + '\n})', { ecmaVersion: 'latest', sourceType: 'script' }); }
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
    return { tokens, diagnostics };
  }
  globalThis.BlockAdsLint = Object.freeze({ inspect });
})();
