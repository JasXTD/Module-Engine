# BlockAds 1.0.3 — dated threat additions, 18 October 2026

Added **24 exact browser host blocks** supported by recent observations in primary security reports. All 73 formerly unverified entries remain inactive. The shared v1 catalog, ad rules and tracker rules retain their existing contents.

## Evidence and selection

- [Proofpoint, Once in a BlueMoon (9 September 2026)](https://www.proofpoint.com/us/blog/threat-insight/once-bluemoon-multiple-state-aligned-threat-actors-rapidly-adopt-novel-exploit) identifies the selected 21 hosts under observed campaign indicators. The source supplies September month precision; its separately marked suspected infrastructure is excluded.
- [Volexity, Mind the (Patch) Gap (9 September 2026)](https://www.volexity.com/blog/2026/09/09/mind-the-patch-gap-multiple-chinese-threat-actors-chain-0-day-exploits-in-chrome-windows/) supports three additional exploit hosts in campaigns observed on September 1–2. The report's dated URLs identify the precise hosts.

The accepted window was 90 days before the October 18 review. Observation dates, not crawl times, publication dates alone, or today's review date, establish recency. Confirmation means the publishers observed malicious use at the reported time. Present ownership, availability and continued malicious use were not tested.

Only existing publisher HTML reports were read. No candidate host was visited, resolved or scanned; no samples, feeds, files, repositories or packages were downloaded. No web-hosted text files were used. The source catalog was authored locally from report facts. uBOL code and lists were not copied.

This is a bounded selection, not an exhaustive import of every indicator in either report. Suspected/shared-IP neighbors, broad shared-platform names, IP addresses, email addresses, DNS-only indicators and undated warnings are excluded. An exact Cloudflare Workers hostname does not imply a block on its parent platform, other tenants or unlisted children.

## Exact hosts

Names below are defanged and are not links. Full machine-readable provenance is in [lists/reported-threats.json](lists/reported-threats.json).

| Host | Reported role | Observed date precision | Source section |
| --- | --- | --- | --- |
| `msbenefit[.]com` | malware-delivery | 2026-09 | Proofpoint / TA412 |
| `attcdn[.]com` | malware-delivery | 2026-09 | Proofpoint / TA412 |
| `evidence[.]msbenefit[.]com` | exploit-delivery | 2026-09 | Proofpoint / TA412 |
| `data[.]attcdn[.]com` | exploit-delivery | 2026-09 | Proofpoint / TA412 |
| `extension-management-portal[.]kmjukilo-lkjh[.]workers[.]dev` | malware-c2 | 2026-09 | Proofpoint / TA412 |
| `airproducts[.]ink` | exploit-delivery | 2026-09 | Proofpoint / UNK_LateNight |
| `precipart[.]ink` | exploit-delivery | 2026-09 | Proofpoint / UNK_LateNight |
| `epsilonsystems[.]net` | exploit-delivery | 2026-09 | Proofpoint / UNK_LateNight |
| `rocketlabusa[.]ink` | exploit-delivery | 2026-09 | Proofpoint / UNK_LateNight |
| `spectrolab[.]fit` | exploit-delivery | 2026-09 | Proofpoint / UNK_LateNight |
| `ms[.]checrity[.]com` | malware-c2 | 2026-09 | Proofpoint / UNK_LateNight |
| `checrity[.]com` | malware-c2 | 2026-09 | Proofpoint / UNK_LateNight |
| `yhv41nji[.]workers[.]dev` | exploit-delivery | 2026-09 | Proofpoint / UNK_QuietRacket |
| `wcce[.]joinmacket[.]com` | exploit-delivery | 2026-09 | Proofpoint / UNK_QuietRacket |
| `joinmacket[.]com` | exploit-delivery | 2026-09 | Proofpoint / UNK_QuietRacket |
| `openlumakora[.]com` | exploit-delivery | 2026-09 | Proofpoint / UNK_QuietRacket |
| `publish[.]openlumakora[.]com` | exploit-delivery | 2026-09 | Proofpoint / UNK_QuietRacket |
| `mailtbox[.]workers[.]dev` | exploit-delivery | 2026-09 | Proofpoint / UNK_DoubleCheck |
| `vncdc[.]mailtbox[.]workers[.]dev` | exploit-delivery | 2026-09 | Proofpoint / UNK_DoubleCheck |
| `brianwilli[.]com` | malware-delivery | 2026-09 | Proofpoint / UNK_DoubleCheck |
| `homepage[.]brianwilli[.]com` | malware-delivery | 2026-09 | Proofpoint / UNK_DoubleCheck |
| `cloud[.]shinewrist[.]net` | exploit-delivery | 2026-09-01 | Volexity |
| `photos[.]msbenefit[.]com` | exploit-delivery | 2026-09-01 | Volexity |
| `proof[.]gitprogram[.]com` | exploit-delivery | 2026-09-02 | Volexity |

## Expiry, controls and compatibility

The entire batch expires at **2026-11-30 00:00:00 UTC**, 90 days after the conservative September 1 evidence floor. Month-only observations are retained as month-only data; the builder does not invent a last-seen day. Rebuilds never renew the expiry.

The new Reported Threats switch defaults on while evidence is current. Saved master pause and individual preferences survive reload/update handling. Site exceptions retain their higher priority. Exact rules cover HTTP(S) and WebSocket browser requests, including ports, case normalization and a DNS root dot; they do not extend to arbitrary children, operating-system DNS, or other applications.

The runtime reads only the packaged JSON policy. It creates an expiry alarm and hourly guard, restores alarms on worker/startup events, disables stale rules during reconciliation, and never restores expired threats during rollback. Missing or malformed evidence or an alarm failure leaves this layer inactive with a visible error. The local clock is required. Browser alarms can be delayed during suspension or sleep, so expiry enforcement happens when the event is dispatched or another reconciliation runs; it is not a hard real-time cutoff. [Chrome alarm behavior](https://developer.chrome.com/docs/extensions/reference/api/alarms).

The v1 catalog and CyberAssist export contract are unchanged. This separate threat input is browser-only and requires a new review before renewal. The original empty compatibility malware file remains empty.

## Verification

| Check | Result |
| --- | --- |
| Background regression suite | 25 tests passed, including worker wake, missing alarms, exact expiry boundary, expired reload, explicit pause, invalid evidence, scheduling failure and expiry during rollback. |
| Existing offline catalog/build/export suite | 173 assertions passed. |
| New offline threat evidence/build suite | 334 assertions passed: exact scope, all 73 legacy exclusions, conservative expiry, unsupported/undated/stale/future evidence, malformed input, publisher URLs and unchanged outputs on rejection. |
| Chrome 155.0.8059.85 | 266 checks passed in the follow-up harness regression run. |
| Edge 155.0.4283.62 | 266 checks passed; see [Edge verification](EDGE-VERIFICATION-2026-10-18.md). |
| Firefox 158.0 | 265 checks passed in a fresh isolated profile. |
| Popup | Chromium active layout visually inspected at 350 px; automated long-domain, error, paused, inheritance and overflow checks passed. Firefox presentation checked through the DOM. |

The browser suites tested all 24 hosts with synthetic DNR request descriptions, including hostname boundaries and negative controls. No hostname probes performed network requests. Real HTTP and WebSocket enforcement used loopback fixtures only, with an allowed/blocked/allowed WebSocket control sequence. A non-forwarding deny proxy and disabled speculative networking guarded the isolated profiles; no reported-host requests reached the proxy.

Firefox's test API rejects WebSocket-scheme inputs before matching. Its tests therefore use the HTTP(S) handshake representation and independently prove blocking with the real loopback handshake. The original failing diagnostic is retained with the final evidence. [Mozilla implementation](https://searchfox.org/firefox-main/source/toolkit/components/extensions/ExtensionDNR.sys.mjs).

Saved evidence is under [verification/2026-10-18/dated-threats/](verification/2026-10-18/dated-threats/). Runtime and ruleset hashes in all three final browser records were compared against the delivered workspace. Permanent signed Firefox installation remains unverified. Expiry/failure timing uses an injected-clock unit harness, not a claim that weeks elapsed in live browsers. These checks do not establish complete protection against all malicious content.

## Changes and recovery

- Inputs/build: `lists/reported-threats.json`, `scripts/threat-report-tools.ps1`, `scripts/build-rules.ps1`, `rules/threats.json`, `rules/threat-policy.json`.
- Runtime/UI: `manifest.json`, `background.js`, `popup.html`, `popup.js`.
- Tests/docs: `tests/background.test.cjs`, `tests/threat-rules.test.ps1`, `tests/browser-smoke.cjs`, `README.md`, `lists/README.md`, historical-report notice and this report.
- Pre-change copies and hashes: `.artifacts/dated-threats-20261018-115509/`. No Git repository was initialized.

Reload BlockAds from the browser's extension page, then reload affected tabs to use version 1.0.3. No personal browser profile or installed extension was changed by this work.
