# Reviewed domain contract, version 1

`reviewed-domains.json` is the canonical offline catalog. `scripts/build-rules.ps1`
validates it, builds browser rules, and exports the same catalog to
`rules/reviewed-domains.json`. `scripts/export-cyberassist.ps1 -CyberAssistRoot <root>`
validates the export and copies it into CyberAssist source with a backup. Add
`-Check` to verify equality without changing files. CyberAssist embeds that snapshot
in its core assembly; a build is required to use a new catalog.

The structural review contains 94 ad, 80 tracker and 73 unverified domain records.
There are **zero independently evidenced malicious domains in this v1 catalog**. The categories come
from inherited local lists and are not current reputation assertions. Former malware
entries are retained for observation only and generate no browser blocking rules.
`review-decisions.json` records category decisions and the two excluded miner filename
patterns. Six ad URL heuristics remain in `browser-patterns.json`, with their original
third-party and resource-type conditions; they are never exported as domain indicators.

`requested-ad-hosts.json` separately records explicit user ad-block requests, including
the request date and reason. It currently blocks exactly `pxl.wheelroot.com`, including
page navigation; the parent, sibling and child hosts are not included. This is a user
preference, not a malware classification. These entries are never exported to the
reviewed-domain contract or threat list. They use priority 4 in the ad ruleset, like
custom request filters: community exceptions cannot undo them, while explicit
Always Allowed and custom request exceptions still take precedence. Turning off
the ad layer or pausing protection disables them. The builder accepts only exact,
canonical DNS hosts, rejects duplicate or malformed entries, and performs no lookups.

The separate `passive-domain-review-2026-10-18.json` records a later passive search of
all 73 unverified entries. No entry met the user-selected recent dated-evidence
threshold, so it adds no blocks. Four explicit vendor threat descriptions were undated.
This research record is not a version-1 catalog or build input; it must not be imported
as one. See [the complete findings](../docs/history/DOMAIN-REVIEW-2026-10-18.md) for scope and limits.

Each record has a canonical ASCII hostname, `exact` or `subdomains` matching (the latter
includes the apex), its category, source ID and original rule ID, and original browser
priority, party scope and resource types. Parent and child entries are retained when
present in the source: matching reports every applicable entry and its source scope.
Exact duplicate domains or source rule IDs are refused, rather than silently merged.

Source records name the local pre-review rules file and its SHA-256. These identify
the bytes reviewed, not the domain's operator, current reputation, or an upstream
provider. The initial files are preserved in the review backup. `reviewedAtUtc` dates
only the structural review. `lastVerifiedUtc` and `expiresUtc` must be null in version 1:
there is no dated reputation evidence to supply. This version rejects malware categories,
confidence claims, fabricated verification dates and unknown fields. Future evidenced
malware uses the separate browser-only contract below; a download alone is insufficient.

Both the PowerShell importer and CyberAssist validate a closed schema, duplicate JSON
properties, UTF-8/JSON depth, a 1 MiB byte limit, at most 5,000 domains, provenance shape,
category/source relationships, bounds, label lengths, IDN encoding, special/reserved
names, malformed suffixes and browser scope. Production records must be lowercase
ASCII without a trailing dot or URL/filter syntax. Query matching normalizes case,
a single root dot and IDNs, then compares whole DNS labels. It never strips `www` or
looks up an address. Common public-suffix-only shapes such as `co.uk` are rejected;
there is no downloaded public suffix registry, so syntax checks cannot prove that a
name is registered, active, controlled by its previous owner, or currently malicious.

Old online/CSV build switches now fail explicitly. No URLhaus cache is activated by
this workflow. Each build is serialized, stages every output before replacement and
rolls back on publication failure. Rebuilds do not refresh the structural-review date.
The digests detect changed snapshots; they are not signatures against a compromised
local administrator or source tree.

Run `pwsh -NoProfile -File tests/rules.test.ps1` for synthetic offline import, rejection,
scope, rollback, export and drift checks. These checks do not resolve or request any
catalog hostname and do not establish live browser enforcement or reputation.

## Community list snapshots, browser-only layer

`community-lists.json` (`reviewKind: community-filter-snapshots`) records each EasyList-format
snapshot stored under `community/`: `id`, `title`, `file`, HTTPS `source`, `license`,
`downloadedAtUtc` and `sha256`. The builder refuses unknown or missing fields, duplicate ids,
files outside `community/`, non-HTTPS sources, future download times, files over 8 MiB, and
any file whose SHA-256 differs from its record. It never downloads anything: a new snapshot is
placed there by a person, and its record is updated deliberately.

