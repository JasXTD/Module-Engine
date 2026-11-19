# Preserved project notes — 8 November 2026

This preserves the previous README overview and version-specific installation notes. For current setup, use the [project README](../../README.md#getting-started).

## Previous project overview

*Formerly BlockAds Shield.*

A modular Manifest V3 extension with independent ad-blocking and userscript modules. The blocker filters listed ad, tracker and reported-threat addresses, with cosmetic element hiding, bundled EasyList snapshots, a YouTube video-ad filter and a per-site pop-up blocker. Its engine and rules are bundled. The userscript manager imports local source files and does not fetch script code, assets or updates. Module Engine has no telemetry; scripts you choose to enable can themselves read matching pages and make web requests.

This is a small, manually maintained starter blocker, not comprehensive malware protection. The bundled sets contain 107 ad rules (94 reviewed domains, 6 URL patterns and 7 hosts recorded by site checks), 80 tracker rules, 24 exact hosts identified in dated September 2026 security reports, and a separate **Community lists** layer converted from EasyList and EasyList China snapshots (9,223 network rules and 22,449 site-specific hiding rules from the 19 October 2026 snapshots). The reported-threat set expires at **2026-11-30 00:00 UTC** unless replaced following another evidence review. The original catalog preserves 73 former threat-list domains as unverified observations; those remain inactive. Lists can miss new threats or block legitimate content. Local installation reduces reliance on automatic extension updates but does not make the extension immune to compromised source files, dependencies or machines.

The [18 October passive domain review](DOMAIN-REVIEW-2026-10-18.md) covered all 73 entries using existing third-party reports, without visiting their sites or downloading files. Under the user-selected requirement for recent dated evidence, none qualified for new malware blocking. Four explicit vendor threat descriptions lacked last-seen dates; unresolved entries remain unverified, not declared safe.

[uBlock Origin Lite](https://github.com/uBlockOrigin/uBOL-home) was used as a reference for browser-native declarative filtering and permission design. A focused [uBlock Origin](https://github.com/gorhill/uBlock) source review also informed the 1.8 priorities below. No uBO/uBOL implementation code or converted rulesets were copied.

**Third-party lists.** `lists/community/easylist.txt` and `lists/community/easylistchina.txt` are unmodified snapshots of [EasyList](https://easylist.to/) and [EasyList China](https://github.com/easylist/easylistchina/), by the EasyList authors. Their headers link the licence at https://easylist.to/pages/licence.html, under which EasyList is offered as GPL-3.0-or-later or CC BY-SA 3.0 (that page was not re-read for this change). The converted `rules/community*.json` files are derived from them. If Module Engine is ever distributed, keep this attribution and comply with one of those licences for the lists and their derived rules.

The [separate dated-threat review](THREAT-ADDITIONS-2026-10-18.md) documents the 24 additions, primary sources, exact scope, expiry and safe verification. Reports establish observed malicious use at their stated dates; this task did not test whether those hosts are still active.

## Install or reload

Version **1.9.0** adds **Modules & scripts** in the popup and as the extension's options page. Existing protection settings and rule files retain their behavior. The ad-blocking master switch controls only the blocker; userscripts have a separate module switch, default off, and an individual switch for each saved script. The new **userScripts** permission is optional.

After reloading this folder, open **Modules & scripts**. Choose **Allow userscript access** if prompted. On current Chrome and Edge, also enable **Allow User Scripts** on Module Engine's browser extension-details page, then return and **Refresh status**. Firefox uses the optional permission prompt. Native isolated userscript worlds require a current browser; a missing API or permission leaves the blocker available and displays an access message in the manager. The new module's tested browser versions and Firefox limitations are recorded in the verification section.

Version **1.8.0** adds custom request filters and a reported-threat evidence panel in **My lists**. Request filters narrow blocking by URL path, resource type and initiating site, with explicit request exceptions and protection against overwriting a changed draft. The evidence panel shows defanged hosts, report sources, dates, exact scope and expiry; its status depends on a successful background protection check. No new permissions are required. See [custom request filters](../USER_GUIDE.md#custom-request-filters) and the [1.8 verification evidence](https://github.com/JasXTD/Module-Engine/blob/5206c62e0f7aeb5b4793c7fbd0719610b06db7a5/verification/2026-10-29/network-filters/summary.json).

The visual element picker from 1.7 remains available: select, preview and save a CSS hiding rule, or cancel to restore the preview. See the [picker instructions](../USER_GUIDE.md#visual-element-picker) and [1.7 evidence](https://github.com/JasXTD/Module-Engine/blob/5206c62e0f7aeb5b4793c7fbd0719610b06db7a5/verification/2026-10-29/picker/summary.json).

Advanced page hiding from 1.6 remains available: literal text matching, nested child matching and ancestor selection, with reversible changes and scan limits. The existing local snapshots supply **365 advanced rules**, **14,409 generic selectors**, **24 CSS rules with excluded sites** and **348 host-wide cosmetic exceptions**, in addition to the network and site rules above. These are coverage counts, not a comparison of effectiveness with other blockers. The [1.6 verification evidence](https://github.com/JasXTD/Module-Engine/tree/5206c62e0f7aeb5b4793c7fbd0719610b06db7a5/verification/2026-10-29/procedural) remains available.

Requires Chrome/Edge 121+ or Firefox 128+ (YouTube filtering needs Firefox 128's page-world scripts). Version 1.4.0 passed 55 unit tests, 235 rule-builder and 334 threat-list checks, and 313 isolated browser checks in Chrome 155, 313 in Edge 155, and 311 in Firefox 158.0.1 on 21 October 2026 (UTC) ([evidence](https://github.com/JasXTD/Module-Engine/tree/5206c62e0f7aeb5b4793c7fbd0719610b06db7a5/verification/2026-10-21/flagging)); earlier versions' records are under [verification/2026-10-19](https://github.com/JasXTD/Module-Engine/tree/5206c62e0f7aeb5b4793c7fbd0719610b06db7a5/verification/2026-10-19). See [the live-site findings and latest regression checks](LIVE-SITE-VERIFICATION-2026-10-18.md) and [the earlier Edge verification record](EDGE-VERIFICATION-2026-10-18.md).

- **Chrome:** open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this folder.
- **Edge:** open `edge://extensions`, enable Developer mode, select **Load unpacked**, and choose this folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json`. Temporary add-ons must be loaded again after Firefox restarts; permanent distribution requires Mozilla signing.

After changing the source or rebuilding the lists, reload the extension from the browser's extension page and reload affected website tabs. An already loaded extension does not automatically pick up these local edits.
