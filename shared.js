/* Shared hostname handling for the popup, background, and cosmetic filter. */
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

  globalThis.BlockAds = Object.freeze({
    normalizeDomain, normalizeDomains, domainMatches, whitelistScope
  });
})();
