/* Display-only evidence validation. Never requests a domain or report URL. */
(() => {
  'use strict';
  const publishers = Object.freeze({Proofpoint:'www.proofpoint.com',Volexity:'www.volexity.com'});
  const text = (value,max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const date = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}(-\d{2})?$/.test(value)) return false;
    const full=value.length === 7 ? value+'-01' : value, stamp=Date.parse(full+'T00:00:00Z');
    return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0,10) === full;
  };
  const parse = (bytes,max) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > max) throw new Error('Bundled evidence exceeds its size limit.');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  };
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
  async function verify(evidenceBytes,rulesBytes,policyBytes) {
    const bundle = parse(evidenceBytes,128*1024), policy = parse(policyBytes,2048);
    if (!(rulesBytes instanceof Uint8Array) || rulesBytes.byteLength > 128*1024 || bundle?.schemaVersion !== 1 ||
        !/^[a-f0-9]{64}$/.test(bundle.rulesSha256) || !/^[a-f0-9]{64}$/.test(bundle.policySha256)) throw new Error('Invalid bundled evidence format.');
    const [rulesHash,policyHash] = await Promise.all([hash(rulesBytes),hash(policyBytes)]);
    if (rulesHash !== bundle.rulesSha256 || policyHash !== bundle.policySha256) throw new Error('Evidence does not match the packaged rules and policy. Rebuild and reload Module Engine.');
    const catalog=bundle.catalog, rules=parse(rulesBytes,128*1024);
    if (catalog?.schemaVersion !== 1 || catalog.reviewKind !== 'passive-dated-threat-reports' || catalog.maxAgeDays !== 90 ||
        !date(catalog.reviewedOn) || !Array.isArray(catalog.sources) || !catalog.sources.length || catalog.sources.length > 10 ||
        !Array.isArray(catalog.domains) || !catalog.domains.length || catalog.domains.length > 100 ||
        policy?.schemaVersion !== 1 || policy.ruleCount !== catalog.domains.length || !Array.isArray(rules) || rules.length !== catalog.domains.length ||
        !Number.isFinite(Date.parse(policy.expiresAt)) || !Number.isFinite(Date.parse(policy.reviewedAt)) ||
        policy.reviewedAt !== catalog.reviewedOn+'T00:00:00Z') throw new Error('Evidence catalog and policy are inconsistent.');
    const sources=new Map();
    for (const source of catalog.sources) {
      if (!text(source?.id,64) || sources.has(source.id) || !Object.hasOwn(publishers,source.publisher) ||
          !text(source.url,1024) || !date(source.publishedOn) || source.publishedOn.length !== 10 ||
          Date.parse(source.publishedOn) > Date.parse(catalog.reviewedOn)) throw new Error('Invalid evidence source.');
      const url=new URL(source.url);
      if (url.protocol !== 'https:' || url.hostname !== publishers[source.publisher] || url.username || url.password || url.port ||
          /\.txt$/i.test(decodeURIComponent(url.pathname))) throw new Error('Unsupported evidence source address.');
      sources.set(source.id,source);
    }
    const hosts=new Set(), types=['main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','media','websocket','other'].sort();
    let earliest=Infinity;
    for (const [index,item] of catalog.domains.entries()) {
      if (!text(item?.host,253) || !/^[a-z0-9.-]+$/.test(item.host) || !item.host.includes('.') ||
          new URL('https://'+item.host).hostname !== item.host || hosts.has(item.host) || item.match !== 'exact' ||
          !sources.has(item.sourceId) || !date(item.observedOn) || !text(item.role,100) || !text(item.section,100)) throw new Error('Invalid evidence entry.');
      const observed=Date.parse(item.observedOn);
      if (observed > Date.parse(sources.get(item.sourceId).publishedOn)) throw new Error('An observation is newer than its published source.');
      earliest=Math.min(earliest,observed);
      const rule=rules[index], expected='^(http|https|ws|wss)://([^/@]*@)?'+item.host.replaceAll('.','\\.')+'\\.?(:[0-9]+)?/';
      if (rule?.id !== index+1 || rule.priority !== 5 || rule.action?.type !== 'block' || rule.condition?.regexFilter !== expected ||
          Object.keys(rule.condition).sort().join(',') !== 'regexFilter,resourceTypes' ||
          !Array.isArray(rule.condition.resourceTypes) || [...rule.condition.resourceTypes].sort().join(',') !== types.join(',')) {
        throw new Error('A displayed host does not match its packaged exact-host rule.');
      }
      hosts.add(item.host);
    }
    if (Date.parse(policy.evidenceFrom) !== earliest || Date.parse(policy.expiresAt) !== earliest+90*86400000) throw new Error('Evidence dates do not match the packaged expiry policy.');
    return {catalog,policy};
  }
  globalThis.BlockAdsEvidence=Object.freeze({verify});
})();
