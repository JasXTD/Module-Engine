/* Shared userscript review for the manager and MCP pages. It parses metadata only
   and never evaluates source. Each row describes what a script can reach, so a
   reviewer sees new sites, APIs, network hosts or update sources before applying. */
(() => {
  'use strict';
  const core = globalThis.BlockAdsUserScriptCore, updates = globalThis.BlockAdsUserScriptUpdates;
  const cookieScope = meta => 'Current host' + (meta.connects.some(host => host !== 'self') ? ' and @connect: ' + meta.connects.filter(host => host !== 'self').join(', ') : '') + '; includes HttpOnly cookies in the calling tab’s store';
  const worldDescription = meta => meta.injection === 'auto' && !meta.unwrap ? 'Page first; isolated fallback if page startup is blocked'
    : meta.world === 'MAIN' ? 'Page world (shared with the site)' : 'Isolated script world';
  // The destinations a check would use for this source, as shown in a review.
  function updateRoute(source, sourceURL) {
    let plan; try { plan = updates.targets({ source, sourceURL }); } catch { return 'Not linked'; }
    return plan.download ? 'Downloads: ' + plan.download + (plan.version ? '\nVersion check: ' + plan.version : '') : 'Not linked';
  }
  const FIELDS = Object.freeze([
    ['Name', meta => meta.name], ['Namespace', meta => meta.namespace], ['Version', meta => meta.explicitVersion || 'Not specified'],
    ['Description', meta => meta.description || 'None'],
    ['Sites', meta => [...meta.matches, ...meta.includes].join('\n')],
    ['Excluded sites', meta => [...meta.excludeMatches, ...meta.excludes].join('\n') || 'None'],
    ['APIs', meta => meta.grants.join('\n')],
    ['Execution', meta => meta.unwrap ? 'Unwrapped global code; grants ignored' : meta.topLevelAwait ? 'Async wrapper; top-level await enabled' : 'Function wrapper'],
    ['Cookie access', meta => meta.grants.some(grant => /^GM[._]cookie$/.test(grant)) ? cookieScope(meta) : 'No cookie helper requested'],
    ['Network access', meta => meta.grants.some(grant => /xmlhttprequest|[._]download$/i.test(grant))
      ? meta.connects.join('\n') || 'Any HTTP(S) destination (no @connect restriction)' : 'No network helper requested'],
    ['Timing', meta => meta.runAt.replace('_', '-')], ['Frames', meta => meta.allFrames ? 'Matching frames' : 'Top frame only'],
    ['World', worldDescription],
    ['Dependencies', meta => core.assetSpecs(meta).map(spec => (spec.name || '@require') + ': ' + spec.url).join('\n') || 'None']
  ]);
  // Without a previous source every row is new, so none is marked as changed.
  function rows(previousSource, source, { previousSourceURL = null, sourceURL = null } = {}) {
    const old = previousSource ? core.parse(previousSource) : null, next = core.parse(source);
    const list = FIELDS.map(([label, value]) => ({ label, before: old ? value(old) : '—', after: value(next) }));
    list.push({ label: 'Update source', before: previousSourceURL ? updateRoute(previousSource, previousSourceURL) : 'Not linked',
      after: updateRoute(source, sourceURL) });
    return list.map(row => ({ ...row, changed: Boolean(old && row.before !== row.after) }));
  }
  function render(body, list) {
    body.replaceChildren();
    for (const { label, before, after, changed } of list) {
      const tr = document.createElement('tr'); tr.classList.toggle('changed', changed);
      for (const [index, value] of [label + (changed ? ' · changed' : ''), before, after].entries()) {
        const cell = document.createElement(index ? 'td' : 'th'); cell.textContent = value;
        if (!index) cell.scope = 'row'; tr.append(cell);
      }
      body.append(tr);
    }
  }
  globalThis.BlockAdsScriptReview = Object.freeze({ rows, render, updateRoute, cookieScope, worldDescription });
})();
