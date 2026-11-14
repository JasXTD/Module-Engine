/* A cancellable parser worker keeps malformed source away from UI/blocking work. */
importScripts('../../../vendor/acorn/acorn.js', '../../../vendor/publicsuffix/suffixes.js', '../../userscripts/userscripts-matching.js', '../../userscripts/userscripts-page.js', '../../userscripts/userscripts-core.js', '../../userscripts/userscripts-lint.js');
onmessage = event => {
  const { revision, source } = event.data || {};
  if (!Number.isSafeInteger(revision)) return;
  postMessage({ revision, ...BlockAdsLint.inspect(source) });
};