`scripts/community-list-tools.ps1` converts the snapshots into `rules/community.json` (the
switchable `community_ruleset`), `rules/community-cosmetic.json` (generic and site-specific hiding rules
and their exceptions) and `rules/community-info.json` (versions, counts and skipped filters by
reason). Blocks get priority 1, exceptions 2 and `$important` blocks 3; the allow list is 4, reported threats 5, custom blocks 50 and site pauses 10000.
Exceptions for domains on Module Engine's own ad, tracker or site-check lists are dropped, and path
exceptions exclude those domains. The build fails if the snapshots would exceed 29,000
rules, which keeps room in Chrome's guaranteed 30,000-rule budget. The lists are third-party
data under the EasyList licence; see the main README for attribution.

The cosmetic bundle now uses `schemaVersion: 3`: `hide` and `allow` retain the
domain-to-selector maps (`allow["*"]` holds global selector exceptions), `generic`
contains global selectors, and `scoped` contains `{include, exclude, selector,
exception}` rules with excluded sites. `disableGeneric` and `disableAll` hold
host-wide `generichide` and `elemhide` exceptions. Path-specific and unsupported
option combinations are counted as skipped rather than expanded to a whole site.
`procedural` contains `{include, exclude, selector, exception, procedure}` records.
The procedure holds a CSS subject and ordered text/child/ancestor operations, with
nested child plans preserved. These are data, never JavaScript or regex source.
The installed Node 22+ runtime runs `scripts/compile-procedural.cjs` offline so the
builder and extension use the same parser in `cosmetic.js`. Unsupported syntax and
unscoped advanced blocking are counted and skipped. Browser-native CSS validation
runs again before a procedure is activated. The runtime still accepts schema 2
bundles, which contain no advanced rules.
This browser-only format does not change the shared reviewed-domain v1 contract.

## Site ad hosts, browser-only list

`site-ad-hosts.json` (`reviewKind: observed-site-ad-hosts`) records ad hosts seen on a
named site by the opt-in `tests/site-ad-check.cjs`. Each entry has the canonical
`domain`, the UTC date `observedOnUtc`, the `site` it was seen on, its observed `role`, and
the `evidence` file under `verification/` that records the request. The builder turns each
entry into an ad rule (ids from 1001, `||domain^`, page loads included so a click pop-up to
the host is blocked too). Like the URL patterns, the list is browser-only: it is not part of
the v1 catalog and is never exported to CyberAssist.

The builder refuses unknown or missing fields, non-canonical or duplicate hosts, future or
invalid dates, evidence paths outside `verification/` or to missing files, and any host
already in the v1 catalog, so an `unverified` catalog entry cannot be activated through
this list. A recorded ad role is not a malware verdict, and generated-looking ad domains
may be replaced by their network; recheck the site and add the new host when that happens.

## Dated browser threat reports, separate contract

`reported-threats.json` is a distinct input with `reviewKind: passive-dated-threat-reports`.
It does not change or extend the v1 catalog and is not consumed by the CyberAssist exporter.
The first review contains 24 exact hosts from Proofpoint and Volexity HTML reports dated
2026-09-09. Each record preserves its source, report section, observed date precision,
and malicious role. No inferred subdomains, speculative shared-IP neighbors, undated
warnings, or former unverified entries are promoted.

`scripts/threat-report-tools.ps1` validates the closed schema, strict UTF-8, 128 KiB / 100
host bounds, unique canonical names, exact-only scope, publisher/report URLs, supported
roles, real calendar dates, and observations recent at review. URLs are references only;
the builder never requests them. Only approved publisher HTTPS blog pages are accepted;
web-hosted text files and binary download URLs are rejected. Human source review remains
necessary: a well-formed record alone does not prove that its claims are true.

The builder emits `rules/threats.json` and `rules/threat-policy.json` together. The whole
batch expires 90 days after its earliest observation. Month-only evidence uses the first
day of that month conservatively, without inventing a precise last-seen date. The review
date and later rebuilds do not refresh evidence. Current expiry: 2026-11-30 00:00 UTC.
Old bundles remain reproducible; the runtime disables expired rules rather than silently
extending them. A manual new evidence review is required to renew coverage.

Run `pwsh -NoProfile -File tests/threat-rules.test.ps1` for offline schema, expiry,
exact-boundary, legacy-exclusion and failed-publication checks. See the
[dated-threat review](../docs/history/THREAT-ADDITIONS-2026-10-18.md) for sources and browser validation.
