/* A cancellable parser worker keeps malformed source away from UI/blocking work. */
importScripts('vendor/acorn/acorn.js', 'userscripts-core.js', 'userscripts-lint.js');
onmessage = event => {
  const { revision, source } = event.data || {};
  if (!Number.isSafeInteger(revision)) return;
  postMessage({ revision, ...BlockAdsLint.inspect(source) });
};
