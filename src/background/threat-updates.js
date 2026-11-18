/* Signed reported-threat updates from a public folder, such as the project's
   GitHub repository. An update is data only: the three files the builder
   already emits (threats.json, threat-policy.json, threat-evidence.json) and a
   detached signature over threat-evidence.json. That file records the SHA-256
   of the other two, so one signature covers all three. Nothing fetched here is
   ever run as code, and nothing is sent: requests carry no cookies or
   referrer. Uses BlockAdsEvidence (src/blocking/evidence.js) for the same
   checks the evidence page makes, and the trusted public keys in
   ModuleEngineUpdateConfig (src/shared/update-config.js). */
(() => {
  'use strict';
  const FILES = Object.freeze({ rules: 'threats.json', policy: 'threat-policy.json', evidence: 'threat-evidence.json', signature: 'threat-evidence.sig' });
  const LIMITS = Object.freeze({ rules: 128 * 1024, policy: 2048, evidence: 128 * 1024, signature: 512 });
  const TIMEOUT_MS = 15000;
  // Dynamic rule IDs for an installed update. Protection rules count up from 1.
  const RULE_ID_BASE = 900000;
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

  // The folder that holds the four files. HTTPS only; plain HTTP only on this
  // computer, for offline tests.
  function sourceUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter the full address of the update folder, starting with https://.'); }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw new Error('Update addresses must start with https://.');
    if (url.username || url.password || url.search || url.hash) throw new Error('Use an address without a user name, password, query or fragment.');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  }

  function base64(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(text.trim())) throw new Error('The update signature is not valid base64.');
    const raw = atob(text.trim());
    return Uint8Array.from(raw, character => character.charCodeAt(0));
  }

  // ECDSA P-256 with SHA-256; signatures are the 64-byte r||s form WebCrypto uses.
  async function verifySignature(bytes, signatureText, keys) {
    const signature = base64(signatureText);
    if (signature.byteLength !== 64) throw new Error('The update signature has the wrong length.');
    for (const jwk of keys || []) {
      if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256') continue;
      const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, bytes)) return true;
    }
    return false;
  }

  // One file, bounded in time and size, without cookies, referrer or redirects.
  async function download(base, name, limit, fetcher = globalThis.fetch) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(new URL(name, base).href, { cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error(`${name} could not be downloaded (HTTP ${response.status}).`);
      return await BlockAds.readListBytes(response, limit, `${name} is larger than ${limit} bytes.`);
    } catch (error) {
      controller.abort();
      if (error?.name === 'AbortError') throw new Error(`${name} took too long to download.`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  async function fetchUpdate(source, fetcher) {
    const base = sourceUrl(source);
    // The small signature first: a folder without one is not an update.
    const signature = new TextDecoder('utf-8', { fatal: true }).decode(await download(base, FILES.signature, LIMITS.signature, fetcher));
    const [rules, policy, evidence] = await Promise.all(['rules', 'policy', 'evidence'].map(kind => download(base, FILES[kind], LIMITS[kind], fetcher)));
    return { rules, policy, evidence, signature };
  }

  // Signature and evidence checks, without judging dates. The background
  // re-verifies its installed list with this; check() adds the date rules.
  async function verify(files, keys = globalThis.ModuleEngineUpdateConfig?.keys) {
    if (!(await verifySignature(files.evidence, files.signature, keys))) throw new Error('The update is not signed by a key this version of Module Engine trusts.');
    const { catalog, policy } = await globalThis.BlockAdsEvidence.verify(files.evidence, files.rules, files.policy);
    const rules = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(files.rules));
    return { catalog, policy, rules };
  }

  // Accepts an update only when it is signed by a trusted key, passes the
  // evidence checks, has not expired and comes from a later review than the
  // list in use. A replayed older update is refused.
  async function check(files, { keys, now = Date.now(), currentReviewedAt = null } = {}) {
    const { catalog, policy, rules } = await verify(files, keys);
    const reviewed = Date.parse(policy.reviewedAt), expires = Date.parse(policy.expiresAt);
    if (reviewed > now) throw new Error('The update is dated in the future.');
    if (expires <= now) throw new Error('The update has already expired.');
    if (currentReviewedAt && reviewed <= Date.parse(currentReviewedAt)) return { newer: false, policy, catalog };
    return { newer: true, policy, catalog, rules };
  }

  // The update's rules as dynamic rules, in their own ID range.
  const dynamicRules = rules => rules.map(rule => ({ ...rule, id: RULE_ID_BASE + rule.id }));

  // Stored form: text, so storage holds exactly the verified bytes.
  const decode = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const encode = text => new TextEncoder().encode(text);
  const store = files => ({ rules: decode(files.rules), policy: decode(files.policy), evidence: decode(files.evidence), signature: files.signature.trim() });
  const restore = saved => ({ rules: encode(saved.rules), policy: encode(saved.policy), evidence: encode(saved.evidence), signature: saved.signature });

  globalThis.ModuleEngineThreatUpdates = Object.freeze({ FILES, LIMITS, RULE_ID_BASE, sourceUrl, verifySignature, download, fetchUpdate, verify, check, dynamicRules, store, restore });
})();
