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

The separate `passive-domain-review-2026-10-18.json` records a later passive search of
all 73 unverified entries. No entry met the user-selected recent dated-evidence
threshold, so it adds no blocks. Four explicit vendor threat descriptions were undated.
This research record is not a version-1 catalog or build input; it must not be imported
as one. See [the complete findings](../DOMAIN-REVIEW-2026-10-18.md) for scope and limits.

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
[dated-threat review](../THREAT-ADDITIONS-2026-10-18.md) for sources and browser validation.
