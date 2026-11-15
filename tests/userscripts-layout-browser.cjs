/* Cross-feature path regression. Uses existing owned fixtures without OS desktop helpers. */
const { runMatching } = require('./userscripts-matching-browser.cjs');
const { runEditor } = require('./userscripts-editor-browser.cjs');
const { runInstallation } = require('./userscripts-install-browser.cjs');
const { runCompatibility } = require('./userscripts-compatibility.cjs');
const { runHelpers } = require('./userscripts-helpers-browser.cjs');
const { runAssetsAndNetwork } = require('./userscripts-assets-network.cjs');
const { runPage } = require('./userscripts-page-browser.cjs');
const { runMCP } = require('./mcp-browser.cjs');
async function runLayout(context) {
  const { b, manager, check, evidence } = context;
  evidence.layoutPhases = [];
  for (const [name, run] of [['matching',runMatching],['editor and external file',runEditor],['installation and updates',runInstallation],
    ['GM compatibility',runCompatibility],['DOM and tab helpers',runHelpers],['dependencies and HTTP',runAssetsAndNetwork],['page-world bridge',runPage]]) {
    const before = evidence.checks.length;
    await run(context); evidence.layoutPhases.push({ name, checks: evidence.checks.length - before });
  }
  // Load the real private helper document without requesting clipboard/download
  // permissions or touching the operating-system clipboard. This verifies its
  // nested script URLs in the browser; unit tests cover the permission/lease path.
  const helper = await b.open(await b.evaluate('(globalThis.browser||chrome).runtime.getURL("src/userscripts/clipboard.html")',manager));
  try {
    check('Relocated private helper loads all native DOM/XHR dependencies', await b.evaluate('Boolean(globalThis.BlockAdsUserScriptCore&&globalThis.BlockAdsUserScriptNetwork&&globalThis.BlockAdsXHR&&globalThis.BlockAdsClipboard)',helper));
  } finally { await b.closePage(helper); }
  evidence.layoutMCP = [];
  for (const transport of ['stdio','http']) {
    const before = evidence.checks.length; await runMCP({ ...context, transport });
    evidence.layoutMCP.push({ ...evidence.mcp, processExit: evidence.mcpProcessExit });
    evidence.layoutPhases.push({ name: 'MCP '+transport, checks: evidence.checks.length-before });
  }
  const changesBefore = evidence.checks.length; await require('./mcp-changes-browser.cjs').runChanges({ ...context, transport: 'stdio' });
  evidence.layoutPhases.push({ name: 'MCP change proposals', checks: evidence.checks.length-changesBefore });
  const errors = b.consoleErrors ? await b.consoleErrors() : b.events.filter(event=>event.method==='Runtime.exceptionThrown').map(event=>event.params.exceptionDetails);
  const expected = error => /Owned page failure|Owned offline debug error/.test(JSON.stringify(error));
  // As in the blocker suite, Firefox logs replies discarded after the test
  // closes a fixture tab. Preserve these browser-generated lifecycle reports;
  // only the exact messages from our content script are exempt from failure.
  const unloaded = error => evidence.browser === 'firefox' &&
    error.source === 'moz-extension://' + b.id + '/src/blocking/content.js' &&
    /^(?:Promise resolved after context unloaded|Promise resolved while context is inactive|Promise rejected after context unloaded: Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved)\s*$/.test(error.text);
  evidence.layoutExpectedErrors = errors.filter(expected);
  evidence.layoutClosedPageErrors = errors.filter(unloaded);
  evidence.layoutUnexpectedErrors = errors.filter(error=>!expected(error)&&!unloaded(error));
  check('No unexpected runtime errors during relocated userscript and MCP tests',evidence.layoutUnexpectedErrors.length===0);
  check('No unexpected proxy errors during the path regression',evidence.proxyErrors.length===0);
}
module.exports = { runLayout };
