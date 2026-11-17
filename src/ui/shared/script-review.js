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
        const cell = document.createElement(index ? 'td' : 'th'); cell.textContent = core.escapeBidi(value);
        if (!index) cell.scope = 'row'; tr.append(cell);
      }
      body.append(tr);
    }
  }
  function bidiWarning(source, { id, acknowledge = false, onChange = () => {} } = {}) {
    const result = core.bidiControls(source), node = document.createElement('section');
    node.className = 'review-bidi'; node.dataset.role = 'bidi-warning'; node.hidden = !result.count;
    let accepted = false;
    if (result.count) {
      const title = document.createElement('strong'), explanation = document.createElement('p'), list = document.createElement('ul');
      title.textContent = result.count + ' hidden Unicode direction control' + (result.count === 1 ? '' : 's');
      explanation.textContent = 'These characters can change the visual order of code and comments. Read-only previews show them as \\uXXXX; the saved code is unchanged. Positions below refer to the original source (UTF-16 columns).';
      for (const entry of result.locations) {
        const item = document.createElement('li'); item.textContent = 'Line ' + entry.line + ', column ' + entry.column + ': U+' + entry.escape.slice(2) + ' (' + entry.escape + ')'; list.append(item);
      }
      node.append(title, explanation, list);
      if (result.count > result.locations.length) {
        const more = document.createElement('p'); more.textContent = 'First 20 of ' + result.count + ' positions shown. Every control is escaped in the preview.'; node.append(more);
      }
      if (acknowledge) {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; if (id) input.id = id;
        input.addEventListener('change', event => {
          if (event.isTrusted) accepted = input.checked;
          else input.checked = accepted;
          onChange();
        });
        label.append(input, ' I reviewed the escaped source and understand these controls can change how code looks.'); node.append(label);
      }
    }
    return { node, accepted: () => !result.count || accepted };
  }
  function confirmBidi(source, description = 'Saved source', action = 'Acknowledge & enable') {
    if (!core.hasBidi(source)) return Promise.resolve(true);
    const dialog = document.createElement('dialog'), title = document.createElement('h2'), panes = document.createElement('div');
    const label = document.createElement('label'), preview = document.createElement('textarea'), actions = document.createElement('div');
    const cancel = document.createElement('button'), enable = document.createElement('button');
    const id = 'bidi-' + crypto.randomUUID();
    dialog.className = 'bidi-dialog'; title.id = id; title.textContent = 'Review hidden direction controls'; dialog.setAttribute('aria-labelledby', id);
    panes.className = 'review-code'; label.htmlFor = preview.id = id + '-source'; label.textContent = description + ' · escaped, read only';
    preview.value = core.escapeBidi(source); preview.readOnly = true; preview.spellcheck = false; preview.dir = 'ltr';
    const column = document.createElement('div'); column.append(label, preview); panes.append(column);
    const warning = bidiWarning(source, { id: 'bidiAcknowledge', acknowledge: true, onChange: () => { enable.disabled = !warning.accepted(); } });
    cancel.type = enable.type = 'button'; cancel.textContent = 'Cancel'; enable.id = 'bidiEnable'; enable.textContent = action; enable.className = 'primary'; enable.disabled = true;
    actions.className = 'actions'; actions.append(cancel, enable); dialog.append(title, warning.node, panes, actions);
    return new Promise(resolve => {
      let approved = false;
      cancel.addEventListener('click', () => dialog.close());
      enable.addEventListener('click', event => { if (event.isTrusted && warning.accepted()) { approved = true; dialog.close(); } });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(approved); }, { once: true });
      document.body.append(dialog); dialog.showModal(); cancel.focus();
    });
  }
  globalThis.BlockAdsScriptReview = Object.freeze({ rows, render, updateRoute, cookieScope, worldDescription, bidiWarning, confirmBidi });
})();
