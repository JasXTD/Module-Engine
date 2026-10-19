# Visible Chrome site checks — 18 October 2026

BlockAds is an active basic request blocker, but **these checks do not establish complete ad blocking or undetectability**. A YouTube video ad was visibly playing with BlockAds enabled. The concrete runtime fix from this session is a Fandom-only cosmetic rule that removes empty ad wrappers; the extension is now version 1.0.4.

## Safety and method

- Previously reviewed threat hosts and the 73 unverified entries were never visited, resolved, probed or submitted to a scanner. Earlier threat-rule tests used inert browser matching inputs and local HTTP/WebSocket fixtures.
- This session explicitly contacted public YouTube, Twitch, Fandom and Google pages in a visible Chrome 155.0.8059.85 window with a fresh, signed-out profile. The extension was copied from this checkout without changes to the test copy.
- The loopback HTTPS proxy allows only the named platforms and selected service/CDN domains. Its allowlist is checked for overlap with the 24 reported threats and 73 unverified hosts before startup; unknown destinations are denied without forwarding or DNS resolution. Chromium speculative DNS and QUIC are disabled. Browser file downloads are denied. Normal page assets and streamed media are loaded as part of browsing; no installer, package, feed, malware sample or video file was downloaded.
- No ad destination was opened, no account was used, and no challenge was solved. Personal browser profiles and system settings were not changed. Every test browser was closed afterward.
- The comparison turns off the ad, tracker and cosmetic layers, while keeping reported-threat filtering enabled. Fresh profiles, varying ad auctions, short samples, and the restricted proxy mean this is **not an unrestricted advertising baseline**. Browser DNR match events establish individual BlockAds blocks; a missing ad does not establish success.

## Observations

| Site | Observed result | What remains unverified |
| --- | --- | --- |
| YouTube | The initial visible sample recorded 14 ad-rule matches but still displayed a sponsored video ad and companion card. A later fixed-video check of Blender's Big Buck Bunny recorded five matches and advancing playback with no player error. | Reliable pre-roll/mid-roll blocking. The first sample changed videos during observation and cannot support a matched on/off comparison. The fixed-video sample had no observed ad in either phase. |
| Twitch | The initial Monstercat page was offline and was excluded as playback evidence. The live VALORANT channel subsequently played at 720p with filtering enabled and disabled. Eight ad/tracker requests matched BlockAds rules in the enabled phase; none matched in the comparison phase. | Stream-ad suppression and longer-session behavior. No blocker warning was reproduced. The proxy also denied some third-party/player-configuration traffic in both phases. |
| Fandom | Wookieepedia loaded and seven ad/tracker requests matched rules. Version 1.0.3 left large empty advertisement wrappers. In 1.0.4 the observed wrappers are hidden with cosmetics enabled and visible when disabled; article content remains present. | Coverage of every wiki layout, provider, or future markup change. |
| Google Search | The public query for wireless headphones returned an unusual-traffic verification page with filtering enabled and disabled. No ad-rule matches occurred. | Sponsored-result filtering and normal search rendering. The verification challenge was not bypassed. This is not evidence of adblock detection. |

The initial four-site observations used 1.0.3. The subsequent live Twitch/Fandom checks and all three final browser regression suites used 1.0.4. Its only filtering change is scoped to Fandom. All three observed Fandom wrappers changed from visible to hidden; the site's own large themed community header remains.

Screenshots: [YouTube ad leak](verification/2026-10-18/live-sites/youtube-ad-leak.png), [Twitch playback](verification/2026-10-18/live-sites/twitch-live.png), [Fandom before the fix](verification/2026-10-18/live-sites/fandom-before.png), [Fandom after the fix](verification/2026-10-18/live-sites/fandom-after.png), [Fandom comparison with ad/tracker/cosmetic filtering off](verification/2026-10-18/live-sites/fandom-cosmetics-off.png).

## Changes and verification

- `content.js`: add `.fandom-ad-wrapper` only on `fandom.com` and its subdomains. Existing global/site/cosmetic controls still govern the whole stylesheet. No player API, page-global function, threat rule, or shared catalog changed.
- `manifest.json`: bump to 1.0.4 so the change is identifiable.
- `tests/browser-smoke.cjs`: allow its Chromium launcher to be reused by the opt-in live check, with visible mode requested explicitly. The normal suite remains headless and denies every external request. Add a fixture assertion that a similarly named element on another site remains visible.
- `tests/live-site-check.cjs`: add the bounded public-site observation workflow, rule-match evidence, file-download denial, process cleanup, and a Fandom visibility assertion for both settings.
- `README.md`: document actual streaming/search limits, the Fandom behavior, and the distinction between offline regressions and opt-in live browsing.

| Check | Result |
| --- | --- |
| Background/settings tests | 25 passed; background logic unchanged by this session |
| Chrome 155 isolated regression suite | 267 passed |
| Edge 155 isolated regression suite | 267 passed |
| Firefox 158 isolated regression suite | 266 passed |
| Fandom live visibility regression | Wrappers hidden when enabled and restored when disabled |
| Visual review | YouTube ad leak, Twitch playback, Fandom before/after screenshots inspected |

The catalog/build suites were not repeated because their inputs, scripts and generated rules did not change. The shared v1 catalog retains SHA-256 `C71FD950C7A39A00D6D27BF88CB67BC1D710A37F9214D781D999161A6B4FA5EC`; the dated browser-only threats remain separate and expire on 30 November 2026 UTC.

Saved evidence is under [verification/2026-10-18/live-sites](verification/2026-10-18/live-sites/). The checkpoint predating this work is `.artifacts/live-sites-20261018-141509/`. Failed harness attempts are retained separately: the first used a cache command at the wrong CDP target; another exposed an unbounded media-play promise on an offline Twitch channel. Both were corrected in the harness and their browser processes were closed. They are not counted as successful checks.

## Blocker detection

The use of a blocker check does not establish a site's reputation. The IAB's [reference detector documentation](https://github.com/InteractiveAdvertisingBureau/AdBlockDetection/blob/master/README.md) describes measuring hidden ad-like elements and discusses request-based bait. That explains why changing one visible warning or randomizing a stylesheet name cannot establish broad invisibility. No detector code was copied or executed here.

[YouTube's own help page](https://support.google.com/youtube/answer/14129599?hl=en) states that ad blocking can interrupt playback. These short signed-out samples did not reproduce such a warning, so this session adds no speculative bypass. A reproducible legitimate-site case would be needed to justify a narrow compatibility fix. Neither sponsored results nor ordinary search results are certified safe by BlockAds.

Reload BlockAds from the browser's extensions page, then reload affected website tabs to use 1.0.4. Already loaded personal extensions were not changed or reloaded by these tests.
