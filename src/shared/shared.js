/* Shared hostname handling and bounded list downloads. */
(() => {
  "use strict";

  function normalizeDomain(input) {
    if (typeof input !== "string" || !input.trim()) {
      throw new Error("Enter a hostname or an HTTP(S) URL.");
    }
    const value = input.trim();
    if (/[\s\\*^|]/u.test(value)) {
      throw new Error("Hostnames cannot contain spaces, wildcards, or filter syntax.");
    }
    let url;
    try {
      url = new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      throw new Error("Enter a valid hostname or HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("Use an HTTP(S) address without a username or password.");
    }
    // URL converts internationalized names to ASCII/punycode for DNR.
    // Retain the original www/apex scope for existing exceptions.
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
    const labels = hostname.split(".");
    if (hostname.length > 253 ||
        (labels.length < 2 && hostname !== "localhost") ||
        labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error("Use a valid DNS hostname or IPv4 address; IPv6 is not supported.");
    }
    return hostname;
  }

  function normalizeDomains(values) {
    if (!Array.isArray(values)) throw new Error("The domain list must be an array.");
    return [...new Set(values.map(normalizeDomain))].sort();
  }

  function domainMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith(`.${domain}`);
  }

  function whitelistScope(hostname, domains) {
    return domains.filter(domain => domainMatches(hostname, domain))
      .sort((a, b) => a.length - b.length)[0] || "";
  }

  // Security decisions must not collapse independent sibling hosts. Without a
  // bundled public-suffix list, treat only an exact host and its parents or
  // children as the same scope. This is deliberately conservative: sibling
  // subdomains may produce an extra flag, but one tenant can never stand in for
  // another tenant on a shared host such as github.io or pages.dev.
  function sameSite(left, right) {
    const first = String(left).toLowerCase().replace(/\.$/, "");
    const second = String(right).toLowerCase().replace(/\.$/, "");
    return Boolean(first && second && (domainMatches(first, second) || domainMatches(second, first)));
  }

  // Approximation used only for non-authoritative pattern scoring. Never use it
  // to choose a host to block, allow, ignore or classify as first-party.
  function siteOf(hostname) {
    const host = String(hostname).toLowerCase().replace(/\.$/, "");
    if (/^[0-9.]+$/.test(host) || !host.includes(".")) return host;
    const labels = host.split(".");
    const twoPart = labels.length > 2 && labels.at(-1).length === 2 &&
      /^(com|net|org|edu|gov|co|ac|or|ne|go|gob|mil|idv)$/.test(labels.at(-2));
    return labels.slice(twoPart ? -3 : -2).join(".");
  }

  async function readListBytes(response, limit, sizeError) {
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new Error(sizeError);
    }
    let bytes = new Uint8Array(0), length = 0;
    if (!response.body) return bytes;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return bytes.subarray(0, length);
        const end = length + value.byteLength;
        if (end > limit) {
          await reader.cancel();
          throw new Error(sizeError);
        }
        // One growing buffer bounds memory even if the list arrives a byte at a time.
        if (end > bytes.length) {
          const next = new Uint8Array(Math.min(limit, Math.max(end, bytes.length * 2, 4096)));
          next.set(bytes);
          bytes = next;
        }
        bytes.set(value, length);
        length = end;
      }
    } finally { reader.releaseLock(); }
  }

  globalThis.BlockAds = Object.freeze({
    normalizeDomain, normalizeDomains, domainMatches, whitelistScope, sameSite, siteOf, readListBytes
  });
})();
