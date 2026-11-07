# Passive review of 73 BlockAds domains — 18 October 2026

**Result: 0 domains met the recent dated-evidence threshold; 0 new blocking rules. All 73 remain unverified.** This does not mean they are safe. It means this bounded passive review did not establish the evidence needed to promote them into current malware blocking.

The user explicitly chose **“Require recent dated evidence”** after being told that four domains have explicit Malwarebytes threat descriptions without last-seen dates. For this review, “recent” means an explicitly dated malicious observation or current verdict from a primary provider within the preceding 90 days, starting **20 July 2026 UTC**. This is the review's conservative interpretation of “recent,” not a date supplied by a vendor.

The review used search and existing third-party reports only. No candidate website was visited, no candidate DNS lookup or active scan was submitted, and no file, feed, payload or repository was downloaded. Potentially dangerous names below are defanged; links lead to evidence publishers. Search excerpts for web-hosted text lists were discarded and were not used.

## Evidence and decision

| Finding | Entries | Decision |
| --- | ---: | --- |
| Explicit vendor descriptions of Trojans, fraudulent notifications or malicious mining, but no last-seen date | 4 | Hold; do not promote |
| Undated adware/riskware warnings | 2 | Hold; do not equate these with confirmed current malware |
| Historical mining or malvertising context, including two old secondary research leads | 9 | Hold; old incidents do not establish current reputation |
| Service descriptions or domains mentioned as attack targets | 4 | Hold; context is not a malicious verdict |
| No suitable primary malicious-domain evidence located | 54 | Remain unverified |
| **Total** | **73** | **No new blocking rules** |

