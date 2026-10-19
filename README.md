# BlockAds Shield

A local Manifest V3 extension for blocking requests to listed ad, tracker and reported-threat addresses, with optional cosmetic element hiding and a YouTube video-ad filter. Runtime code and rules are bundled; the extension does not fetch remote code or filter updates, collect telemetry, or send browsing history to a server.

This is a small, manually maintained starter blocker, not comprehensive malware protection. The bundled sets contain 107 ad rules (94 reviewed domains, 6 URL patterns and 7 hosts recorded by site checks), 80 tracker rules, and 24 exact hosts identified in dated September 2026 security reports. The reported-threat set expires at **2026-11-30 00:00 UTC** unless replaced following another evidence review. The original catalog preserves 73 former threat-list domains as unverified observations; those remain inactive. Lists can miss new threats or block legitimate content. Local installation reduces reliance on automatic extension updates but does not make the extension immune to compromised source files, dependencies or machines.

The [18 October passive domain review](DOMAIN-REVIEW-2026-10-18.md) covered all 73 entries using existing third-party reports, without visiting their sites or downloading files. Under the user-selected requirement for recent dated evidence, none qualified for new malware blocking. Four explicit vendor threat descriptions lacked last-seen dates; unresolved entries remain unverified, not declared safe.

[uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) was used only as a reference for browser-native declarative filtering and permission design. No uBOL code or filter lists were copied.

The [separate dated-threat review](THREAT-ADDITIONS-2026-10-18.md) documents the 24 additions, primary sources, exact scope, expiry and safe verification. Reports establish observed malicious use at their stated dates; this task did not test whether those hosts are still active.

## Install or reload

