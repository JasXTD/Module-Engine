/* Conservative English prompt policies; no host verdicts, downloads or telemetry. */
(() => {
  'use strict';
  const actions = 'a,button,[role="button"],input[type="button"],input[type="submit"]';
  const normalize = (value, limit) => typeof value === 'string' && value.length <= limit
    ? value.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase() : '';
  const label = element => normalize(element.localName === 'input' ? element.value : element.textContent || element.getAttribute('aria-label'), 160);
  const installAction = value => /^(?:(?:click|tap) (?:here )?to )?(?:install|update|download|add|enable)\b/.test(value);
  const allowAction = value => /^(?:allow|enable|turn on|yes)(?:$|[ !.,])/.test(value);

  function classify(message, labels) {
    const text = normalize(message, 4000);
    if (!text || !Array.isArray(labels) || labels.length > 64) return [];
    const buttons = labels.map(value => normalize(value, 160));
    // Explanations and warnings are not prompts. Missing a disguised prompt is
    // preferable to removing advice telling someone how to avoid one.
    if (/\b(?:don't|do not|never|avoid|beware|scam|malicious|fake)\b/.test(text)) return [];
    const notification = buttons.some(allowAction) && (
      /\bnotifications?\b/.test(text) && /\b(?:allow|enable|turn on|subscribe|get|receive)\b/.test(text) ||
      /\b(?:click|press|tap)\s+["']?allow\b/.test(text) && /\b(?:human|robot|continue|watch|download|verify)\b/.test(text)
    );
    const component = /\b(?:codec(?: pack)?|(?:media|video) player|player update|(?:browser )?extension|(?:browser )?add-on|plug-?in)\b/.test(text);
    const gate = /\b(?:to|before you can|in order to)\s+(?:continue|proceed|play|watch|stream|view|download|access|unlock)\b/.test(text) ||
      /\b(?:required|needed|missing|out[- ]of[- ]date|outdated)\b/.test(text) && /\b(?:video|playback|movie|stream|play|watch)\b/.test(text);
    const install = component && gate && buttons.some(installAction);
    return [notification && 'notification', install && 'install'].filter(Boolean);
  }

  function promptText(scope) {
    // textContent joins adjacent blocks ("human</h2><button>Allow" becomes
    // "humanAllow"). Read text-node boundaries without forcing layout, including
    // for closed dialogs that we still own. Bound both node and text work.
    const walker = scope.ownerDocument.createTreeWalker(scope, 4);
    const parts = [];
    let node, length = 0, count = 0;
    while ((node = walker.nextNode())) {
      if (++count > 256) return '';
      if (node.parentElement?.closest('script,style,template,noscript')) continue;
      length += node.data.length + 1;
      if (length > 4000) return '';
      parts.push(node.data);
    }
    return parts.join(' ');
  }
  const policy = kind => Object.freeze({
    small: true,
    selector: actions,
    anchor: element => (kind === 'notification' ? allowAction : installAction)(label(element)),
    matches: scope => {
      const buttons = scope.querySelectorAll(actions);
      if (buttons.length > 64) return false;
      return classify(promptText(scope), Array.from(buttons, label)).includes(kind);
    }
  });
  globalThis.BlockAdsPrompts = Object.freeze({ classify, notification: policy('notification'), install: policy('install') });
})();