The four explicit threat descriptions are [MB-PUSHAME](https://www.malwarebytes.com/blog/detections/pushame-com) (downloader-Trojan association), [MB-PUSHNO](https://www.malwarebytes.com/blog/detections/pushno-com) (miner-Trojan association), [MB-PUSHWHY](https://www.malwarebytes.com/blog/detections/pushwhy-com) (fraudulent notifications), and [MB-WEBMINE](https://www.malwarebytes.com/blog/detections/webmine-pro) (malicious mining). Their pages were reviewed on 18 October 2026, but that date is **not** a new detection date. Publication/last-seen dates remain null where unavailable.

Two examples show why domain matching alone is insufficient: [ESET-GLUPTEBA](https://www.welivesecurity.com/2018/03/22/glupteba-no-longer-windigo/) identifies `adfoc[.]us` as an attack target, while [MS-DEFRU](https://www.microsoft.com/en-us/wdsi/threats/malware-encyclopedia-description?Name=Rogue%3AWin32%2FDefru) includes `directadvert[.]ru` among destinations that malware redirects users away from. Neither mention establishes malicious ownership or hosting.

## Coverage and limits

Every catalog hostname received an exact-name search across a selected set of primary security publishers. Candidate findings received contextual review and targeted follow-up; all 73 were included in a final 90-day search. The machine-readable record contains the individual queries, source pools, evidence URLs, dates, decisions and coverage.

This was a public-source review, not an authenticated live reputation-database check. Public indexing is incomplete, and a no-result search is not a clean verdict. Four existing-report search pages at URLhaus were unavailable through the web tool; that failure was not treated as a clean result. No scan was requested as a workaround.

Search crawl dates, the date a report was read, copyright years, and undated vendor block statements do not meet the freshness requirement. Old URL-level incidents do not justify blocking a parent domain, sibling domains, a shared platform, or all subdomains. Ad/tracker membership, notification delivery, and mining-service identity alone are not malware confirmation.

## All 73 decisions

Every entry below has current verdict **unverified** and action **do not promote into malware blocking**.

| # | Domain (defanged) | Evidence status | Reason and sources |
| --- | --- | --- | --- |
| 1 | `2giga[.]link` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 2 | `actionteaser[.]ru` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 3 | `adfoc[.]us` | Context, not a malware verdict | The ESET report identifies it as an attack target, not malicious infrastructure. Community complaints are not confirmation. [ESET-GLUPTEBA](https://www.welivesecurity.com/2018/03/22/glupteba-no-longer-windigo/) |
| 4 | `adfocus[.]us` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 5 | `adprofex[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 6 | `adskeeper[.]co[.]uk` | Undated adware/riskware warning | Undated adware-redirect warning does not meet the recent confirmed-malicious threshold; do not extend it to adskeeper.com. [MB-ADSKEEPER](https://www.malwarebytes.com/blog/detections/adskeeper-co-uk) |
| 7 | `adskeeper[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 8 | `afminer[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 9 | `aftrk[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 10 | `aimtell[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 11 | `authedmine[.]com` | Historical context only | The 2018 report describes an opt-in mining API; no recent domain-specific malicious observation. [MB-AUTHEDMINE](https://www.malwarebytes.com/blog/news/2018/02/state-malicious-cryptomining) |
| 12 | `betrad[.]com` | Insufficient evidence | Community configuration/log references appeared, but no primary malicious-domain finding sufficient for blocking was located.  |
| 13 | `bodyclick[.]net` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 14 | `clksite[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 15 | `coin-hive[.]com` | Historical context only | Historical Coinhive script URL appears in 2017 research; no current confirmation or basis to expand scope. [PAN-COINHIVE](https://unit42.paloaltonetworks.com/unit42-unauthorized-coin-mining-browser/) |
| 16 | `coinhive[.]com` | Historical context only | Historical mining abuse is documented, but the vendor distinguishes the service itself from malicious use; no recent confirmation. [MB-COINHIVE](https://www.malwarebytes.com/blog/security-world/2017/10/why-is-malwarebytes-blocking-coinhive?Offer=ab_ss_reeng_plt_var1), [PAN-COINHIVE](https://unit42.paloaltonetworks.com/unit42-unauthorized-coin-mining-browser/) |
| 17 | `coinimp[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 18 | `crypto-loot[.]com` | Historical context only | Mining and abuse discussed in 2017-2018 reports; no recent dated malicious observation. [MB-COINHIVE](https://www.malwarebytes.com/blog/security-world/2017/10/why-is-malwarebytes-blocking-coinhive?Offer=ab_ss_reeng_plt_var1), [ZS-MINING](https://www.zscaler.com/blogs/security-research/cryptomining-here-stay-enterprise) |
| 19 | `cryptoloot[.]pro` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 20 | `daopush[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 21 | `deloplen[.]com` | Insufficient evidence | An old community support log appeared, but no recent primary vendor finding sufficient for blocking was located.  |
| 22 | `directadvert[.]ru` | Context, not a malware verdict | Microsoft lists it among legitimate destinations redirected away from by a rogue. A mention in a threat report is not a malicious verdict. [MS-DEFRU](https://www.microsoft.com/en-us/wdsi/threats/malware-encyclopedia-description?Name=Rogue%3AWin32%2FDefru) |
| 23 | `go[.]mobisla[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 24 | `gravitec[.]net` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 25 | `inwemo[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 26 | `izooto[.]com` | Context, not a malware verdict | Notification-platform context only; no recent primary malicious-domain evidence located. [MS-IZOOTO](https://marketplace.microsoft.com/uk-ua/product/databilitytechnologiespvtltd1585898779587.izooto_owned_audience_marketing) |
| 27 | `jsecoin[.]com` | Historical context only | Mentioned in 2018 mining telemetry. Mining-service membership alone does not confirm current malicious activity. [ZS-MINING](https://www.zscaler.com/blogs/security-research/cryptomining-here-stay-enterprise) |
| 28 | `kadam[.]net` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 29 | `lasrv[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 30 | `lentainform[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 31 | `linkvertise[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 32 | `luckyads[.]pro` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 33 | `magsrv[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 34 | `marketgid[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 35 | `mediavenus[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 36 | `megapush[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 37 | `miner[.]pr0gramm[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 38 | `minero[.]cc` | Historical context only | Only an old secondary research lead found; it is not current primary evidence for blocking. [SOPHOS-MINING](https://www.sophos.com/en-us/blog/cryptojacking-is-almost-conquered-crushed-along-with-coinhive-com) |
| 39 | `octo-click[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 40 | `octoclick[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 41 | `onclasrv[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 42 | `onclickads[.]net` | Historical context only | Old malvertising-intermediary evidence exists; another report lists it as a redirect victim. Neither establishes current whole-domain maliciousness. [MB-MAGNITUDE](https://www.malwarebytes.com/?p=68096), [MS-DEFRU](https://www.microsoft.com/en-us/wdsi/threats/malware-encyclopedia-description?Name=Rogue%3AWin32%2FDefru) |
| 43 | `onclkds[.]com` | Historical context only | 2017 ad-redirection evidence is too old for this review's blocking threshold. [ESET-DNSBIRTHDAY](https://www.welivesecurity.com/2017/06/22/got-birthday-reminder/) |
| 44 | `papoto[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 45 | `ppoi[.]org` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 46 | `projectpoi[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 47 | `propeller-tracking[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 48 | `pushame[.]com` | Undated vendor threat report | Explicit Trojan report is undated; the separate automated shop warning was last checked in 2024. No recent dated malicious observation. [MB-PUSHAME](https://www.malwarebytes.com/blog/detections/pushame-com), [GRIDIN-PUSHAME](https://gridinsoft.com/online-virus-scanner/url/pushame-com) |
| 49 | `pushengage[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 50 | `pushlat[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 51 | `pushmono[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 52 | `pushno[.]com` | Undated vendor threat report | Explicit miner-Trojan report is undated. Newer notification integration instructions are not a dated malware finding. [MB-PUSHNO](https://www.malwarebytes.com/blog/detections/pushno-com), [MONETAG-PUSHNO](https://help.monetag.com/en/articles/6745928-instructions-for-blogger-blogspot-how-do-i-insert-the-push-notification-code) |
| 53 | `pushtiger[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 54 | `pushwhy[.]com` | Undated vendor threat report | Explicit fraud report has no last-seen date. Do not equate the date this page was read or crawled with a new incident. [MB-PUSHWHY](https://www.malwarebytes.com/blog/detections/pushwhy-com) |
| 55 | `realsrv[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 56 | `redtram[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 57 | `rocks[.]io` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 58 | `roost[.]me` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 59 | `sendpulse[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 60 | `static[.]linkvertise[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 61 | `sub2unlock[.]com` | Context, not a malware verdict | Link-gating context only; no recent primary malicious-domain evidence located. [EDGE-FASTFORWARD](https://microsoftedge.microsoft.com/addons/detail/fastforward/ldcclmkclhomnpcnccgbgleikchbnecl) |
| 62 | `sub2unlock[.]net` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 63 | `subscribers[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 64 | `teasernet[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 65 | `terraclicks[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 66 | `tovarro[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 67 | `trafficfactory[.]biz` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 68 | `trafmag[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 69 | `trklnks[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 70 | `velocecdn[.]com` | Insufficient evidence | No suitable primary report establishing recent malicious activity was located in the bounded searches. This is not evidence that the domain is safe.  |
| 71 | `visitweb[.]com` | Undated adware/riskware warning | Undated riskware classification alone is insufficient to confirm recent malware. [MB-VISITWEB](https://www.malwarebytes.com/blog/detections/visitweb-com) |
| 72 | `webmine[.]pro` | Undated vendor threat report | Explicit malicious-mining report has no last-seen date. No recent dated observation established. [MB-WEBMINE](https://www.malwarebytes.com/blog/detections/webmine-pro) |
| 73 | `webminepool[.]com` | Historical context only | Only an old secondary research lead found; it is not current primary evidence for blocking. [SOPHOS-MINING](https://www.sophos.com/en-us/blog/cryptojacking-is-almost-conquered-crushed-along-with-coinhive-com) |

## Local artifacts and enforcement

- [Machine-readable review](../../lists/passive-domain-review-2026-10-18.json): authored findings, not downloaded threat data and not an enforcement input.
- [Canonical catalog](../../lists/reviewed-domains.json): version 1 remains an offline structural snapshot, with SHA-256 `C71FD950C7A39A00D6D27BF88CB67BC1D710A37F9214D781D999161A6B4FA5EC`.
- Active browser rules remain **100 ad rules and 80 tracker rules**. The compatibility malware file remains empty, and the manifest declares no malware ruleset.
- The native CyberAssist catalog and its schema were not changed. Runtime code, generated rules and builder inputs were not changed.
- Existing README files were backed up under `.artifacts/passive-review-20261018-114312/`; that directory also records the pre-review hashes of protected files.

A future promotion requires dated primary evidence for the precise hostname and proposed blocking scope, a review for conflicting evidence, and a separately validated browser enforcement input. This review is intentionally not an automatic feed importer.

## Validation

Validation results are recorded in [verification/2026-10-18/passive-review-validation.json](../../verification/2026-10-18/passive-review-validation.json). The final checks cover all 73 unique entries, source references and evidence dates, source-catalog identity, unchanged protected files, and the existing offline rule/import regression suite. Browser runtime was not rerun for these documentation-only changes; the earlier Chrome/Firefox results remain in [the implementation report](CHANGES-2026-10-18.md).

