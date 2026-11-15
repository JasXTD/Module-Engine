/* Reddit-specific policy for the shared, reversible overlay repair. */
(() => {
  'use strict';
  const isReddit = hostname => /(^|\.)reddit\.com$/i.test(String(hostname).replace(/\.$/, ''));
  const title = /^(get the best of reddit in the app|get the reddit app|reddit is better in the app)$/i;
  const action = /^(get (the )?reddit app|open( in)? (the )?(reddit )?app|continue in (the )?app)$/i;
  const text = element => (element.textContent || '').slice(0, 4000).replace(/\s+/g, ' ').trim();
  const policy = Object.freeze({
    selector: 'h1,h2,h3,[role="heading"]',
    anchor: element => title.test(text(element)),
    matches: scope => [...scope.querySelectorAll('h1,h2,h3,[role="heading"]')].some(element => title.test(text(element))) &&
      [...scope.querySelectorAll('a,button,[role="button"]')].some(element => action.test(text(element)))
  });
  function policyFor({ document: doc, hostname = doc.location.hostname === "127.0.0.1" && doc.location.pathname === "/reddit-fixture" ? "www.reddit.com" : doc.location.hostname, }) {
    return isReddit(hostname) ? policy : null;
  }
  function create(options) {
    const rule = policyFor(options);
    if (!rule) return Object.freeze({ setEnabled() {}, clear() {} });
    const shield = BlockAdsOverlays.create(options);
    return Object.freeze({ setEnabled: value => shield.setRules(value ? [rule] : []), clear: shield.clear });
  }
  globalThis.BlockAdsReddit = Object.freeze({ create, isReddit, policyFor });
})();