Requires Chrome/Edge 121+ or Firefox 128+ (YouTube filtering needs Firefox 128's page-world scripts). Version 1.2.0 passed 37 unit tests, 203 rule-builder and 334 threat-list checks, and 277 isolated browser checks in Chrome 155, 277 in Edge 155, and 276 in Firefox 158 on 19 October 2026 (UTC) ([evidence](verification/2026-10-19/)). See [the live-site findings and latest regression checks](LIVE-SITE-VERIFICATION-2026-10-18.md) and [the earlier Edge verification record](EDGE-VERIFICATION-2026-10-18.md).

- **Chrome:** open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this folder.
- **Edge:** open `edge://extensions`, enable Developer mode, select **Load unpacked**, and choose this folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`. Temporary add-ons must be loaded again after Firefox restarts; permanent distribution requires Mozilla signing.

After changing the source or rebuilding the lists, reload the extension from the browser's extension page and reload affected website tabs. An already loaded extension does not automatically pick up these local edits.

## Controls and scope

- The master switch pauses all static and custom network rules and cosmetic filtering.
- Individual switches select the ad, tracker, reported-threat and cosmetic layers. The old unverified malware toggle remains retired. Reported threats are a new layer, enabled by default when evidence is current; saved global pause and existing preferences are preserved.
- Reported-threat rules match only the listed hostname, including its root-dot spelling and ports. They do not infer subdomains or block shared hosting platforms. Explicit site exceptions still take precedence. This covers browser requests, not operating-system DNS or other applications.
- An expiry alarm, hourly guard and worker/startup checks disable the reported-threat layer when its evidence expires. Browser alarms may be delayed during sleep or suspension; disabling occurs when the browser dispatches the alarm or next reconciliation. The popup displays expiry or evidence errors. Missing/malformed policy or unavailable alarms keep this layer inactive; other filters remain usable. Expiry depends on the local clock, and updates require a new manual evidence review and rebuild.
- Site exceptions include subdomains. The popup names an inherited parent exception; **Resume on example.com** removes matching exceptions for that parent scope, including sibling subdomains that inherited it. Cosmetic filtering also respects the top page's exception inside frames from other origins. Reload the page after changing a site exception so frame-level network permissions are recalculated.
- Custom entries accept DNS hostnames, IPv4 addresses, localhost, or HTTP(S) URLs. Only the hostname is used; paths and ports do not limit a domain rule. International names are stored in punycode. A leading `www.` is folded into the parent domain, preserving the original extension behavior. IPv6, credentials and filter syntax are rejected.
- Settings updates are serialized. Success is shown only after the browser accepts the network rules and their readback matches. Failed changes return an error, attempt to restore the previous rules/settings, preserve the entered text and show a retry control.
- Invalid entries saved by an older version are retained in local storage under `quarantinedDomains`, displayed as inactive entries, and excluded from active rules. Add corrected hostnames through the popup.
- Cosmetic filtering hides matching page elements. It does not inspect downloaded files or determine whether a page is trustworthy.
- **Activity log** (popup → *Open activity log*): a page listing recent blocked requests (time, site, blocked server and path, layer) and extension events (settings changes, failures, installs/reloads, skipped YouTube video ads), with a per-server summary showing which sites each blocked server appeared on. It keeps up to 1,000 entries in session storage, so it is cleared when the browser closes; *Clear log* empties it and *Export JSON* saves a copy. Query strings are not recorded, and nothing is sent anywhere. Blocked-request entries come from the browser's rule-match feed, which Chrome and Edge provide while BlockAds is loaded unpacked. Firefox 158 does not provide it (even with `extensions.dnr.feedback` enabled), so in Firefox the log lists events only and says so. The YouTube player-data filter runs in the page and does not report to the log.
- On Fandom, cosmetic filtering also hides its ad wrappers after network blocking leaves them empty. This selector is restricted to Fandom hostnames and follows the existing cosmetic, site-pause and master settings.
- On YouTube (youtube.com, its subdomains and youtube-nocookie.com), the **ad layer** removes the ad schedule (`adPlacements`, `adSlots`, `playerAds`) from the player data before the player reads it, using the bundled `youtube.js` in the page's own script context. If a video ad still starts, the content script mutes it and jumps to its end, then restores the previous speed and sound. The **cosmetic layer** hides YouTube's feed, search, sidebar, masthead and in-player overlay ad slots; these selectors are restricted to YouTube hostnames. Pausing YouTube or turning off the ad layer unregisters the page filter for newly loaded YouTube pages; reload open YouTube tabs after changing it. In a YouTube embed on a paused site, the page filter still runs because it cannot see the parent page.

## Streaming sites, search ads and blocker detection

Visible Chrome checks on 18 October 2026 (version 1.0.4) confirmed that request blocking is active and YouTube/Twitch playback can work, but captured a YouTube video ad with BlockAds enabled. Domain rules cannot block those ads because YouTube serves them from the same hosts as the video.

Version 1.1.0 adds the YouTube filter described above. On 19 October 2026, two signed-out visible Chrome samples of a widely viewed music video showed with BlockAds enabled: no ad-schedule fields in the player data, no ad playing, and the 3:33 music video itself playing at about 10 seconds. With the ad, tracker and cosmetic layers off, the same page received `adPlacements`, `adSlots` and `playerAds` and played a "Sponsored" video ad (84 s and 35 s) with a sponsored sidebar card ([screenshots and evidence](verification/2026-10-19/youtube/)). Big Buck Bunny played normally in both phases and received no ads in either. These are short signed-out samples, not proof against every ad format: YouTube changes its player regularly, may insert ads into the video stream itself, and may show a blocker warning. If ads return, the skip fallback still mutes and jumps over an ad the player labels as one. A short Twitch sample showed no blocker warning, but did not establish suppression of stream ads. Google Search presented an unusual-traffic check with filtering enabled and disabled, so live Search ad coverage remains unverified. Blocking ad hosts does not necessarily remove sponsored results served inside a search page, and the threat list cannot identify every fake organic search result.

There is no general anti-detection layer in this extension. Some sites measure whether ad-like page elements were hidden or ad requests failed; playback can also depend on the site's server responses. A site-specific compatibility change needs a reproducible case and a playback/content regression check. Hiding an entire warning overlay does not establish that playback works. No detection bypass or copied uBOL script/filter list was added during this verification.

On 19 October 2026 (UTC), `tests/site-ad-check.cjs` compared a book page and a chapter page on the Chinese novel site m.xsw.tw. Its ads came from Google AdSense: with ads off each page made about 34–39 ad requests and showed search-ad boxes, an in-page ad badge, a large ad slot and a sticky bottom banner; with BlockAds on, the single ad-loader request was blocked and no ad element appeared ([evidence](verification/2026-10-19/xsw-tw/)). The check did not click or tap. The site omits its intermediate certificate; the check forwards only plain-HTTP certificate downloads so the browser can complete the chain, as a normal browser does.

The same day, the novel site uukanshu.cc was checked in a visible window with one click on an empty page area (its Cloudflare protection refuses headless browsers; no challenge was shown or solved). Version 1.1.0 left a 300×250 ad, a 210×150 ad and a click pop-up to `political-effort.com` in place: those networks were not in any list. The 7 hosts involved are now in `lists/site-ad-hosts.json`. Afterwards, with BlockAds on, the page's three ad-loader requests were blocked, no ad server was contacted, no ad frame appeared and the click opened nothing; with filtering off, the page showed a fake "READ FULL — DOWNLOAD" button, a crypto-casino ad and the click pop-up ([evidence](verification/2026-10-19/uukanshu/)). Domains such as `political-effort.com` look generated and may be replaced by the ad network, so this site needs rechecking over time.

The [live-site record](LIVE-SITE-VERIFICATION-2026-10-18.md) separates observed extension blocks from restrictions imposed by the test proxy, and includes the Fandom before/after check.

## Permissions

| Permission/access | Purpose |
| --- | --- |
| `declarativeNetRequest` | Browser-enforced static and dynamic blocking and site exceptions. |
| `storage` | Local settings, quarantined entries and failure status; the activity log in session storage. |
| `activeTab` | Identify the page when the toolbar popup is opened. |
| `alarms` | Disable dated threat rules when their evidence expires and recheck after suspension. No remote updates. |
| `declarativeNetRequestFeedback` | Local rule matching diagnostics used by the unpacked-extension tests and the activity log; no telemetry. |
| `scripting` + YouTube host access | Register the bundled `youtube.js` filter on youtube.com and youtube-nocookie.com while the ad layer is on; unregister it when the layer, the master switch or a YouTube site pause turns it off. |
| Content scripts on matching pages | Insert and remove cosmetic CSS; this broad page access is needed by the current cosmetic feature. On YouTube it also mutes and skips a video ad that still starts playing. |

## Reviewed catalog and rule builds

The ad/tracker and unverified source of truth remains `lists/reviewed-domains.json`. Its review is explicitly **offline structure only**, not a current reputation check. Source hashes and prior rule scopes are recorded; reputation-verification and expiry fields remain unset. `lists/review-decisions.json` explains exclusions and categories. Six ad URL patterns are kept separately in `lists/browser-patterns.json`, and ad hosts recorded on named sites by `tests/site-ad-check.cjs` in `lists/site-ad-hosts.json`; both are browser-only and never exported. Dated browser threat evidence is a separate, manually reviewed input, `lists/reported-threats.json`; it is not exported to CyberAssist or merged into the version-1 catalog. See [the catalog contracts](lists/README.md).

Use **PowerShell 7+**. The build is offline and treats domains as data; it never resolves them or visits their sites.

```powershell
pwsh -NoProfile -File .\scripts\build-rules.ps1

# Optional: validate and build another catalog with the same closed schema.
pwsh -NoProfile -File .\scripts\build-rules.ps1 -CatalogPath C:\path\reviewed-domains.json
```

The builder validates bounded UTF-8/JSON input, duplicate fields/domains/IDs, DNS syntax, categories, source metadata and browser scope. Invalid input fails without replacing existing outputs. Exact host rules retain exact scope; domain-and-subdomain rules retain their documented wider scope. The shared CDN blanket rule and broad country-code TLD heuristics remain excluded.

`-FetchOnlineLists` and `-UrlhausCsvPath` now fail explicitly without downloading or replacing files. Unreviewed remote data is not automatically promoted into this catalog. No authenticated feed or malware samples are needed for this build.

Successful builds write `rules/ads.json`, `rules/trackers.json`, an empty compatibility `rules/malware.json`, the validated `rules/reviewed-domains.json` catalog, and the separate `rules/threats.json` / `rules/threat-policy.json` pair. Ad, tracker and reported-threat sets are declared as browser rulesets. The catalogs and policy are inert JSON metadata. The runtime reads the policy from the packaged extension, never from a remote server. Rebuilding an old evidence file does not renew its dates or expiry.

Every output is staged before replacement. A failed write triggers restoration of already replaced files; a lock prevents concurrent builds. Sudden power loss during multi-file publication is not an atomic transaction, so retain backups and rerun a successful build before reloading if publication is interrupted.

## Verification

Node 22+ and PowerShell 7+ are sufficient; no third-party test packages are used.

```powershell
node --test tests/background.test.cjs tests/youtube.test.cjs
pwsh -NoProfile -File tests/rules.test.ps1
pwsh -NoProfile -File tests/threat-rules.test.ps1
node tests/browser-smoke.cjs chrome
node tests/browser-smoke.cjs firefox
node tests/browser-smoke.cjs edge
```

The browser script defaults to the standard Windows installation paths; `BLOCKADS_TEST_BROWSER` can select another executable. It copies the extension unchanged into a temporary directory and uses a fresh browser profile. A local deny proxy rejects every non-loopback request without resolving or forwarding it, with speculative DNS disabled. A reserved-name canary verifies that the proxy is enforcing this policy. DNR matching uses synthetic URLs; actual extension blocking is exercised only against loopback HTTP and WebSocket fixtures. Firefox's simulator uses the HTTP(S) handshake representation for WebSocket checks; real local handshake tests separately verify enforcement. The script checks popup errors, site exceptions and cosmetic filtering on an open page, including cross-origin frames. It does not visit listed sites or alter a personal browser profile. The current dated-threat assertion intentionally fails after expiry until evidence is reviewed again.

Evidence and Chromium popup screenshots are saved in the printed temporary directory. Firefox BiDi does not support screenshots of extension pages, so Firefox popup behavior is checked through its DOM. Browser processes started by the test are closed afterward. Unit tests inject failures to cover rollback and quota paths; catalog/build tests use local malformed-data fixtures, rejected legacy imports and a forced publication failure.

On Windows, Edge may relaunch itself during compatibility initialization. The harness follows the endpoint written into its fresh profile using loopback WebSocket debugging, keeps the deny proxy alive through shutdown, and verifies cleanup against that exact test profile. Chrome continues to use a debugging pipe. Expected proxy peer resets are recorded; other proxy errors fail the run. No personal profiles, browser policies or security settings are changed.

Live testing is a separate, explicit opt-in command. It opens a **visible**, signed-out test browser, denies browser file downloads, retains reported-threat filtering during the ad/tracker/cosmetic-off comparison, and permits only named service domains through its proxy. Other providers remain denied in both phases, so absence of ads alone cannot be counted as a pass. Ordinary page resources and video streaming still use the network. It does not open ad destinations, submit forms or solve verification challenges. Pages change over time; a completed observation run does not mean every site's ads were blocked.

```powershell
# Explicitly contacts public YouTube, Twitch, Fandom and Google pages.
node tests/live-site-check.cjs chrome --allow-live-sites

# Optional single-site check (youtube, youtube-ads, twitch, fandom, or google).
# youtube-ads also records which ad-schedule fields reached the page in each phase.

# Any other HTTPS page: headless on/off comparison, no clicks, typing or downloads.
node tests/site-ad-check.cjs chrome https://example.com/page --allow-live-sites

# --visible uses a normal browser window; --click makes one click on an empty
# page area and records (and refuses) any pop-up it triggers.
node tests/site-ad-check.cjs chrome https://example.com/page --allow-live-sites --visible --click
node tests/live-site-check.cjs chrome --allow-live-sites fandom
```

See [the dated-threat verification report](THREAT-ADDITIONS-2026-10-18.md) for version 1.0.3 checks and limits, and [the earlier fixes](CHANGES-2026-10-18.md) for the 1.0.2 baseline.
