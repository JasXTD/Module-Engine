# Module Engine development

Run commands from the repository root. The extension uses bundled JavaScript, HTML and CSS without a package-install step. Node 22+ runs the JavaScript tests; PowerShell 7+ runs the offline list builder and rule tests.

Keep the extension entry points at the root: the manifest and browser test packages refer to these paths. The legacy `BlockAds` globals, storage names, test prefixes and Firefox extension ID are retained for compatibility; the displayed project name is **Module Engine**.

## Tests and local files

See [verification and test commands](VERIFICATION.md#verification). Start with the offline tests. Browser tests use disposable profiles and owned loopback fixtures; live-site commands require separate opt-in.

Keep working logs, snapshots and scratch exports in `.artifacts/`, which is ignored. The build creates `rules/.build.lock` at runtime; it is not source. Packaged `rules/*.json`, list inputs and referenced verification records remain versioned. Existing dated verification evidence is deliberately retained even where new raw logs match ignore patterns.

## Source review and product direction

The 29 October 2026 review was limited to selected source files on uBO's `master` branch, read as text without cloning, downloading or executing its implementation. It was not a complete audit or a runtime comparison. The [review record](../verification/2026-10-29/network-filters/source-review.json) records the scope and sources.

- uBO already has filter-origin lookup and temporary exceptions in its [logger](https://github.com/gorhill/uBlock/blob/master/src/js/logger-ui.js), as well as background-change handling in its [filter editor](https://github.com/gorhill/uBlock/blob/master/src/js/1p-filters.js). These are existing capabilities to learn from, not missing features to claim as unique.
- The reviewed editor's merge routine assumes background changes have no deletions. That is a specific concurrency assumption to investigate; no uBO data-loss bug was reproduced. Module Engine instead requires the prior saved text to match before accepting a replacement and tests both concurrent additions and deletions.
- The reviewed [asset metadata](https://github.com/gorhill/uBlock/blob/master/src/js/assets.js) tracks list freshness, and the logger identifies contributing lists. Our dated, per-host threat-evidence panel is a useful direction for transparency. Reviewing these paths does not prove that comparable information is absent from every uBO component.
- Full uBO and uBOL have different browser architectures. The current [uBOL FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ)) includes custom filters and external subscriptions, so custom filtering is a parity step. This upgrade does not establish better coverage, performance or resistance to blocker detection.

Further work should start with understandable explanations of matched requests, reversible site fixes with an explicit expiry, and comparable measurements of breakage and resource use. Those are development priorities, not shipped features or proven advantages. Source inspection and isolated fixtures cannot establish universal blocking or live-site superiority.

## Reviewed catalog and rule builds

The ad/tracker and unverified source of truth remains `lists/reviewed-domains.json`. Its review is explicitly **offline structure only**, not a current reputation check. Source hashes and prior rule scopes are recorded; reputation-verification and expiry fields remain unset. `lists/review-decisions.json` explains exclusions and categories. Six ad URL patterns are kept separately in `lists/browser-patterns.json`, and ad hosts recorded on named sites by `tests/site-ad-check.cjs` in `lists/site-ad-hosts.json`; both are browser-only and never exported. EasyList-format snapshots are recorded in `lists/community-lists.json` and converted into the separate community ruleset; they are never exported either. Dated browser threat evidence is a separate, manually reviewed input, `lists/reported-threats.json`; it is not exported to CyberAssist or merged into the version-1 catalog. See [the catalog contracts](../lists/README.md).

Use **PowerShell 7+ and Node 22+**, with Node available on PATH. The build is offline and treats domains as data; it never resolves them or visits their sites. The PowerShell compiler sends bounded UTF-8 data to `scripts/compile-procedural.cjs`, which uses the same parser as the extension. No packages or remote code are used.

**Community snapshot changes.** This upgrade uses only the existing local snapshots. If a replacement local snapshot is separately authorized, review its provenance and update its `downloadedAtUtc` and `sha256` in `lists/community-lists.json` before rebuilding. The builder refuses a list whose hash does not match its record. Reload the extension and refresh open pages after a build. There is no automatic list download.

```powershell
pwsh -NoProfile -File .\scripts\build-rules.ps1

# Optional: validate and build another catalog with the same closed schema.
pwsh -NoProfile -File .\scripts\build-rules.ps1 -CatalogPath C:\path\reviewed-domains.json
```

The builder validates bounded UTF-8/JSON input, duplicate fields/domains/IDs, DNS syntax, categories, source metadata and browser scope. Invalid input fails without replacing existing outputs. Exact host rules retain exact scope; domain-and-subdomain rules retain their documented wider scope. The shared CDN blanket rule and broad country-code TLD heuristics remain excluded.

`-FetchOnlineLists` and `-UrlhausCsvPath` now fail explicitly without downloading or replacing files. Unreviewed remote data is not automatically promoted into this catalog. No authenticated feed or malware samples are needed for this build.

Successful builds write `rules/ads.json`, `rules/trackers.json`, an empty compatibility `rules/malware.json`, the validated `rules/reviewed-domains.json` catalog, and the separate `rules/threats.json` / `rules/threat-policy.json` pair. Ad, tracker and reported-threat sets are declared as browser rulesets. The catalogs and policy are inert JSON metadata. The runtime reads the policy from the packaged extension, never from a remote server. Rebuilding an old evidence file does not renew its dates or expiry.

Every output is staged before replacement. A failed write triggers restoration of already replaced files; a lock prevents concurrent builds. Sudden power loss during multi-file publication is not an atomic transaction, so retain backups and rerun a successful build before reloading if publication is interrupted.
