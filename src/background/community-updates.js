/* Filter-list updates for the community layer. EasyList and EasyList China are
   downloaded from their publishers and converted here by the converter that
   built the bundled rules (src/blocking/community-lists.js), so the same list
   text always gives the same rules.

   An update is installed as a difference from the bundled ruleset: bundled rules
   the new lists dropped are disabled, and new or changed rules become dynamic
   rules. That fits Firefox, which allows only 5,000 dynamic rules, and keeps the
   bundled rules as the fallback. Downloads carry no cookies or referrer; list
   lines are data and are never run. */
(() => {
  'use strict';
  // Dynamic rule IDs for list changes: 1,000,001 and up. The person's own rules
  // count up from 1, and reported-threat updates use 900,001 to 900,999.
  const RULE_ID_BASE = 1000000;
  const RULE_ID_LIMIT = 1999999;
  const MAX_BYTES = 8 * 1024 * 1024;
  const TIMEOUT_MS = 60000;
  const DAY = 86400000;
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
  // A converted list must keep at least this share of the bundled rules and site
  // hiding, so a truncated or substituted download is refused.
  const MIN_SHARE = 0.5;

  // List addresses: HTTPS, or plain HTTP on this computer for offline tests.
  function sourceUrl(value) {
    let url;
    try { url = new URL(String(value || '').trim()); } catch { throw new Error('A filter-list address is not a valid URL.'); }
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) throw new Error('Filter-list addresses must use https://.');
    if (url.username || url.password || url.hash) throw new Error('Filter-list addresses cannot contain a user name, password or fragment.');
    return url.href;
  }

  // The header the converter also reads: the first `! Title:`, `! Version:` and
  // `! Expires:` comments, matched without regard to case.
  function readHeader(text) {
    const header = {};
    for (const raw of text.split(/\r?\n/, 400)) {
      const line = raw.trim();
      if (!line || (line[0] !== '!' && line[0] !== '[')) continue;
      const match = /^!\s*(Title|Version|Expires):\s*(.+)$/i.exec(line);
      const name = match && match[1].toLowerCase();
      if (name && !Object.hasOwn(header, name)) header[name] = match[2].trim();
    }
    return header;
  }

  // EasyList asks clients to check every few days: `! Expires: 4 days`. Between
  // one and fourteen days; four when a list does not say.
  function checkInterval(expires) {
    const match = /^(\d+)\s*(day|hour)s?\b/i.exec(expires || '');
    const span = match ? Number(match[1]) * (match[2].toLowerCase() === 'day' ? DAY : DAY / 24) : 4 * DAY;
    return Math.min(14 * DAY, Math.max(DAY, span));
  }

  // One list, bounded in time and size, without cookies or referrer. Redirects
  // are followed only to another HTTPS address.
  async function download(source, fetcher = globalThis.fetch) {
    const url = sourceUrl(source);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetcher(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}.`);
      if (response.redirected && !/^https:/i.test(response.url || '')) throw new Error(`${new URL(url).host} redirected to an address without HTTPS.`);
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error(`The list from ${new URL(url).host} is larger than 8 MiB.`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) throw new Error(`The list from ${new URL(url).host} is larger than 8 MiB.`);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error(`The list from ${new URL(url).host} is not valid UTF-8.`); }
      return { text, bytes };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`The list from ${new URL(url).host} took too long to download.`);
      throw error;
    } finally { clearTimeout(timer); }
  }

  // A downloaded text must be the list it claims to be: an Adblock Plus-format
  // list with the expected title and a numeric version.
  function checkList(text, expected) {
    const first = text.split(/\r?\n/, 1)[0].replace(/^﻿/, '').trim();
    if (!/^\[Adblock Plus \d+(\.\d+)*\]$/i.test(first)) throw new Error(`${expected.title} did not download as a filter list.`);
    const header = readHeader(text);
    if (header.title !== expected.title) throw new Error(`The ${expected.title} download is titled "${String(header.title || 'nothing').slice(0, 80)}".`);
    if (!/^\d{8,14}$/.test(header.version || '')) throw new Error(`${expected.title} has no version number.`);
    return header;
  }

  // Versions are timestamps (yyyymmddhhmm). Accept a set only when no list is
  // older than the one in use and at least one is newer, so a replayed or
  // stale copy changes nothing.
  function compareVersions(inUse, downloaded) {
    let newer = false;
    for (const list of downloaded) {
      const current = inUse.find(item => item.id === list.id)?.version || '';
      if (current && list.version.length === current.length && list.version < current) {
        throw new Error(`The downloaded ${list.title} (${list.version}) is older than the one in use (${current}).`);
      }
      if (!current || list.version !== current) newer = true;
    }
    return newer;
  }

  // Deterministic text for a rule's meaning, without its ID.
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
  const groupKey = rule => { const { requestDomains, ...rest } = rule.condition; return canonical({ priority: rule.priority, action: rule.action, condition: rest }); };
  const ruleKey = rule => canonical({ priority: rule.priority, action: rule.action, condition: rule.condition });

  // Which bundled rules to disable and which rules to add, so that the bundled
  // rules plus the change behave as the converted rules. Merged domain rules are
  // compared by domain: a dropped domain disables its bundled chunk and re-adds
  // the rest of that chunk, and new domains are added in chunks of 1,000.
  function difference(bundled, converted, { chunk = 1000 } = {}) {
    const bundledGroups = new Map(), convertedGroups = new Map(), bundledSingles = new Map(), convertedSingles = new Map();
    for (const rule of bundled) {
      if (!Array.isArray(rule.condition?.requestDomains)) { bundledSingles.set(ruleKey(rule), rule.id); continue; }
      const key = groupKey(rule);
      if (!bundledGroups.has(key)) bundledGroups.set(key, { rule, chunks: [], hosts: new Set() });
      const group = bundledGroups.get(key);
      group.chunks.push(rule);
      for (const host of rule.condition.requestDomains) group.hosts.add(host);
    }
    for (const rule of converted) {
      if (!Array.isArray(rule.condition?.requestDomains)) { convertedSingles.set(ruleKey(rule), rule); continue; }
      const key = groupKey(rule);
      if (!convertedGroups.has(key)) convertedGroups.set(key, { rule, hosts: new Set() });
      for (const host of rule.condition.requestDomains) convertedGroups.get(key).hosts.add(host);
    }
    const disable = [], add = [];
    const withDomains = (rule, hosts) => ({ priority: rule.priority, action: rule.action, condition: { requestDomains: hosts, ...(({ requestDomains, ...rest }) => rest)(rule.condition) } });
    const addHosts = (rule, hosts) => { for (let offset = 0; offset < hosts.length; offset += chunk) add.push(withDomains(rule, hosts.slice(offset, offset + chunk))); };
    for (const [key, group] of bundledGroups) {
      const kept = convertedGroups.get(key)?.hosts || new Set();
      for (const rule of group.chunks) {
        if (rule.condition.requestDomains.every(host => kept.has(host))) continue;
        disable.push(rule.id);
        const remaining = rule.condition.requestDomains.filter(host => kept.has(host));
        if (remaining.length) add.push(withDomains(rule, remaining));
      }
      addHosts(group.rule, [...kept].filter(host => !group.hosts.has(host)).sort());
    }
    for (const [key, group] of convertedGroups) if (!bundledGroups.has(key)) addHosts(group.rule, [...group.hosts].sort());
    for (const [key, id] of bundledSingles) if (!convertedSingles.has(key)) disable.push(id);
    for (const [key, rule] of convertedSingles) if (!bundledSingles.has(key)) add.push({ priority: rule.priority, action: rule.action, condition: rule.condition });
    if (RULE_ID_BASE + add.length > RULE_ID_LIMIT) throw new Error('The filter-list change is too large.');
    return { disable: disable.sort((a, b) => a - b), add: add.map((rule, index) => ({ id: RULE_ID_BASE + index + 1, ...rule })) };
  }

  // Refuses a conversion that lost most of the bundled rules or site hiding.
  function checkSize(info, bundledInfo) {
    for (const [key, label] of [['networkRules', 'network rules'], ['cosmeticSelectors', 'site hiding rules']]) {
      if (info[key] < bundledInfo[key] * MIN_SHARE) {
        throw new Error(`The new lists give ${info[key].toLocaleString('en')} ${label}, under half of the bundled ${bundledInfo[key].toLocaleString('en')}.`);
      }
    }
  }

  const isListRule = rule => rule.id > RULE_ID_BASE && rule.id <= RULE_ID_LIMIT;

  globalThis.ModuleEngineCommunityUpdates = Object.freeze({ RULE_ID_BASE, RULE_ID_LIMIT, MAX_BYTES, sourceUrl, readHeader, checkInterval,
    download, checkList, compareVersions, difference, checkSize, isListRule });
})();
