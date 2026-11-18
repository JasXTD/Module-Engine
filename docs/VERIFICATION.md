# Module Engine verification

These are dated results, not a promise that every live site is blocked. The latest record is the 18 November 2026 automatic userscript updates, following the same day's release packaging, filter-list updates, the change that turns Reported Threats off by default and adds signed list updates, the repair of the native pop-up and redirect suites, static generic hiding change, reported-threat evidence window change and website-theme detection and cosmetic wildcard-site section, the 17 November Appearance section, the 16 November same-tab MCP navigation change and direction-control review security fix. The 14 November records cover advanced GM options with regex/unwrap matching, userscript lifecycle hardening, YouTube registration/player fixes, read-only MCP network access, optional network metadata capture, the source layout, editor/development tools, optional localhost MCP, the user-requested domain block, deceptive play/download buttons, notification/install prompts and blocker regressions. The 13 November records cover the initial page-script compatibility, read-only MCP debugging, the cookie revocation fix, userscript execution compatibility and broader matching. Older records describe their own source snapshots and limitations.

[Installation](../README.md#getting-started) · [User guide](USER_GUIDE.md) · [Development](DEVELOPMENT.md)

## Automatic userscript updates — 18 November 2026

The user asked for script updates to install themselves. Before this change, every update waited for approval, and applying one paused the script.

- **The rule.** `BlockAdsUserScriptCore.accessChange` lists what an update needs beyond the installed script. That covers new sites or frames, `@grant` and `@connect` entries, the page context and `@run-at`, dependencies, update addresses, `@name` or `@namespace`, and hidden direction controls. Entries are compared as written. `@grant none` grants nothing, so it is never new.
- **Installing.** When a check stages a strictly newer version, the update module hands it to a new runtime operation, `autoApply`. It runs in the userscript control queue against the revision that was checked. It installs the update only if the rule finds nothing and the download address is the script's own. The script keeps its on/off state, GM values, tags and cached dependencies, and enabled scripts pass the usual dependency integrity check. The library commit then re-registers the new code.
- **Waiting for review.** An update that needs more stays staged, with "Waiting for your review: …" naming the reasons.
- **Interface.** *Install updates that need no new access* is on by default. A saved state without it takes the default, and damaged settings turn it off. Installed updates read "Updated automatically", the activity log records them, and *Check all now* reports how many installed.

**697 Node tests** passed, 4 of them new:

- each rule;
- the update module handing over exact bytes and recording the install;
- reasons, failures and the setting;
- a runtime run where an enabled script updates with its values and tags, the registration carries the new code, and a `GM_cookie` update waits.

Six earlier tests' exact-shape assertions now expect the new `autoApply` and `applied` fields. One of them used `applied` as its example of an invalid outcome and now uses `approved`. Writing the tests found that removing a script's only grant produced a spurious "asks for none" reason; it was fixed. Three deliberate faults were each caught: ignoring the access check, ignoring the setting, and not counting new servers.

The userscript install suites passed **80 Chrome 158**, **80 Edge 157** and **70 Firefox 160** checks, and the Chromium layout suite passed **730**. In those runs, a version from the same address installed itself without cookies or a referrer and kept the script paused as it was. The library showed it and the activity log recorded it. The earlier update, which moves to a new download address, still waited for review.

Not run again: the full userscript execution and desktop-helper suites, which this change does not touch.

## Release packaging — 18 November 2026

The user asked for the extension itself to update, and agreed that packaging should be prepared first. Uploading and Mozilla signing need the publisher's own accounts, so nothing was uploaded, signed or pushed. [Releasing](RELEASING.md) describes the process.

- `scripts/package-extension.cjs build` writes a Chromium archive for the Chrome Web Store and Edge Add-ons, a Firefox archive for Mozilla signing, and `SHA256SUMS`.
  - Both archives hold exactly the 93 files of the test inventory.
  - Each manifest drops the other browser's keys; the runtime reads neither.
  - `--firefox-update-url` adds Firefox's `update_url`.
  - The archives are deterministic ZIPs written without dependencies, and .NET's ZIP reader opens them.
- `version <x.y.z>` raises the manifest version, refusing a lower or invalid one.
- `firefox-update` adds a signed package to `updates/firefox/updates.json`, the format Mozilla documents: version, link, `sha256:` hash and minimum Firefox version. It refuses packages without Mozilla's `META-INF` signature, with another add-on ID or without an `update_url`.
- Chrome and Edge update store installs only, so for them preparing means store-ready archives.

**693 Node tests** passed, 7 of them new; they run the script only on temporary copies. They cover:

- byte-for-byte contents;
- manifests per browser;
- reproducible archives and checksums;
- a CRC-32 check value and path refusal;
- missing referenced files;
- version bumps;
- update-manifest refusals, ordering and hashes.

The new `tests/package-browser.cjs` unpacked each built archive and loaded it in a disposable profile, offline. The Chromium archive passed **9** checks in Chrome 158 and Edge 157, and the Firefox archive passed **10** in Firefox 160. Each check confirms:

- the installed version, and only its browser's keys;
- for Firefox, the add-on ID and the update address;
- verified protection, with Reported Threats off;
- a bundled ad host blocked;
- My lists and Modules & scripts loading;
- no uncaught errors.

Not verified: Mozilla signing and validation, store review, and a Firefox install actually updating from `update_url`. These need the publisher's accounts and a public repository. The Firefox add-on ID `blockads-shield@local.extension` becomes permanent with the first signed release, so it should be chosen before then.

## Filter-list updates — 18 November 2026

The user asked for EasyList and EasyList China to update themselves from their publishers. Nothing was pushed.

- **Converter port.** `src/blocking/community-lists.js` ports the PowerShell converter to JavaScript. On the bundled snapshots it gives `rules/community.json` byte for byte (9,223 rules). It also gives the same site hiding data, generic stylesheets, counts and skipped-filter reasons (`tests/community-convert.test.cjs`). It converts both lists, about 102,000 lines, in 0.3–0.4 seconds in Node.
- **Checks.** A new setting, *Update filter lists automatically*, is on by default; existing installs get it too, because the key is new. While protection, Community lists and the setting are on, the background downloads both lists as often as they ask: EasyList every 4 days and EasyList China daily, so daily. After a failure it waits 12 hours. A download needs:
  - an Adblock Plus header, the expected title and a numeric version;
  - no list older than the one in use, and at least one newer;
  - a conversion that keeps at least half of the bundled network and site hiding rules.
- **Installed as a change.** Measured in disposable profiles, Chrome 158 accepts 29,000 dynamic rules (its limit is 30,000), but Firefox 160 refuses 9,500 (its limit is 5,000). The bundled rules therefore cannot simply move to dynamic rules. Instead, the update switches off the bundled rules the new lists dropped with `updateStaticRules`, which both browsers support. It adds new or changed rules as dynamic rules from ID 1,000,001. Merged domain rules are compared domain by domain, so one dropped domain re-adds the other 999 of its chunk and one new domain adds one rule.
- **Safety and scope.** If the browser refuses a change, the previous lists stay. An update made for another release's snapshots is set aside. A change too large for the browser's limits is refused. Site hiding follows the new lists, while generic hiding stays with the release's packaged stylesheets. My lists has a *Filter lists* card with the versions, the change, the last check, the setting and *Check for updates*; the popup line adds "updated".

**686 Node tests** passed, with no failures or skips; 19 are new. The background test harness keeps list updates off unless a test turns them on, so unrelated tests make no downloads. The new tests check that the bundled rules plus the change give exactly the converted lists, domain by domain. Four deliberate faults were each caught: checking with the setting off, skipping the rollback, dropping the rest of a changed chunk, and letting list exceptions undo Module Engine's own blocks. **35 cosmetic, 237 rule/import, 342 threat and 41 requested-host** assertions passed.

The full blocker suites passed **800 Chrome 158**, **800 Edge 157** and **793 Firefox 160** checks. Their fresh profiles tried EasyList at startup, the deny proxy refused it, and nothing else changed. The signed threat-update suite passed **57** checks in each browser. In Chrome and Edge, the redirect suites passed **38**, **28** and **56** checks.

The new `tests/community-updates-browser.cjs` passed **26 checks** in each browser. A loopback server, listed as the publishers in a copy of the extension, served the bundled snapshots with a newer EasyList version and real edits. In each browser:

- the new profile updated itself without cookies or a referrer;
- the browser switched off exactly bundled rules 1 and 336 and held 3 added rules;
- the added domain and pattern were blocked, while the dropped domain and pattern were not;
- the rest of the changed chunk and untouched bundled rules still blocked;
- a new site hiding rule hid its element on a loopback page;
- My lists and the popup showed the update, *Check for updates* found the lists current, and the Community switch removed and restored the added rules without a download.

The deny proxy refused only the browsers' own background traffic.

Limits: the real publishers were not contacted, and the fixture serves its lists without the publishers' caching. Both lists download together, about 2.7 MB a day, because EasyList China asks daily. Generic hiding does not follow updates. The 5,000 switched-off and dynamic-rule limits were checked with small changes and a lowered limit, not with a full-size change. See [the evidence summary](../verification/2026-11-18/filter-list-updates/summary.json).

## Reported Threats off by default, signed list updates — 18 November 2026

The user decided that Reported Threats should be opt-in. They also want its list to update itself from the project's public repository, which they will create as Module-Engine. Nothing was pushed, and no repository or signing key exists yet.

- **Off by default.** `DEFAULT_SETTINGS` now leaves `threats_ruleset` off. Every profile saves its full settings on its first start, so this reaches new installs only; an existing install keeps the choice it saved. A profile saved before the threat layer existed also gets the new default.
- **Signed updates.** `src/background/threat-updates.js` downloads `threat-evidence.sig` first, then the three list files. Each file is capped at 128 KiB and 15 seconds and fetched without cookies, a referrer, redirects or the cache. A list is accepted only when all of these hold:
  - its ECDSA P-256 signature over `threat-evidence.json` verifies against a key in `src/shared/update-config.js`;
  - `BlockAdsEvidence.verify` passes;
  - its review date is not in the future and is later than the list in use;
  - it has not expired.
- **Installation.** The background installs an accepted list as dynamic rules from ID 900001, in place of the static ruleset, and re-verifies it once per worker start. If the browser refuses the new rules, the previous list is restored. A list whose key is no longer trusted, or that is older than the bundled list, is set aside. Checks run at most daily from the hourly recheck while the layer is on, or from **My lists → Check for updates**. My lists shows the list in use, re-verified in the page, with the folder and the last result. The activity log labels blocks by updated rules as Reported threat.
- **This build checks nothing.** `update-config.js` names no folder and no key. `scripts/update-signing.cjs` creates the key outside the repository, sets the folder and signs an `updates/threats/` folder; see [Development](DEVELOPMENT.md#publishing-a-reported-threat-update).

**667 Node tests** passed, with no failures or skips; 19 are new. Against the base commit `6deba43`, 11 of the updated background tests fail: the 8 update tests and the 3 that expect the new default. Three deliberate faults were each caught: checking while the layer is off, keeping expired updated rules, and skipping the rollback after a refused list. **35 cosmetic, 237 rule/import, 342 threat and 41 requested-host** assertions passed.

The full offline blocker suites passed **800 Chrome 158**, **800 Edge 157** and **793 Firefox 160** checks. That includes two new ones, that Reported Threats is off on a new profile and that turning it on enables its rules. Their recorded runtime hashes match the workspace files.

The new `tests/threat-updates-browser.cjs` passed **57 checks** in each browser. A loopback folder signed with a throwaway key served a 23-host list to a copy of the extension that trusts only that key. In each browser:

- nothing was requested while the layer was off;
- turning it on downloaded the four files without cookies or a referrer;
- 23 dynamic rules replaced the bundled ruleset, and the dropped host was no longer blocked;
- site pauses still took precedence, and My lists showed the installed list;
- a tampered newer list was refused while the installed one stayed;
- a valid 22-host list then replaced it.

The deny proxy refused only the browsers' own background traffic.

After the suite repair below landed, the three repaired suites also passed on this change, in Chrome 158 and Edge 157 alike: pop-up guard 38, frame redirects 28 and same-tab redirects 56 checks. Their tested packages hold the 91 inventory files, including the new updater files, with hashes matching this change.

The update flow was tested over loopback HTTP only. The fixture sends the headers raw.githubusercontent.com uses, but no GitHub folder was contacted, and its caching of up to five minutes was not exercised. The other runs used commit `6deba43` plus this change. That is the static generic hiding commit before its verification record was added; its code is identical to `6b37c8e`. This change is based on `0a757a9`, which changes only those three test suites on top of it. See [the evidence summary](../verification/2026-11-18/threat-updates/summary.json).

## Native pop-up and redirect suites — 18 November 2026

Three native suites still packaged the root layout that the 14 November source move replaced: root-level `.js`, `.css` and `.html` files plus `rules` and `icons`. The browsers refused that package before any check ran. Chrome could not load the background script, and Edge could not load `src/shared/shared.js`. The suites now copy and hash the shared inventory in `scripts/extension-files.cjs`, as the blocker and blocked-tab suites do. Their fixtures, assertions, deny proxy and disposable profiles are unchanged, and no extension code changed. This resolves the known limit recorded under static generic hiding below.

| Suite | Chrome 158 | Edge 157 |
| --- | ---: | ---: |
| `tests/popup-guard-browser.cjs` | 38 | 38 |
| `tests/frame-redirects-browser.cjs` | 28 | 28 |
| `tests/same-tab-redirects-browser.cjs` | 56 | 56 |

- Each suite passed twice in each browser. Every run closed its browser without forcing it.
- Run from a `git archive` export of `6b37c8e`, the same suites stopped at extension loading in both browsers, with 0 checks.
- Every tested package held all 89 inventory files, and their hashes match the committed source.
- The deny proxy saw and refused only the browsers' own background services, such as time, sign-in and update checks. No fixture or requested-host request reached it.
- `tests/extension-layout.test.cjs` passed 5 of 5.

Tests used installed browsers, disposable profiles, owned loopback pages and deny proxies. Nothing was installed. [Runs and evidence](../verification/2026-11-18/redirect-suites/summary.json).

## Static generic hiding — 18 November 2026

Generic EasyList selectors used to reach every frame in its settings reply: about 249 KiB of JSON per frame. The frame checked them one by one with `querySelector` and injected them as one 234 KiB style rule after the reply arrived, so every frame showed generic ads first. Blink also ignores the selectors after the first 8,192 simple selectors of one rule, so Chrome and Edge never applied about 6,200 of the 14,409 selectors; Firefox applied all of them.

**What changed:**

- The rule build compiles the generic selectors into two packaged stylesheets, using `scripts/compile-generic-css.cjs`:
  - `rules/community-generic.css` holds the 14,023 selectors that no site exempts.
  - `rules/community-generic-excepted.css` holds the 386 selectors some site exempts. It is not injected on those 620 sites.
  - `genericStatic` in `community-cosmetic.json` describes both. `tests/generic-css.test.cjs` checks that the committed sheets match a rebuild.
- The background registers both sheets for HTTP(S) frames through the existing verified script transaction:
  - The registrations follow the global, Page hiding, Community lists and generic switches.
  - They exclude paused, hiding-paused and `generichide`/`elemhide` sites, and sites with a custom exception for a bundled generic selector.
- Every selector carries `:not(:where([data-me-generic-off] *))`. An open page revokes both sheets by setting that root attribute. It does so after a pause, a switch or a custom exception, and in a cross-origin frame of a paused page; its settings reply then carries the generic selectors that still apply. A companion content script, `src/blocking/generic-static.js`, tells the cosmetic content script that the sheets are present.
- Settings replies carry site rules plus only the generic selectors the sheets leave out. They fell from about 249 KiB to 0.6 KiB on ordinary sites, and to 6–8 KiB on sites that exempt some generic selectors.
- Rules in the sheets, and in the content script's fallback style, hold at most 256 selectors and 8,000 selector characters.
- The DOMContentLoaded request stays, without the selectors. In Firefox, a frame's document-start request can see a stale tab URL. That URL decides the cross-origin pop-up guard and the top page's pauses and prompt exceptions. Removing the request let a frame pop-up load in one Firefox run.

**Behaviour differences, also in the [user guide](USER_GUIDE.md#cosmetic-filtering):**

- Chrome and Edge now apply all 14,409 generic selectors, as Firefox already did, so some extra elements may be hidden there.
- In a cross-origin frame of a paused page, the sheets apply until that frame's settings reply arrives.
- Firefox puts registered stylesheets after the page's own, so they win `!important` ties of equal specificity; Chrome and Edge put them first, so the page wins. Previously the style element was appended to the head when the reply arrived, so its order depended on timing (from the source, not measured).
- About:blank frames still get no generic hiding.

**Timing.** `node tests/generic-timing-browser.cjs chrome` loads an owned page with eight same-origin frames of 300 rows each. Chrome 158 ran 8 loads per variant, in two alternating rounds:

| | Before (`main`) | This change | Generic hiding off |
| --- | ---: | ---: | ---: |
| Frames that showed a generic element before hiding it | 8 of 8 in every load | none | — |
| Frames hiding the last plain generic selector | none | 8 of 8 | — |
| Median renderer main-thread time per load | 438 ms | 434 ms | 184 ms |
| Loads with a task of 50 ms or more | 0 of 8 | 0 of 8 | 0 of 8 |

Hiding now lands before the first paint, and main-thread time is unchanged within the run-to-run spread. A separate sequential run measured 448 ms before and 509 ms after, with three tasks of 52–55 ms after the change; earlier runs measured 560 and 517 ms. The cost moved from JavaScript (message, JSON and `querySelector` checks) into native stylesheet parsing and matching, which now covers 75% more selectors in Chrome. Two alternatives were measured and not adopted:

- A sheet without the revocation condition measured 361 ms against 560 ms before, in an earlier sequential run. But open pages could not be un-hidden without a reload.
- `:not([data-me-generic-off] *)`, without `:where()`, measured 399 ms in the alternating rounds above, about 8% less. But it raises every rule's specificity by one class.

**Design checks run first (Chrome 158 and Firefox, disposable profiles):**

- Registered scripts run after the manifest content scripts: in the same pass in Chrome, at least a task later in Firefox. They share globals, so the companion can notify the cosmetic content script.
- `scripting.removeCSS` cannot withdraw registered CSS in Chrome, though Firefox can, so revocation has to be in CSS.
- A `revert-layer` revocation restored browser defaults rather than the page's own styles: `flex` became `block`. It was dropped.
- Firefox and Chrome both parse every grouped rule of both sheets, as the blocker suite now checks.

**648 Node tests** passed (20 new), with 35 cosmetic, 237 offline rule/import, 342 threat and 41 requested-host assertions, on the final commit, rebased onto `3412640`. Native offline results:

| Browser | Full blocker/UI suite | Userscript layout | Same-tab navigation | Network log |
| --- | ---: | ---: | ---: | ---: |
| Chrome | 798 | 724 | 78 | 49 |
| Edge | 798 | 724 | 78 | — |
| Firefox | 791 | 688 | 74 | 46 |

All three blocker suites and the Firefox layout suite ran on the final commit, Firefox in version 160.0.1. The other userscript columns come from the same change one rebase earlier, on `e05c662`; the last rebase only added `3412640`, which changes different code. Firefox's blocker suite also passed twice with 791 checks on that earlier base.

Each browser parsed every rule of both stylesheets (94 and 3 rules) with none rejected. The fixture page's own style element fell from about 234 KB to 1,534 characters. New unit tests cover the compiler and the committed sheets, the registrations and their rollback, and per-frame replies. They also cover the content script's ordering cases: a late companion, a wrong first judgement, and the DOMContentLoaded retry. The duplicate-request guard was shown to fail without its fix (4 requests instead of 3).

Intermediate attempts are kept under `attempts/`:

- Before the rebase onto the new `main`, the blocker suites passed 794 / 794 / 787. The Firefox userscript layout suite stopped once at the known blocked-pop-up tab step, which `f01d2c3` has since fixed.
- On the rebased source, the Firefox blocker suite twice stopped at the picker's concurrent-exception step: Save after a concurrent exception, waiting for the exception message.
  - It did not recur in 12 later Firefox attempts on this change, eight of them repeats within one run. `main` passed all 9 of its attempts.
  - The cause was not found, so it is not attributed either way.
- One Firefox run stopped at "built-in hiding retains its visibility and pointer safeguards". `.ad-slot` is also a bundled generic selector, so the stylesheet hid the fixture before the built-in rule and its extra safeguards arrived. The suite now waits for the safeguards; the assertion is unchanged.
- With the DOMContentLoaded request removed, a cross-origin frame's pop-up loaded in Firefox ("top-page and cross-origin-frame pop-ups never load"). The request was restored.
  - In the same set of runs, the 6-second button notice once expired during a screenshot, before its check.
  - Both final Firefox runs passed.
- The timing probe crashed when a browser reset a connection at its deny proxy. It now handles resets as the blocker suite does.
- The first Firefox blocker run on the final commit never started. Firefox updated itself to 160.0.1 during launch, and the restart took over the disposable test profile, so the harness timed out waiting for BiDi. The rerun passed.

Known limits:

- Page code can remove the root attribute, much as it could remove the extension's style element.
- Firefox timing was not measured: the trace-based probe supports Chrome and Edge. Per-frame stylesheet memory was not measured.
- `tests/popup-guard-browser.cjs`, `tests/frame-redirects-browser.cjs` and `tests/same-tab-redirects-browser.cjs` still package the root layout used before 14 November, so they cannot load the current extension. They were not run; this predates the change.

Tests used installed browsers, disposable profiles, owned loopback pages and deny proxies. No public site was contacted and nothing was installed. [Runs, timing and evidence](../verification/2026-11-18/generic-static-css/runs.json).

## Reported-threat evidence window — 18 November 2026

The 24-host reported-threat batch was due to switch off on 30 November. A review on 18 November read every Proofpoint Threat Insight post and Volexity blog post published since its sources on 9 September. None renews it. Those posts cover credential phishing (TA419's newest hosts date from July), a proof of concept, a takedown with undated hosts, and IP-only or lab-only indicators. Only Volexity's 21 September post names exact hosts observed in the window, on 3–4 September. Replacing the batch with its three hosts would have moved expiry only to 2 December. The user chose to keep the existing hosts, so the evidence window was raised from 90 to 180 days. No host, source or observation date changed.

- `scripts/threat-report-tools.ps1`, `src/background/background.js` and `src/blocking/evidence.js` now share one 180-day window. The builder and the evidence panel accept only `maxAgeDays: 180`; the runtime refuses an expiry more than 180 days after `evidenceFrom`.
- `lists/reported-threats.json` declares the new window. The rebuilt policy and evidence bundle expire the batch at **28 February 2027 00:00 UTC**; `rules/threats.json` is byte-identical. Only the three threat outputs were taken from a temporary build, so other generated rule files in the shared checkout were not rewritten.

Before the tests were updated, the threat suite's pinned-expiry assertion and 6 Node tests failed on the old date (kept under `attempts/`). New checks cover the window boundary:

- The builder accepts an observation 179 days before review and rejects one at exactly 180.
- The builder and the evidence panel refuse a 90-day catalog.
- The evidence panel refuses 90-day and over-180-day expiries.
- The runtime refuses an expiry one second past the window.

The new builder-boundary and evidence-panel checks fail against the previous commit.

**624 Node tests** passed, with no failures or skips. **342 threat evidence/build** (4 new) and **237 offline rule/import** assertions passed. The full offline blocker suites passed **789 Chrome 158**, **789 Edge 157** and **782 Firefox 160** checks. Each run included the active-policy check and all 216 reported-threat probes, and its recorded runtime hashes match the workspace files. The runs used the shared checkout, which also held the uncommitted website-theme and cosmetic work below.

Expiry timing is covered by the injected-clock unit harness; no browser ran across the boundary. A blocked name can now be up to 180 days past its reported observation, and current ownership was not rechecked. No reported host was visited, resolved or contacted. Reload Module Engine from the browser's extensions page to load the new policy. See [the evidence summary](../verification/2026-11-18/threat-window/summary.json).

## Website-theme detection and cosmetic wildcard sites — 18 November 2026

A review on 18 November used offline probe pages, in Chrome and Firefox, to test the dark website theme on common page patterns. It also traced hiding rules missing from the community bundle. Both problems are fixed.

**Website theme.** The already-dark check misjudged four kinds of page:

- A cookie notice that dims the whole window at load kept the site light for the whole visit, even after it was dismissed.
- Opening a dialog whose dimming backdrop wraps it turned the whole page back to light while it was open.
- A dark banner across the top of a light page kept the page light.
- An app root that switched to its own dark theme after loading was inverted to light grey.

`src/appearance/website-theme.js` now:

- samples the elements painted at each point (`elementsFromPoint`), looking through see-through layers that are fixed, cover the window and are raised by a positive `z-index`;
- counts the page's own background as three of the five points;
- after loading, rechecks a theme attribute change below `<body>` at most every 500 ms. It does so only for an element within five levels of `<body>` that spans the page, so carousels and buttons start no work.

The same probe pages, before → after (Chrome / Firefox):

| Page | Before | After |
| --- | --- | --- |
| Cookie notice, then dismissed | `off`, page 255 | `on`, page 13 / 12 |
| Dialog with a wrapping backdrop, open | `off` | `on` |
| Dark banner over a light page | `off`, page 255 | `on`, page 13 / 12 |
| App root turns dark after load | `on`, page 227 / 224 | `off`, own 17 |

A dark page waiting on a slow `<head>` script still shows no light flash: first paint follows detection in both engines.

The browser check's test image changed from (200,120,60) to a light (235,205,150). The page filter leaves the old colour almost unchanged (183,111,57), so an image left inverted could still pass. With the new colour it would read about (80,53,4) and fail.

**Cosmetic wildcard sites.** `scripts/community-list-tools.ps1` skipped a whole hiding rule when any of its sites was a `name.*` wildcard. For example, EasyList's `##.ad` rule lists about 300 sites, cnn.com, nytimes.com and foxnews.com among them, together with `tripadvisor.*`. The converter now drops only the unsupported site. A rule is still skipped when no included site is left, which would make it generic, or when an excluded site is unsupported, which would widen it.

The rebuilt bundle:

- 517 more site selectors (22,449 → 22,966), on 238 more sites (9,684 → 9,922), with none removed;
- generic, scoped, procedural and exception data unchanged;
- whole-rule wildcard skips down from 317 to 249; 94 dropped sites are counted in `community-info.json`;
- every other generated rule file byte-identical.

| Check | Result |
| --- | ---: |
| Node unit tests | 623 passed (3 new) |
| Cosmetic compiler / rule import / threat / requested-host assertions | 30 (9 new) / 237 / 338 / 41 |
| Full blocker/UI suite, Chrome / Edge / Firefox | 789 / 789 / 782 |
| Website-theme pass alone, Chrome / Edge / Firefox | 29 / 29 / 28 |

The three new unit tests fail against the original `website-theme.js`, and the extended converter test fails against the original converter. With the original script, the browser pass stops at the new cookie-notice check. All pass after the fix, and every earlier test passes on both versions.

The suites ran on a copy of the baseline commit plus only these files, so concurrent edits by other sessions could not leak in. The full suites used Chrome 157.0.8103.79, Edge 157.0.4341.60 and Firefox 160.0. Chrome updated itself to 158.0.8127.37 before the website-theme pass alone, which also passed.

One attempt in the shared working tree failed: `tests/rules.test.ps1` ("offline rebuild is deterministic"). Another session changed the threat list between that test's two builds; the same suite passed on the frozen copy. The first Firefox website-theme run stopped at browser startup and passed on retry.

Known limits:

- Sites given only as `name.*` wildcards are still unsupported; that needs public-suffix matching (249 rules).
- Dimming layers other than `<dialog>` backdrops still render as a grey veil (127–150 on a 12–13 page).
- A see-through layer without a positive `z-index` counts as the page's own background.
- A first screen that is dark at all five points makes a page count as dark, even if it is light further down.
- No live sites were visited.

[Evidence, probe results and hashes](../verification/2026-11-18/website-theme-detection/summary.json).

## Appearance — 17 November 2026

A sixth sidebar section, **Appearance**, chooses System, Light or Dark and an accent colour: seven presets or any custom colour. Optionally, light websites follow a dark theme too.

**Module Engine pages:**

- `src/ui/shared/theme.js` runs in the `<head>` of every packaged page, including the popup and same-tab sections. It applies a `localStorage` copy of the theme and accent before first paint, then the stored `appearance` value, and follows later changes.
- An explicit theme overrides the system scheme, and the editor's syntax colours became theme tokens so they follow it too.
- A custom accent keeps its exact fill. Its text and edges shift in OKLCH lightness at constant hue until text reaches 4.5:1 and edges 1.9:1 against each theme's surfaces. The default lime keeps its hand-tuned values, and default users store nothing.

**Websites** are off by default:

- When switched on, the new manifest content script `src/appearance/website-theme.js` applies a filter-based dark mode whenever the theme is dark. Media and frames are turned back to their own colours.
- Already-dark pages are recognised and left alone, and per-site exceptions follow the tab's site.
- While websites are off it reads one setting per frame and changes nothing.
- No permission was added. The blocker's registered-script transaction is untouched; the one background change answers a frame's question about its tab's site.

**620 Node tests** passed (18 new), with 21 cosmetic, 237 offline rule/import and 338 threat evidence/build assertions, and syntax checks for 18 changed JavaScript files. Final native offline results:

| Browser | Full blocker/UI suite (with Appearance and websites) | Same-tab navigation | Userscript layout | Network log |
| --- | ---: | ---: | ---: | ---: |
| Chrome | 785 | 78 | 724 | 49 |
| Edge | 785 | 78 | 724 | — |
| Firefox | 778 | 74 | 685 | 46 |

These **4,806 native checks** include two passes per browser that use real pointer clicks.

The **Appearance pass**:

- Light and Dark beat an emulated opposite system scheme on the popup, Modules & scripts, My lists, Activity log and Appearance pages, including editor syntax colours. System then follows both schemes again.
- The Sky preset reaches every page with the derived text and edge shades for each theme, and the popup's master switch fills with it.
- A custom red is saved, selects no preset and shows the status-colour caution.
- A reloaded page reapplies the saved choice and shares the first-paint copy.
- A choice made in a same-tab Appearance section updates its host page.
- Reset clears storage, attributes and the cache everywhere.

The **website pass** reads rendered screenshot pixels on owned localhost pages:

- An open light page darkens without a reload. In Chrome and Firefox the page measured 12–13, a raster image (200,120,60) came back as (192–194,120–121,66–67), and a light cross-origin frame darkened itself to 24–25.
- A modal dialog is dark, and its backdrop dims the page instead of lightening it.
- Already-dark pages, and a page that turns dark after loading, are left alone.
- The popup's site switch and Appearance's typed list keep a site and its cross-origin frames in their own colours.
- Light and System follow the device, a reloaded page comes up dark, and switching off removes every trace.
- Reset keeps the website setting and its sites.

Both themes, the Websites card, the popup row and desktop/narrow layouts were inspected in Chrome and Firefox screenshots. Engine behaviour that differs was measured, not assumed:

- Chrome's root filter leaves the canvas, top layer and page scrollbar outside it; Firefox's covers them, backdrops included.
- The website theme picks its rules by engine, and the pixel checks pass in both.

Unit tests cover the colour contrast across 424 colours, `ui.css` token and light-block parity, page wiring, and every website-theme decision against an offline document. Each targeted regression was shown to fail against a deliberately broken copy:

- the stale-read guard removed;
- a single changed light token;
- text left unadjusted;
- a page without `theme.js`;
- inline-style mutations no longer filtered.

Firefox reports "Promise resolved after context unloaded" when a page closes while a content script awaits extension storage. Five suites exempted that exact browser-generated message only for `src/blocking/content.js`. They now also exempt it for `src/appearance/website-theme.js`, with the same message patterns; the Chromium paths are unchanged. The final Firefox layout and navigation runs each logged one such website-theme report, so without the exemption they would have failed.

Intermediate attempts are listed in the summary:

- Fixture corrections:
  - Chromium returns stored objects with sorted keys.
  - Switch transitions must finish before their colours are read.
  - Frame controls below the 485-pixel test viewport must be scrolled into view.
  - A pixel sample must avoid text.
  - A background tab hears colour-scheme changes only once shown.
- One Chrome navigation run failed with "Inspected target navigated or closed" while waiting through a tab reload; later runs passed.
- The Firefox userscript layout suite passed on its eighth completed attempt on the final source; a ninth, earlier run was stopped while the test exemption was corrected. The seven failures stopped at:
  - the install-update step, five times, where a tagged library row is re-rendered before its click (`tests/userscripts-install-browser.cjs:143`);
  - the external-editor file watch, once;
  - the blocked-pop-up tab check, once, which reads tabs before the background has finished closing one.
- The untouched baseline commit failed the same install-update step in one of two focused install runs and the external-editor step in one of two layout runs. The 16 November record already lists this Edge/Firefox update-row sequencing failure as open, so these failures are not attributed to this change. They remain unresolved.

Known limits:

- The first-paint guarantee for Module Engine pages rests on unit tests and the `<head>` placement check, not paint timing.
- A website's first moment can still be light while its setting loads.
- The native colour picker cannot be automated, so its value and events were set directly.
- Filter-based website darkening dulls strongly saturated media and inverts stylesheet background pictures.
- The Chrome and Edge navigation and layout runs used the harness before the Firefox-only exemption change; those Firefox-only filters do not affect them.

Tests used installed browsers, disposable profiles, owned localhost content and deny proxies. No public sites, personal profiles or new software were involved. [Evidence, exact checks and source hashes](../verification/2026-11-17/appearance/summary.json).

## Same-tab MCP navigation — 16 November 2026

MCP and the other four sidebar sections now stay in one browser tab. The existing packaged documents are loaded once, kept hidden/inert when inactive, and reused. MCP approval, pending reviews, unsaved editor drafts, Network capture and scroll positions remain in their owning documents. The sidebar reports the MCP connection and pending proposal count. Back/Forward uses local history state without changing the native port sender URL. Explicit Disconnect, reload, closing the tab or leaving the app still revokes approval; switching sections does not extend the 30-minute limits.

**590 Node tests**, **637 PowerShell rule assertions** and syntax checks for **10 JavaScript files** passed. Final native offline results:

| Browser | Same-tab navigation | Existing MCP suite | Full blocker/UI suite |
| --- | ---: | ---: | ---: |
| Chrome | 76 (stdio) | 169 (both read transports; stdio proposals) | 739 |
| Edge | 76 (HTTP) | — | 739 |
| Firefox | 72 (stdio) | — | 733 |

These **2,604 native checks** cover real extension ports, no extra tab on MCP activation, rapid and keyboard navigation, modal review protection, retained drafts, trusted and synthetic proposal decisions, native userscript execution, hidden Network capture, scope revocation/reapproval, Back/Forward, direct MCP entry, real reload and close, and leaving an embedded section for an owned localhost page. Local ad canaries stayed blocked. All final package hashes match the checkout; blocker, rules, permissions, native authorization and server code are unchanged. The blocker fixture retains its existing Reddit hostname alias only in disposable copies, with original and fixture hashes recorded separately.

Desktop and narrow Chrome/Edge layouts and Firefox's desktop layout were inspected. Three focused review rounds covered document/port ownership and failure paths, bounded retained views and hidden polling, then affected consumers, layout and final source/evidence consistency. Navigation creates at most four child documents per tab; it adds no dependency, storage migration or background service.

Intermediate fixture failures are retained: corrected saved-script metadata lookup, current-section selector and generated test expression; Firefox uses native reload because same-URL navigation creates a fresh history entry. The Firefox fixture also retains its browser-generated dropped content-script reply diagnostics separately, using the exact existing blocker/install convention. No unexpected navigation or MCP errors remained. Full combined userscript suites, forced tab discard and a real-time 30-minute expiry soak were not repeated; expiry and permission boundaries retain their existing unit coverage.

Tests used installed browsers, disposable profiles, owned localhost content and deny proxies. No public sites, personal profiles, desktop helper permissions or new software were involved. [Evidence, exact checks and source hashes](../verification/2026-11-16/navigation/summary.json).

## Direction-control source review — 16 November 2026

Confirmed the Low-severity audit finding against `d249340`: raw Unicode directional controls were accepted without a parser/lint warning, and enabling required no acknowledgment. The regression tests reproduced both behaviors before the fix. Shared source reviews now show visible escapes, code points and original UTF-16 line/column positions. MCP also escapes metadata, headings and unverified notes. The editor warns without classifying otherwise valid source as a syntax error. All original source bytes remain unchanged; ordinary RTL text and textual JavaScript escapes remain supported.

The native enable command requires an explicit acknowledgment after checking the current revision. MCP refuses an unacknowledged Apply & enable before saving anything. The UI accepts acknowledgment only from trusted interaction; a different proposal or later enable cannot inherit it. Applying without enabling still saves a paused script. Undoing a disable cannot silently reenable affected code. Existing enabled scripts are not forcibly paused on reload; this does not scan dependencies or detect every form of misleading code.

**590 Node tests passed**, with no failures, cancellations or skips. All 12 changed/new JavaScript files passed syntax checks. Final native, offline checks:

| Browser | URL install/update review | MCP reads and change proposals |
| --- | ---: | ---: |
| Chrome | 75 | 169 (stdio proposals; both read transports) |
| Edge | 75 | 108 (HTTP proposals and reads) |
| Firefox | 65 | 164 (stdio proposals; both read transports) |

These **656 browser checks** include actual escaped previews, trusted and synthetic acknowledgment, cancellation, exact stored bytes, native script execution, update/proposal reset, MCP scope/revocation and blocked localhost ad canaries. No unexpected proxy or MCP runtime errors remained. Desktop and 390-pixel Chrome enable-dialog screenshots were visually inspected, along with the narrow MCP card. Firefox's install fixture covers its current viewport; this pass did not add a Firefox viewport override. Three focused review rounds covered authorization and stale revisions, bounded diagnostics and unchanged bytes, then UI and final diff consistency.

Testing used installed browsers, disposable profiles, authored localhost scripts and deny proxies. No public sites, personal profiles, OS desktop helpers or new dependencies were used. Manifest permissions, ad-blocker code/rules and MCP server transport code are unchanged. Full blocker suites and the broader combined userscript sequence were not rerun for this narrowly scoped fix; the audit's separate Edge/Firefox update-row sequencing failure is not claimed fixed by these passing targeted suites. All executable package hashes match the tested files. The two Chrome runs precede a documentation-only change to `docs/MCP.md`; their exact document snapshot is retained separately.

The 13 pre-existing verification-record edits were preserved byte-for-byte and contain only line-ending changes compared with the starting commit. [Evidence, checks and source hashes](../verification/2026-11-16/bidi-review/summary.json).

## Advanced GM options and regex/unwrap matching — 14 November 2026

Added Violentmonkey-compatible options and matching. `GM_xmlhttpRequest`/`GM_download` accept `user`/`password` (preemptive HTTP Basic; an explicit `Authorization` header wins, and cross-origin redirects drop it). Requests accept ReadableStream bodies, read completely within the 8 MiB upload limit. Downloads accept `conflictAction: 'overwrite' | 'prompt'`; Firefox rejects `prompt` before transferring. `GM_cookie` accepts `partitionKey` for the calling tab's own top-level site and, in Firefox, its own `firstPartyDomain`. Firefox `GM_openInTab` keeps the source tab's container or uses `container`. Regex `@include`/`@exclude` now accept lookarounds, numbered and named backreferences, named groups, lazy quantifiers, `(?-i:)` modifiers and Annex B legacy syntax. `@unwrap` accepts every wrapped-script scope through a separate pre-check script. The 8 MiB response and 16 MiB download limits are unchanged.

**553 Node tests passed**, with no failures or skips. They include the existing native-regex differential test plus over 1,000 generated patterns with lookarounds, backreferences, named groups and Annex B atoms. A larger scratch run made about 21.5 million comparisons across about 13,800 generated patterns. Its only mismatch was a reproducible Node V8 bug: `(?-i:(a)|(?=x{)|x{|x{|a|a)` matches `"A"` natively, contrary to the spec; simpler forms agree. Modifiers therefore use explicit spec cases. Other unit checks cover linear lookarounds and fail-closed backreference searches on 30,000-character URLs, raw-scope guards that run nothing and create no binding when excluded, credentials, stream cancellation, collision policies, partition limits and container selection.

| Browser | Combined userscript suite (layout) | Execution | Firefox desktop helpers |
| --- | ---: | ---: | ---: |
| Chrome | 635 | 52 | — |
| Edge | 635 | 52 | — |
| Firefox | 602 | 52 | 54 |

The raw guard was first confirmed by experiment. With error suppression disabled, Chrome reported `SyntaxError: Identifier '__moduleEngineScope_…' has already been declared` on the skipped page, next to a deliberate control error; with suppression enabled, only the control remained. In page mode with a later `@run-at`, a page `error` listener still received the error, so page-world guards now run as a separate document-start registration. In the final runs, neither Chrome/Edge consoles nor page listeners show a skipped-script error. Firefox page mode is equally quiet. Firefox's isolated sandbox logs one console redeclaration per skipped page, and the fixture asserts exactly that. The first marker name used the install ID; it now hashes the source, because page code can see the marker.

Firefox findings: its native `downloads.download` rejects `prompt` with "conflictAction prompt not yet implemented", and `overwrite` replaced a real file with the newer download. Firefox containers 1 (inherited) and 2 (explicit) were confirmed through `tabs.query`. In Firefox's isolated sandbox, `new ReadableStream({...})` with a script-owned source is refused, and a script-written `TransformStream` chunk reads back as `undefined`; `Blob.stream()` uploads work. The fixture asserts the clear rejection for the lost chunk. Two Firefox layout runs failed on existing timing races (blocked-popup cleanup before a tab lookup; the Prepare dependencies click probe), each passing on rerun. One of my fixture edits had a template-literal escape bug that stopped the HTTP fixture script from parsing; it was fixed and the fixture body is now compile-checked before runs.

Not verified natively: Chromium `overwrite`/`prompt` file behavior. The Chromium desktop suite requires a person to accept the browser's helper-permission dialog (`node tests/userscripts-browser.cjs chrome --desktop-only --native-helper-prompt`, likewise `edge`). Unit tests verify both values reach `downloads.download`. Challenge-based HTTP authentication and incremental request streaming are not implemented. Blocker code and rules are unchanged. The only shared harness edits are a Firefox containers pref and a bounded script-error recorder, and the full Firefox blocker suite passed **733 checks** with them. The Chromium blocker suites were not rerun.

Tests used installed browsers, disposable profiles, owned loopback pages and deny proxies. No live sites, third-party scripts, personal profiles or new dependencies were involved. Manifest permissions are unchanged. [Evidence and source hashes](../verification/2026-11-14/gm-options-matching/runs.json).

## Userscript startup, navigation and reconnects — 14 November 2026

Hardened the existing page/GM bridge and shared userscript runner. Trusted lifecycle transitions now control suspension; synthetic events cannot close the bridge or create duplicate channels. Delayed startup runs once after the DOM becomes available. Navigation invalidates unsent queued work and stale read results, while submitted storage/cookie mutations retain their real completion status without returning old value snapshots. Port ownership, handshake timers, finite reconnects and terminal cleanup prevent stale callbacks from stopping a resumed script. Grants, native authorization, default injection mode and auto fallback policy are unchanged.

**542 Node tests passed**, with no failures, cancellations or skips. Seven lifecycle regressions failed before implementation; final review reproduced an eighth failure where retry exhaustion retained a document-body observer. Tests also cover bounded pending calls, stale replies, preserved mutation outcomes, queued-write cancellation, delayed startup, synthetic events, duplicate restoration and old timer callbacks. Intermediate failures caught the existing cookie-write completion contract; the final implementation preserves it rather than weakening those assertions.

The final combined offline suites passed **590 Edge / 590 Chrome / 557 Firefox** checks. They cover matching, editor/external-file workflows, installation/update review, GM storage/listeners/menus, DOM/tab helpers, dependencies/HTTP, page-world execution and both read-only MCP transports, including network reads. All three browsers actually restored a cached document (`persisted: true`, unchanged instance marker) and retained one source execution, current values and working menus. Edge and Chrome also passed real extension-worker restart probes; Firefox's background document does not use that Chromium probe. Disabling a script while away prevented GM access on return. No unexpected runtime or proxy errors remained.

The existing full Edge blocker suite separately passed **739 checks**, and local ad canaries stayed blocked in all three combined userscript suites. All 76 runtime-file hashes match the final checkout in the four final runs. Manifest permissions, blocker/rule files, the native authorization broker and production MCP code are unchanged. Three focused review rounds covered lifetime ownership, response semantics, resource cleanup and affected consumers.

An early native fixture used `menuId` instead of the command's actual `id`; it was corrected. The first combined Edge run later exposed an existing MCP test-helper race: it requested a replacement pairing code before asynchronous disconnect completed. The helper now waits for the server's disconnected state; the final Edge run observed that wait once. Earlier failed/pre-final runs and their source differences are retained, alongside final evidence.

Tests used installed browsers, disposable profiles, owned loopback pages, synthetic data and deny proxies. No live third-party userscripts/sites, personal profiles, operating-system clipboard writes or desktop notifications were exercised. No dependency installation, commit or push was performed. This hardens the existing page execution path; it does not add raw `@unwrap` features, full Violentmonkey parity or new isolation from page code. [Evidence and source hashes](../verification/2026-11-14/page-lifecycle/summary.json).

## YouTube registration and player fallback — 14 November 2026

Fixed the unregister/re-register window during unrelated protection changes: retained scripts update in place, new/obsolete IDs alone are added/removed, exclusions clear explicitly, and rollback uses the same verified reconciliation. The page filter now handles bounded nested/batched player data, preserves late initial responses, skips getters/frozen branches safely, and filters supported same-origin player API text before a cached parser consumes it. The isolated fallback observes player/control changes as well as media events, guards seeks, restores owned media state and releases observers on disable/navigation. See [the implementation bounds and test commands](DEVELOPMENT.md#youtube-filtering-and-registration).

**532 Node tests passed**, with no failures, cancellations or skips. Six new regression cases failed against the original code and passed after the fix. Four older assertions initially assumed registration array order; they now compare complete registrations by ID. Additional cases exercise native-parse contracts, traversal limits, independent setter failures, unseekable/live media, resource limits and cleanup.

Focused native fixtures passed **40 Edge / 40 Chrome / 39 Firefox** checks. They exercise first-inline-script filtering at document start, nested batches, real fetch JSON/text/clone/body-consumption behavior, locally generated media decoding/seeking, dynamic skip controls, sound/rate restoration, replacement media, site/ad/cosmetic controls, simultaneous navigation/settings changes, trusted history navigation and synthetic-event rejection. Firefox has one fewer check because the Chromium launcher exposes an additional process-close assertion.

The unchanged full blocker suites passed **739 Edge / 739 Chrome / 733 Firefox** checks. Runtime hashes match the final checkout in all six successful native runs. Manifest permissions, rule bundles and userscript implementations are unchanged; the manifest adds only the isolated fallback module. Three focused review rounds covered transactions, bounded work/lifecycle, affected consumers and fixture correctness.

The first two Edge fixture attempts correctly refused a seek because the initial local media server exposed a `[0, 0]` seekable range; byte-range serving fixed the fixture. The third used an incorrect speed baseline after native `load()` reset it; the baseline is now established after that reset. These failures and the final passing evidence are retained. No guard was relaxed to pass a test.

All browser tests used disposable profiles, owned loopback pages, locally generated silent media and an external-traffic deny proxy. YouTube policy is aliased only onto the owned fixture route in disposable copies, with original and fixture hashes recorded separately. No live YouTube page, personal browser session or real failing ad was tested, so this is not a claim of complete live YouTube coverage. No dependency installation, commit or push was performed. [Evidence and source hashes](../verification/2026-11-14/youtube/summary.json).

## MCP network reads — 14 November 2026

Added `module_engine_get_network_log` under a separate, initially unchecked **Captured network request metadata** scope. Existing Scripts/Logs approval does not grant it. The tool copies the latest matching sanitized records, with URL/method/tab/type/status/state filters, a 100-entry / 128 KiB response bound, `matched` / `truncated`, and capture status. It has no access to capture-control commands and cannot start, stop, clear or extend capture, replay requests, or change protection. The MCP contract version is 1.1.0; stdio remains the default.

**517 Node tests passed**, with no failures, cancellations or skips. New checks verify separate approval, no storage/timer/capture mutations, retained-data sanitization, newest-match filtering, byte bounds, read failures and suppression of pending results after revocation. The initial focused run caught one remaining six-tool assertion, which was updated for the seventh read-only tool; the passing rerun is retained alongside it.

The final native MCP suites passed **133 Chrome / 133 Edge / 129 Firefox** checks. Each suite runs real stdio and localhost HTTP server processes against an isolated browser. Locally authored requests exercise live/stopped reads, GET/POST metadata, redirects, HTTP errors, network failures, filters and redaction. The blocked localhost canary does not reach its server. Reads of stopped capture leave its session data identical, capture-control arguments are refused, and disconnect/reapproval cannot inherit the network scope. Existing script/source/matching and managed-error reads still work. Both server processes close cleanly, with no unexpected output or uncaught browser runtime errors.

The complete blocker/UI regressions also passed **739 Chrome / 739 Edge / 733 Firefox** checks, including the changed sidebar navigation and narrow layout, native filtering, settings transactions and existing page protections. Tested versions were Chrome 157.0.8103.79, Edge 157.0.4341.46 and Firefox 160.0. All 75 packaged file hashes match the final runtime, and both MCP transports match the current server/contract hashes.

**MCP** now appears in the sidebar on all full extension pages, alongside the existing top-right manager button. MCP and Network links between those pages open separately to preserve their independently owned connection/capture lifetimes. Desktop and narrow Chrome/Edge layouts and the Firefox desktop page were inspected. The native MCP run does not resize Firefox's extension viewport; shared narrow navigation remains covered by the blocker/UI suite.

Three review rounds covered the capability boundary, asynchronous lifecycle and response bounds, then UI/consumer consistency. Cached entry sizes avoid reserializing records just to select a bounded response; one shared transport runner replaces duplicated harness loops. Snapshot comparison confirms unchanged blocking/userscript implementations, manifest permissions/version/identity and the stdio/HTTP transport implementations. The first passing Chrome attempt precedes the final cached-size optimization, docs and runtime-error assertion; the final run uses matching package hashes.

Testing was offline with installed browsers, disposable profiles, local fixtures and deny proxies. No public threat sites, new dependencies, personal profiles or real client configuration were involved. The test approvals apply only to disposable browser profiles. Users must reload the extension, restart their configured MCP server and explicitly approve Network sharing in their own browser. Results contain no headers, cookies or bodies; paths can still be private. The tool has no pagination cursor and does not expose Windows-wide traffic or a complete request history. Nothing was committed or pushed.

[Evidence, hashes, screenshots and retained attempts](../verification/2026-11-14/mcp-network/summary.json). The starting snapshot remains at `.artifacts/2026-11-14-mcp-network-before`. [Setup and read filters](MCP.md#reading-captured-network-requests).

## Network metadata capture — 14 November 2026

Added an optional **Network** page with all-browser or selected-tab capture, request/response timing, status/error details, redirect hops, filters, live-view pause, pagination and filtered JSON exports. Capture is independent of blocking and userscripts. It starts off, stops with its owning page/selected tab or after 30 minutes, and retains only sanitized metadata in bounded session storage. It does not request new permissions, alter requests or expose entries through MCP.

**510 Node tests passed**, with no failures, cancellations or skips. The 23 network-log tests cover native sender authorization, projection/redaction, redirect/partial events, stop/clear/restore, asynchronous disconnects, storage errors and ordering, observer attachment failure, and entry/byte/viewer/command limits.

| Browser | Native Network and GM checks | Full blocker and UI checks |
| --- | ---: | ---: |
| Chrome 157.0.8103.79 | 49 | 739 |
| Edge 157.0.4341.46 | 49 | 739 |
| Firefox 160.0 | 46 | 733 |

The native fixture sends local GET/POST requests, redirects, HTTP errors and connection failures, holds a response across Clear, exports through the real browser download mechanism, and exercises tab scope, owner/viewer disconnects, filters, keyboard details, paging and paused views. An authored userscript uses GM storage and HTTP during capture; the blocked localhost canary never reaches its server. All three browsers reported a failure for that blocked canary. Generic errors are displayed without claiming blocker attribution. Final native runs had no unexpected uncaught runtime errors.

Desktop light/dark, empty and disconnected screenshots were inspected, along with narrow Chrome/Edge layouts. Firefox's narrow page was measured inside a same-origin extension frame because its automation API cannot resize extension viewports. The final UI preserves table nodes when polling unchanged data and keeps long native tab IDs on one line. Full blocker suites check the changed sidebar and existing protections. Snapshot comparison confirms unchanged blocking/userscript implementations, rules, vendor files, manifest permissions, version and identity; only the intended integration, UI, tests and documentation changed.

Retained unsuccessful attempts include the background unit fixture's missing `clearTimeout`, a Firefox test expression incompatible with its automation wrapper, and reading Firefox's export before the native `.part` download finished. These harness issues were fixed and the affected checks rerun. Initial passing Chrome/Edge captures preceded the final polling/layout refinement; the final runs match all 75 packaged runtime file hashes.

Testing used installed browsers, disposable profiles, owned loopback fixtures and deny proxies. No public threat sites, personal profiles, downloads of third-party code or additional dependencies were involved. WebSocket handshake projection, background restore, expiry and storage failures were unit-tested; native WebSocket frames and live-site completeness were not tested. The browser API cannot provide other-app traffic, every request, headers/bodies or WebSocket message contents through this feature. The earlier source-layout pass covers the broader userscript/MCP workflows; desktop OS helpers were not repeated here. Nothing was committed or pushed.

[Evidence, hashes, retained attempts and screenshots](../verification/2026-11-14/network-log/summary.json). The starting snapshot remains at `.artifacts/2026-11-14-network-log-before`. [Repeat the offline capture checks](DEVELOPMENT.md#network-metadata-capture).

## Source layout — 14 November 2026

Moved 50 application JavaScript, HTML and CSS files into `src/background`, `src/blocking`, `src/userscripts`, `src/ui` and `src/shared`. The root `manifest.json` and the folder loaded by the browser stay in place. Manifest entries, HTML assets/navigation, worker imports, dynamic injections, private helper authorization paths, Node helpers, tests and current documentation use the new locations. One shared runtime inventory replaces eight duplicated package lists.

**487 Node tests passed**, with no failures, cancellations or skips. Five new checks cover packaged resource resolution and startup replacement of old root-level native registrations while retaining settings, userscript source and saved GM values. **637 offline PowerShell assertions passed**: 21 cosmetic, 237 rule/import, 338 threat/build and 41 requested-host checks. The rule compiler imports the relocated production parser.

| Browser | Blocker and UI checks | Userscript layout and MCP checks |
| --- | ---: | ---: |
| Chrome 157 | 739 | 523 |
| Edge 157 | 739 | 523 |
| Firefox 160 | 733 | 491 |

The combined userscript suites exercise matching, editor workers and metadata suggestions, external-file review, installation/updates, storage/listeners/menus, execution order, DOM/tab helpers, cached dependencies, HTTP, page-world access, synthetic cookies, FormData uploads, the private helper document and both MCP transports. Local ad canaries remain blocked throughout. The blocker suites cover native rules, settings transactions, page protections, injected helpers and relocated page navigation. Desktop/narrow screenshots, Firefox's actual toolbar popup, themes and editor/MCP states were inspected.

Snapshot comparison confirms that moved JavaScript ASTs change only in paths, HTML changes only resource/navigation references, and CSS remains identical. Manifest permissions, version, extension identity, storage keys and native registration IDs are unchanged. Rules, lists, icons, vendored assets and the external-file helper match the starting snapshot. The three Node MCP entry points and the compiler also change only import paths. Tested package hashes match the final runtime files.

Retained attempts include an old raw-link assertion corrected to compare resolved URLs, a Firefox toolbar check that sampled its 16-by-8 placeholder before layout, and Firefox closed-page promise diagnostics now recorded separately using exact source/message checks already reflected in the blocker suite. One combined Chrome run timed out on a native cookie write; the isolated page test passed 78 checks, then the complete suite passed without changing cookie code. One Firefox automation startup timed out before extension loading; a fresh run passed. The causes of those two transient timeouts were not established, and their evidence remains separate from the final passing runs.

Testing used installed browsers, disposable profiles, locally authored fixtures and deny proxies. No public threat sites or third-party userscripts were opened. Operating-system clipboard writes, desktop notifications and larger downloads were not repeated in this path-only pass. Existing personal profiles were not changed; upgrade preservation was checked through the registration regression and unchanged persistence contracts. No dependency was installed, and nothing was committed or pushed.

[Evidence, mapping, hashes, retained attempts and screenshots](../verification/2026-11-14/src-layout/summary.json). The local starting snapshot remains at `.artifacts/2026-11-14-src-layout-before`. [Repeat the offline checks](DEVELOPMENT.md#source-layout-regression).

## Editor and development tools — 14 November 2026

Metadata suggestions use the supported core directives and GM APIs and preserve native textarea undo. The optional external-editor helper reads one chosen UTF-8 `.user.js` file through an authenticated loopback session. Changes wait for **Load into draft**, and the normal explicit **Save** still validates revisions and pauses the script. MCP, blocker code/rules and manifest permissions are unchanged. See [setup and boundaries](USER_GUIDE.md#editing-and-organizing-scripts).

**482 Node tests passed** with no failures, cancellations or skips. The 16 focused editor/helper checks include inert syntax inspection, CRLF metadata, token replacements, body/selection boundaries, strict pairing codes, Host/Origin/authentication checks, malformed requests, one-use and expired sessions, concurrent pairing, atomic replacement, missing/oversized/non-UTF8 files, junction redirection, a real CLI process, and slow clients that send partial bodies.

Final disposable native editor suites passed **83 checks in Chrome**, **83 in Edge**, and **73 in Firefox**, with no uncaught editor errors or unexpected proxy socket errors. They exercise native keyboard and pointer completion, undo/redo, composition-state guards, CRLF draft state, actual file-helper HTTP pairing, synthetic-click rejection, explicit source review, cancellation, file changes during confirmation, unchanged saved execution during review, paused saves, retained tags, continued tracking across saves, stale revisions, stop/reconnect and switching drafts. The local ad canary stayed blocked during script execution and external review in all three browsers. The comprehensive blocker suite recorded below was not repeated in this pass; its implementation and rules match the starting snapshot.

The CRLF regression was reproduced before its parser fix: a closing-marker regex could consume the newline after the last metadata entry and leave a stray carriage return. The additional Firefox pointer test also failed before its fix: a compatibility `mousedown` moved focus away after cancelled `pointerdown`, hiding the list before click. Retained event traces show the corrected click retaining textarea focus. Early failed tests and intermediate browser runs remain in the evidence. Two early mockup launches failed at sandbox process control or extension loading; a minimal static preview then rendered successfully in a disposable profile.

Desktop and narrow Chrome/Edge layouts, Firefox desktop layouts, native focus/disabled/error states and screenshots were inspected. Composition-event handling was exercised; a physical OS input method was not. Testing used only locally authored scripts/files/pages, installed browsers, Node core and deny proxies. No public threat sites or third-party userscripts were opened, no package was installed, no personal browser/MCP configuration was changed, and nothing was committed or pushed. This does not establish general JavaScript IntelliSense, live-site compatibility or protection against software already controlling the same user account.

[Evidence, source hashes, screenshots and retained attempts](../verification/2026-11-14/editor-development/summary.json). A task-specific starting snapshot is kept locally under `.artifacts/2026-11-14-editor-dev-before`.

## Localhost MCP and requested domain — 14 November 2026

Stdio remains the default. The optional HTTP endpoint requires an environment bearer token, binds only `127.0.0.1`, validates the exact Host, rejects supplied Origins and exposes the same six read-only tools. The separate browser bridge still requires explicit approval and its own token. Session expiry and authenticated DELETE revoke browser access, pending reads and unused pairing codes; reconnecting cannot inherit approval. No new dependency or browser permission was added. See [setup and transport limits](MCP.md).

**469 Node tests passed**, with no failures, cancellations or skips. The 23 focused MCP tests cover both transports, closed schemas, authentication, header/body validation, bounds, concurrent initialization, cancellation, dropped connections, expiry, stale results, startup failure and cleanup. **637 offline PowerShell assertions passed**: 21 cosmetic, 237 rule/import, 338 threat-evidence/build and 41 requested-host checks.

| Browser | HTTP MCP | Default stdio MCP | Full blocker regression |
| --- | ---: | ---: | ---: |
| Chrome 157 | 44 | 40 | 739 |
| Edge 157 | 44 | 40 | 739 |
| Firefox 160 | 41 | 37 | 733 |

The native MCP runs launch the actual server process, approve a disposable extension with trusted input, inspect owned scripts and captured errors, and verify scope rejection, unchanged saved configuration, revocation, reapproval and continued ad blocking. Packaged extension bytes, the ad rules and the separate server source hashes match the final checkout. Desktop and narrow MCP screenshots were inspected. HTTP test helpers DELETE their session before the fixture terminates them; unit tests also cover graceful shutdown. Personal Codex configuration was not changed, and a real Codex model tool call was not tested.

`wheelroot.com` and all its subdomains are now blocked through the existing user-requested ad rules. The earlier exact `pxl.wheelroot.com` entry remains as request history. This records the user's report and blocking preference, without an independent malware classification. Native rule evaluation verifies navigation, resources, subdomains, lookalikes, credentials, explicit allow preferences and the ad-layer switch. Disabling that layer or pausing protection disables these blocks.

Review exposed a raw query/fragment boundary issue in the new regex; a failing offline fixture now passes after restricting authority characters. Native tests also accounted for the older exact rule winning over the overlapping domain rule. Firefox's simulator uses the HTTP(S) handshake representation for WebSockets, as in the existing threat tests; evidence retains both URLs. Each browser additionally blocks a real localhost WebSocket using the new rule pattern with only the hostname, rule ID and resource scope adjusted for the fixture, then successfully reconnects after removal. Firefox's exact intentional connection-error message is retained as expected network evidence for that owned page; unrelated errors still fail.

Earlier attempts include one Chrome manager-startup timeout, one Firefox browser-automation startup timeout, a test-only process-start deadline, and fixture errors around intentional socket closure and expected network-error classification. The startup causes were not established; independent final runs passed, and failed attempts remain separate from passing evidence. Three review rounds checked shared RPC ownership, hostname boundaries and preserved preferences, then native behavior, packaging, documentation and cleanup.

All browser tests used disposable profiles and denied external traffic. No reported domain was visited or resolved for verification, no new package was installed, and nothing was committed or pushed. These results verify the local source snapshot, not live-site reputation or universal protection. See [retained results and limitations](../verification/2026-11-14/mcp-http/summary.json).

## Button protection — 14 November 2026

Deceptive play/download protection starts enabled, shares the existing prompt exceptions and remains independent of cosmetic hiding and network rules. It requires an ad placement, an external link covering a real video player, or a Play action pointing to an installer/script filename. No new dependency or browser permission was added. The master switch, full site pause and trusted-site exceptions remain effective.

**454 Node tests passed**, without failures, cancellations or skips. **622 offline PowerShell assertions passed**: 21 cosmetic, 237 rule/import, 338 threat-evidence/build and 26 requested-host checks. The full browser blocker suites passed **721 Chrome 157**, **721 Edge 157** and **715 Firefox 160** checks. Existing page-script/GM compatibility also passed **78 Chrome**, **78 Edge** and **75 Firefox** checks.

Owned loopback fixtures verify native left/middle/double clicks, Enter/Space, empty player-covering links, fresh reason feedback, early page-handler suppression and absence of delayed/transient tabs. Coverage includes dynamically changed controls, open shadow roots, HTTP frames, navigation away/back, notice expiry, live settings, trusted-site exceptions and selected-site popup/notification guard coexistence. Negative fixtures preserve actual local video playback, a byte-exact CSV download, ordinary external Download navigation, installer/media links, form submission, hidden labels, article labels and distant wrapper labels. Existing ads, network filters, Reddit repair, prompt cleanup, picker and light/dark/narrow UI regressions remain in the full suites. New control and notice screenshots were inspected.

The initial Chrome fixture demonstrated the original gap: a marked ad Download reached early page handlers and fragment navigation. Firefox diagnostics found that centered video input could hit its browser-owned Picture-in-Picture UI without page events. Final tests target the page link away from that native control and require a fresh trusted-input notice on every blocked gesture. A separate ordinary link verifies permitted new-tab behavior. One fresh Chrome attempt timed out before initial extension state arrived; no runtime error was reported, its cause was not established, and the full rerun passed unchanged assertions. All attempts remain separate from final passing evidence.

Three review rounds bounded text traversal by elements as well as text, removed unnecessary child enumeration, narrowed loose ad-label ancestry, checked state ownership and rollback, and reviewed packaging, UI and documentation. No page-wide button observer or per-click extension request was added. Final packages contain no diagnostic event tracing.

All browser tests use disposable profiles and deny external traffic. No suspicious site was visited, no executable was downloaded or opened, no external reputation service was used, and nothing was committed or pushed. Detection is conservative; live sites, native touch devices, browser-owned controls, context-menu navigation and deliberate evasion are not covered by these results. See [usage and limits](USER_GUIDE.md#deceptive-play-and-download-buttons) and the [retained evidence](../verification/2026-11-14/button-protection/summary.json).

## Prompt protection — 14 November 2026

Both new prompt switches start enabled and have a shared trusted-site exception list. Notification API hooks run at document start in top pages; DOM prompt policies share the existing Reddit cleanup engine so scroll, pointer and inert repairs have one owner. Network ad filtering, Reddit's site scope and userscript settings retain their existing controls.

**448 Node tests passed**, with no failures, cancellations or skips. **622 offline PowerShell assertions passed**: 21 cosmetic, 237 rule/import, 338 threat-evidence/build and 26 requested-host assertions.

| Browser | Full blocker, Reddit, prompt and UI checks | Page-script compatibility |
| --- | ---: | ---: |
| Chrome 157 | 607 | 78 |
| Edge 157 | 607 | 78 |
| Firefox 160.0 | 601 | 75 |

The browser runs use installed browsers, disposable profiles, authored loopback fixtures and deny-all external proxies. They verify first-page-script notification interception, asynchronous callback/promise denial without changing saved permission, a trusted click, accessible iframe APIs and rejection of the page's PushManager subscription before any push-service call. DOM checks include native modal/backdrop cleanup, decorative scrims, real clicks and scrolling, unrelated modal/widget preservation, independently switched policies, live exceptions, reloaded native APIs, reused dialogs, open shadow roots and ad canaries. Ordinary download/extension dialogs, warnings, quoted articles, inline content, camera prompts, CAPTCHA controls and non-rendered script data remain visible. Actual popup switches and exception controls, light/dark styles, narrow layouts and keyboard focus are included; prompt screenshots were inspected.

The tests found and fixed concatenated text-node boundaries that missed a notification overlay. Earlier attempts also record a fixture restoration error, Firefox fixture-expression syntax, a Firefox startup timeout before extension loading and an Edge process-inventory timeout after behavior checks. The page-order regression now waits for both document-end scripts before asserting their exact order; native navigation completion alone can precede those tasks in Firefox. The final full runs pass and close their disposable browsers; the attempts remain separate from passing evidence.

No dependencies or browser permissions were added. No listed or suspicious site was visited, no downloaded executable was opened, no external push service was contacted and nothing was pushed. Native behavior for an already granted permission is unit-tested with a controlled API; saved browser permission changes and real desktop notifications were not exercised. Page hooks require reload to change, do not revoke prior permissions, and are not a browser-wide or tamper-proof policy. Pattern matching is conservative, English-only and bounded; live scam coverage is unverified. See [usage and limitations](USER_GUIDE.md#notification-and-install-prompts).

The [retained evidence](../verification/2026-11-14/prompt-protection/summary.json) includes final source hashes, fixture-override verification, screenshots, initial attempts and cleanup records.

## Page-script compatibility — 13 November 2026

Page scripts can combine real `unsafeWindow` access with granted GM APIs. Wrapped `auto` tries page first and falls back only when page startup is refused. The page bridge preserves site CSP and Trusted Types; exceptions after startup never rerun the source. Default content mode, raw `@unwrap` behavior and the existing ad-blocking modules remain intact. Older saved auto scripts retain isolation until individually re-enabled.

**408 Node tests passed**, with no failures, cancellations or skips. Coverage includes capability separation, fixed native routing/identity, pending-work bounds, suspension/reconnection, no retry after uncertain completion, safe upgrade behavior, native grant/scope revocation and accurate MCP mode reporting.

| Browser | Page compatibility | Userscripts, excluding desktop helpers | MCP page-error capture | Blocker suite |
| --- | ---: | ---: | ---: | ---: |
| Chrome 157 | 78 | 443 | 40 | 573 |
| Edge 157 | 78 | 443 | 40 | 573 |
| Firefox 160 | 75 | 362 | 37 | 567 |

All native checks used installed browsers, disposable profiles, project-owned loopback fixtures and deny proxies. Page checks exercised actual page objects and lexical globals, modern/legacy storage, menus, cross-tab listeners, FormData/Blob uploads with redirects, synthetic HttpOnly cookies and optional permissions, timing, configured execution order, frames, policy fallback and live revocation. Local ad canaries remained blocked. MCP tests launched the actual project stdio process and captured an exception from a real page-bridge script; each server exited cleanly. No personal MCP client or browser profile was configured.

Initial Chrome probes showed that USER_SCRIPT insertion alone could not run the page wrapper. A native MAIN bootstrap resolved that without relaxing policy. The first full Firefox pass found a Trusted Types refusal during string-based cleanup; removing child nodes fixed it, and the final Firefox policy fixtures passed. These attempts and the final runs are retained in the [evidence and source-hash report](../verification/2026-11-13/userscript-page/summary.json).

Three focused review rounds covered authorization/migration, lifecycle and simplification, then packaging/UI/documentation. Explicit page compilation omits its unused isolated fallback body. Final production hashes match all 12 final native test packages; existing disposable clipboard-sink prefixes and the local Reddit fixture alias were separately verified. The manager warning was visually inspected at 1280 and 390 pixels in Chrome and at Firefox's native desktop width, with no clipped text or horizontal page overflow. After evidence retention and process, resolved-path and reparse-point checks, all 23 disposable run directories were removed. The pre-task working snapshot remains in ignored `.artifacts/2026-11-13-page-before`.

Page mode shares trust with the site: page code can observe or invoke its script's granted helpers. It is not an isolation boundary. Raw `@unwrap` auto remains isolated; explicitly select page for raw page globals. Clipboard/notification/download desktop suites and unchanged rule builders were not rerun; the full blocker and ordinary userscript regressions passed. No public sites or third-party userscripts were executed. No packages were installed, and nothing was committed or pushed.

## Read-only MCP — 13 November 2026

Added **MCP → Read-only debugging** with an optional Node-core stdio server, one-time pairing, explicit browser scopes, 30-minute sessions and page-close/disconnect revocation. Status inspection does not repair registrations or write settings. Scripts and logs use explicit field projections; cookies, saved GM values, page content and arbitrary evaluation/extension commands are outside this interface. See [setup and capture limits](MCP.md).

**401 Node tests passed**, with no failures, cancellations or skips. The 18 new checks cover the MCP lifecycle, malformed framing, Host/Origin/token validation, scope restrictions, expiry, cancellation, size/concurrency limits, redaction, read-only drift detection, diagnostic authentication, floods, preserved exceptions and stale approval/result rejection.

| Browser | Native MCP | Userscripts, excluding desktop helpers | Blocker suite |
| --- | ---: | ---: | ---: |
| Chrome 157 | 39 | 443 | 573 |
| Edge 157 | 39 | 443 | 573 |
| Firefox 160 | 36 | 362 | 567 |

Native MCP tests launched the actual stdio server with a project-owned JSON-RPC client and the production extension files in disposable browser profiles. They connected using trusted native input, read source/metadata/status/matching/activity, captured an actual userscript exception, verified unchanged persisted configuration, refused unapproved scopes, revoked access after disconnect/page closure, and kept an owned local ad canary blocked. Each server exited cleanly. This does not claim that a personal Codex/MCP client was configured or that live sites were tested.

Visual inspection covered the final MCP page at 1280 and 390 pixels in Chromium and at Firefox's native desktop width. Firefox's harness cannot resize extension pages through its viewport API; its desktop screenshot and the Chromium narrow layouts are recorded separately. The initial Chrome/Edge MCP passes preceded the requested naming/layout update; final runs use the current UI. The [evidence and source hashes](../verification/2026-11-13/mcp/summary.json) retain both snapshots.

Three focused review rounds checked trust boundaries/data projection, resource lifetime and simplification, and packaging/UI/documentation. Final runtime hashes match the actual MCP and blocker test packages. The full userscript suites preserve their existing disposable clipboard-sink prefix in `background.js`; its source/fixture hashes and unchanged production suffix were verified separately. Existing Reddit fixture aliases remain confined to the offline blocker package. All 11 disposable test directories were removed after evidence retention, process/path checks and reparse-point checks. Personal browser profiles and OS clipboard data were not used. No tools/dependencies were installed, and nothing was committed or pushed by this task.

Captured errors are limited to existing native messaging worlds: wrapper exceptions, top-level-await rejections and errors reported by managed GM callbacks. General page-console messages, raw/page-world scripts and unrelated asynchronous errors remain outside capture. Source and error text may contain private content and are untrusted data. Desktop clipboard/notification/download helper suites and unchanged rule builders were not rerun. All native tests used owned fixtures behind deny proxies.

## Cookie write revocation fix — 13 November 2026

Fixed the audit finding where a native cookie write could complete after access was revoked while the caller received a rejection. Authorization still precedes dispatch. Submitted writes now preserve the native result; a timeout explicitly reports an unknown outcome, without retry or rollback. Revoked reads and new calls remain blocked. The two-second deadline still releases the broker queue, while native work retains its capacity slot until settlement.

**383 Node tests passed**, with no failures or skips. All eight delayed set/delete cases failed before the fix and passed afterward. The **21 focused cookie checks** cover promise/callback results, permission loss, scope exit, page suspension, connection revocation, native failures, rejection before dispatch, late-read suppression, deadlines, capacity release and shutdown. Delays are injected into the native API mock; actual browser cookie operations use synthetic cookies in fresh profiles.

| Browser | Full userscript suite, excluding desktop helpers | Full blocker |
| --- | ---: | ---: |
| Chrome 157 | 443 | 573 |
| Edge 157 | 443 | 573 |
| Firefox 160 | 362 | 567 |

The first Edge run lost a native script-selection click and later timed out at the tag editor. The test now confirms the selected script before typing and records bounded click retries. Chrome also passed **43 focused editor checks** with the updated fixture. A later Chrome run attempted to read an export that was still downloading; that check now waits for the matching native download completion before checking its exact contents. Full reruns passed. Both failed runs are retained in the [verification report](../verification/2026-11-13/cookie-revocation/summary.json).

Three review rounds checked authorization/result delivery, simplification and resource lifetime, and affected callers/documentation. Recorded source hashes for final passing runs match the workspace, including concurrent edits to the log and list pages that this fix preserved. The three cookie runtime files also match the actual tested packages. The retained failed Edge run records its earlier snapshot separately. Existing clipboard/Reddit test overrides remain confined to disposable packages. All browser tests used owned fixtures and deny proxies; no personal cookies or profiles were accessed. No tools or dependencies were installed, and nothing was committed or pushed.

A submitted browser write remains uncancellable, and an unloaded caller may never receive its result. Optional clipboard, notification and download desktop suites and unchanged rule builders were not rerun. These offline checks do not establish live-site coverage. Reload the extension and affected pages to activate the fix.

## Userscript execution compatibility — 13 November 2026

Added `unsafeWindow` in the selected native world, `GM_cookie` / `GM.cookie` list/set/delete, `@top-level-await` and native-scope `@unwrap`. Implementation is original and follows the documented subset in the [user guide](USER_GUIDE.md#execution-compatibility). Cookies require a new **optional** permission, the script's exact grant and current-frame authorization; they stay within the calling tab's native store. Personal browser profiles and real cookies were not accessed.

**370 Node tests passed**, with no failures or skips. New coverage includes execution flags and diagnostics, preserved unwrapped globals, cached dependency order, asynchronous errors, cookie grants/callbacks/store selection, host and parent-domain scope, unsupported partitions, permission changes, late-result suppression, deadlines and revocation after an await.

| Browser | Userscripts, including execution and cookies | Full blocker |
| --- | ---: | ---: |
| Chrome 157 | 443 | 573 |
| Edge 157 | 443 | 573 |
| Firefox 160 | 362 | 567 |

All native suites used installed browsers, disposable profiles, owned loopback pages and locally authored scripts behind deny proxies. Existing matching fixtures route fixed example aliases directly to loopback without resolving public names. The new fixtures verify actual page/isolated globals, real GM awaits, raw declarations observed by page scripts, exclusions/noframes, synthetic HttpOnly cookies, native permission controls, scope exits and revocation. Manager cookie review was visually inspected at 1280 and 390 pixels. Final package source hashes match the workspace; existing clipboard/Reddit fixture overrides remain confined to disposable copies and are separately recorded.

Three focused review rounds covered trust/scope, simplification/resource use and final consumers/documentation. Compiler/linter bindings and cookie scope presentation are shared. Duplicate frame probes were removed without dropping the checks before native operations or result delivery. In-flight reads are discarded after permission loss, scope exit or page suspension; expired native calls retain bounded slots and cannot perform later writes. Writes already submitted to the browser cannot be cancelled.

The initial four execution tests failed against the original unsupported implementation. Existing negative tests for `GM_cookie` and top-level await were updated to test genuinely unsupported names, while positive tests exercise the newly supported behavior. The first sandboxed Chrome launch failed with Windows access restrictions; scoped execution resolved it, and its old process ID was confirmed absent. Retained attempts are labeled; only completed passing runs appear above.

The optional desktop-helper suites and unchanged PowerShell/rule builders were not rerun in this pass. No external test assets, third-party scripts or packages were downloaded or installed; no malware site was visited. Live-site compatibility and complete Violentmonkey parity are not claimed. Page-world privileged GM APIs remain unavailable; unwrapped scripts reject extended scopes and document-body; cookie partition options are unsupported. Reload the extension and affected pages to activate the changes.

See the [verification report, hashes, attempts and screenshots](../verification/2026-11-13/userscript-execution/summary.json). Nothing was committed or pushed.

```powershell
node --test tests/*.test.cjs
node tests/userscripts-browser.cjs chrome --execution-only
node tests/userscripts-browser.cjs edge --execution-only
node tests/userscripts-firefox.cjs firefox --execution-only
node tests/userscripts-browser.cjs chrome --skip-desktop
node tests/userscripts-browser.cjs edge --skip-desktop
node tests/userscripts-firefox.cjs firefox --skip-desktop
node tests/browser-smoke.cjs chrome
node tests/browser-smoke.cjs edge
node tests/browser-smoke.cjs firefox
```

## Broader userscript matching — 13 November 2026

Added bounded regex includes/excludes, extended HTTP(S) match patterns (host wildcards, ports, IPv6, internationalized hosts and fragments) and `.tld` matching with a pinned local Public Suffix List. Inclusion remains a union and exclusions take precedence. The wrapper and GM broker use the same matcher; `@connect`, script timing and blocker policies retain their contracts.

**358 Node tests passed**, without failures or skips, including more than 200,000 small regex comparisons, suffix wildcard/exception/private-domain cases, deceptive hosts, exact wrapper/broker agreement and renderer-probe failure paths. The three offline PowerShell suites passed **21 cosmetic, 237 rule/import and 338 threat assertions**. The suffix generator's integrity and reproducibility check passed.

| Browser | Userscripts, including matching | Full blocker | Blocked-tab cleanup |
| --- | ---: | ---: | ---: |
| Chrome 157 | 401 | 573 | 25 |
| Edge 157 | 401 | 573 | 25 |
| Firefox 160 | 322 | 567 | 28 |

Native checks use locally authored pages and scripts. Fixed example-domain aliases reach only an owned loopback server through an explicit proxy route; no public alias is resolved or contacted. All other proxied traffic is denied. Tests cover both isolated and page-world scripts, ports, fragments, regex and suffix inclusion/exclusion, real GM calls, history changes in top/child frames and a blocked local ad canary. IPv6 and IDN normalization also have focused unit coverage. The core suites retain editor, install/update, storage, menu, tab-helper, request and shutdown-pressure regressions. Optional clipboard, notification, download and upload-progress permission suites were not rerun in this matching pass; their earlier evidence is separate below.

A native Chrome failure exposed a stale sender URL after `pushState`. It is fixed by checking the current frame in the broker with the existing scripting permission. Probes fail closed on errors, changed documents or a two-second timeout; unresolved calls retain bounded slots, and late results cannot perform expired operations. Adversarial local regex fixtures also reproduced excessive empty-alternative work and empty-group compilation. Both now have explicit work limits; duplicate epsilon visits count and identical empty branches are deduplicated. Earlier failures and interrupted runs are retained, with no passing result claimed for incomplete attempts.

Three final review rounds covered matching/security boundaries, lifecycle/resource use, and loaders/documentation/compatibility. Only actual `.tld` hostname rules include the suffix data in injected wrappers. Manager layouts were inspected at 1280 and 390 pixels. The approved data's pinned Git blob/SHA-256 checks and user-reported clean Malwarebytes scan are recorded; no new software was installed and no independent antivirus scan is claimed.

See the [report, source hashes, attempts and regression evidence](../verification/2026-11-13/userscript-matching/summary.json). These tests do not establish live-site compatibility or full Violentmonkey parity. Reload the extension and affected pages to use the changes. No commit or push was made.

Focused commands (from the repository root):

```powershell
node scripts/build-userscript-suffixes.cjs --check
node --test tests/userscripts-matching.test.cjs tests/userscripts.test.cjs
node tests/userscripts-browser.cjs chrome --matching-only
node tests/userscripts-browser.cjs edge --matching-only
node tests/userscripts-firefox.cjs firefox --matching-only
```

## Userscript editor and transfers — 13 November 2026

Added syntax highlighting, line numbers and exact syntax-error navigation; author/local tags with search and filtering; configurable script start order; FormData and native upload progress; up to five checked redirects; 8 MiB request/response limits and 16 MiB downloads. **345 unit tests passed**, with no failures or skips. The approved Acorn 8.18.0 parser was copied from the signed local Node installation, with its MIT license and provenance. The user reported a clean Malwarebytes scan; Defender was disabled and could not scan. No new executable or test package was installed.

| Browser | Userscript checks | Ad-blocking checks | Blocked-tab cleanup |
| --- | --- | ---: | ---: |
| Chrome 157 | 310 core/editor; 54 helper-stage checks | 573 | 25 |
| Edge 157 | 310 core/editor; 54 helper-stage checks | 573 | 25 |
| Firefox 160.0 | 275 combined | 567 | 28 |

Native fixtures verified script order at document-start/end/idle, tag persistence and stale-order rejection, inert source highlighting, error selection, multipart duplicates/Unicode/binary bytes, separate upload/response progress, redirect method changes, forbidden destinations never contacted, anonymous cookies in both directions, cancellation and an exact 3 MiB saved file. Desktop/narrow editor layouts and light/dark error states were visually inspected. Shared offscreen helper leases, permission removal, budget release and failure paths have unit coverage. All final core, Edge helper, Firefox combined, blocker and blocked-tab package hashes match the final production source.

Chrome completed its helper stage before a later dependency-panel frame wait timed out; its remaining 310 checks passed headlessly. That helper snapshot predates only the final permission-removal predicate and review-dialog close guard, covered by final unit/core/Firefox checks. Two Firefox attempts completed 273 functional checks but failed the unchanged console assertion on `content.js` Conduits messages after tab unload. The final run recorded empty console snapshots after every stage and passed all 275 checks without suppressing errors. That intermittent teardown behavior is not claimed fixed. Failed attempts and their exact source hashes remain in the report.

The tests also found and fixed Firefox cross-world binary serialization, Firefox/Chromium redirect-header differences, anonymous XHR sending cookies despite `withCredentials=false`, and an older review dialog's queued close event closing the next review. Three simplification/review rounds covered lifecycle/security, bounded allocations/editor rendering and final callers/compatibility. The final guide explains start-order versus asynchronous completion, optional helper access, per-hop scope checks and the shared reservation allowance.

All runtime traffic used owned loopback fixtures behind deny proxies in disposable profiles. No live or suspicious site was visited. Clipboard checks used the existing test sink without reading or changing the Windows clipboard. Downloaded fixtures were harmless owned bytes, never opened. Results do not establish live-site compatibility or full Violentmonkey parity; transfers remain buffered and capped. See the [report, attempts, hashes, screenshots and scoped diff](../verification/2026-11-13/userscript-editor-network/summary.json). Reload the extension and matching pages; use **Allow helper access** for upload progress and Firefox redirect following. No commit or push was made.

## Frame takeovers and server redirects — 12 November 2026

The two earlier bypasses were reproduced with the unchanged guard, then closed with a scoped browser sandbox and cancellation before the first scripted document request. The latest manager UI and other existing changes were inspected and checkpointed first. **333 unit tests passed** with no failures or skips, including rollback/retry when the policy write, readback, script registration or settings save fails.

| Browser | Frame/video checks | Navigation checks | Pop-up checks | Blocked-tab cleanup | Full blocker checks |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chrome 157 | 28 | 56 | 38 | 25 | 573 |
| Edge 157 | 28 | 56 | 38 | 25 | 573 |

Each browser exercised a locally recorded WebM: it decoded, advanced, paused, resumed, sought and entered/exited fullscreen after an independent ad listener attempted to replace the top page. Nested frames inherited the restriction. Player frames could still follow their own HTTP redirects, their origin/storage remained usable, and existing stricter server sandbox policies remained enforced. Scripted same-site redirect chains were stopped before their first request; top video and document identity survived. Normal visible links/forms, intentional link redirects, browser reload/history and page routing through history/hash updates remained usable. Header-policy matches were not misreported as blocked requests. Disabling or pausing and reloading restored frame navigation.

The scope is deliberately stricter: script-only full-page buttons, script reloads and intentional frame-to-top navigation are stopped too. A blocked navigation may interrupt its current JavaScript handler; players that require that behavior can need the per-site guard disabled. Real links/forms may follow redirects. Service-worker-generated document responses can bypass response-header policies, and page-hook tampering/restricted injection remain limitations. No live player, DRM service, old browser binary or Firefox was tested in this pass; playback compatibility is established for these fixtures only.

Tests used disposable profiles, owned loopback pages and deny proxies; Chrome was visible for the media, navigation and full blocker runs, and Edge was headless. WebM bytes were generated in browser memory, with no downloaded media, packages or tools. No suspicious destination was contacted. The first WebM fixture stalled while unguarded; explicitly loading its generated Blob resolved the fixture readiness issue, and that failed attempt is retained. The existing full blocker fixture's Reddit hostname alias and blocked-tab fixture rules stayed confined to their temporary packages. See the [report, hashes, screenshots, attempts and checkpoint diff](../verification/2026-11-12/frame-redirects/summary.json). Reload the extension and the affected page to apply or remove the document policy. Manifest permissions/version and packaged list rules are unchanged; no rule builder was run.

## Same-tab redirect guard — 12 November 2026

This earlier snapshot identified the frame and server-chain bypasses addressed by the subsequent pass above. Its counts and limitations describe that earlier code.

The existing per-site switch now reads **Block pop-ups and redirects**. After inspecting and checkpointing the current uncommitted source, the old guard was reproduced allowing a play-button `location.href` redirect to an owned local destination. The updated guard cancels supported top-document departures before the destination request while leaving the generated video playing. **328 Node tests** passed with no failures or skips.

| Browser | Redirect and compatibility checks | Existing pop-up checks | Full blocker checks |
| --- | ---: | ---: | ---: |
| Chrome 157 | 51 | 38 | 571 |
| Edge 157 | 51 | 38 | 571 |

Native coverage includes `location.href`, `assign`, `replace`, delayed redirects, `navigation.navigate`, meta refresh, script-submitted forms, synthetic clicks, changed link destinations and expired click intent. Ordinary links, keyboard activation, script-handled links to their original exact destination, native GET/POST forms, same-host navigation, history routing, reload and browser Back/Forward remain usable. Site pause, master pause and disabling the guard restore scripted navigation on newly loaded pages. A native-navigation fixture without the newer `sourceElement` property verifies the compatibility fallback; no old browser binary was run. The 350px popup and desktop/narrow site lists were inspected.

**Known gaps were reproduced locally:** a cross-origin frame can navigate the top page without a cancellable event, and a same-host request followed by an HTTP redirect can leave the site. These are recorded as uncovered routes, not passing protection assertions. Visible links to unwanted destinations, restricted injection and page-world tampering are also outside the guarantee. Legitimate script-only buttons that leave the host scope may require disabling this per-site guard and reloading. Firefox was not tested in this pass.

All browser runs used disposable profiles, owned loopback pages, locally generated canvas video and external deny proxies; Chrome was visible and Edge was headless. No suspicious site was contacted and no tool, package or media was downloaded. The tested blocker source hashes match the workspace, and the existing full blocker harness retains its documented local Reddit hostname alias. New independent edits to `manager.html`, `manager.css`, `manager.js` and their `pages-browser.cjs` assertions arrived after the test packages were copied: they were preserved, but that newer manager UI and those updated assertions are not covered by these browser runs. Manifest permissions, version, list inputs and packaged rules are unchanged. The rule builders were not rerun. Earlier fixture failures and the initial frame-bypass failure remain in the [verification report and attempts](../verification/2026-11-12/same-tab-redirects/summary.json). Reload the extension and affected page to activate the change on an already selected site.

## Userscript installation and updates — 11 November 2026

Direct URL installation and manual update review passed **328 Node tests** and the following offline browser suites. [Reports, source hashes, screenshots and earlier attempts](../verification/2026-11-11/userscript-install-updates/summary.json) are retained locally.

| Browser | Installation/update checks | Full blocker checks | Blocked-tab cleanup checks |
| --- | ---: | ---: | ---: |
| Chrome 157 | 41 | 571 | 25 |
| Edge 157 | 41 | 571 | 25 |
| Firefox 160.0 | 36 | 565 | 28 |

Native checks cover fetch-before-approval, literal read-only review, Enter/Escape input and focus restoration, cookie/referrer omission, installed URL persistence, paused installation, changed scope/grants/dependencies, cancelled and identical updates, exact reviewed bytes after a confirmed Chromium worker stop, GM value preservation, dependency preparation, stale reviews across two manager windows, downgrade/identity/HTML rejection and cancellation of a slow fetch. An actual loopback ad canary stays blocked while scripts run. Unit tests additionally cover numeric version precision, unknown versions, URL validation, declared/streamed size limits, invalid UTF-8, redirects, HTTP failures, queue admission, cancellation/edit/disable races, transactional rollback and the real 30-second source timeout.

The initial Firefox attempt passed its feature assertions but failed the extension-console check when the fixture destroyed manager contexts with pending messages. Its narrow layout fixture now loads only inert CSS and the review markup, and the second manager finishes loading before closure. The console assertion was retained and final Firefox runs contain no uncaught extension errors. Desktop and narrow layouts were visually reviewed; Firefox's 390px layout uses a same-origin frame because this harness cannot resize its extension viewport.

All nine final native reports match the current runtime source hashes. The existing Reddit hostname alias and synthetic blocked-tab rules remain limited to the copied blocker fixtures. Source installation tests run the unmodified runtime, using locally authored scripts and disposable profiles behind deny proxies. No third-party scripts, public source hosts or live-site blocking were tested. This pass ran the focused installation suite rather than repeating the complete desktop-helper native suite below; all unit tests were rerun. Packaged rule inputs/outputs and manifest permissions are unchanged, so rule builders were not rerun. No packages were installed, and nothing was committed or pushed. Updates remain manual and require approval; metadata cannot silently change the installed URL.

## Clipboard, notifications and downloads — 11 November 2026

Both legacy and modern spellings passed **320 Node tests** and the following offline native suites. [Reports, source hashes and earlier attempts](../verification/2026-11-11/userscript-desktop-helpers/summary.json) are retained locally.

| Browser | Userscript checks | Full blocker checks | Blocked-tab cleanup checks |
| --- | ---: | ---: | ---: |
| Chrome 157 | 271 | 571 | 25 |
| Edge 157 | 271 | 571 | 25 |
| Firefox 160.0 | 197 | 565 | 28 |

Native coverage includes optional permission requests and revocation, clipboard transport and copy-command readiness, literal text/HTML/empty writes to an isolated test sink, notification creation/removal, both download API forms, byte-exact local files, unique names, aborts, denied destinations, invalid filenames, HTTP errors, redirect rejection and size limits. Existing compatibility, manager, blocking, Reddit repair and blank-tab cleanup checks also pass. Unit fixtures add exact-grant/document/connection isolation, delayed native creation, revocation, permission failures, admission/rate limits, notification callbacks and tags, startup cleanup, download failure/early completion and Firefox Blob URL disposal.

Testing found and fixed two Firefox API differences: notification options cannot include `silent`, and downloads require a Blob URL instead of a data URL. A native clipboard-readiness check also reproduced the missing-selection case; a temporary field now supplies a selectable value and is removed in `finally`, including when copying empty text or encountering failure. Chrome/Edge headless runs could not accept the native helper-permission prompt, so the completed suites use disposable visible browsers and actual permission acceptance. No permission store or browser security control was bypassed. The download fixtures use ordinary profile download settings to preserve native filenames; the older editor-export checks retain their original CDP routing after the helper checks finish. Earlier attempts and test-input corrections are retained in the report.

**The Windows clipboard was never read or changed.** Native permission, DOM readiness and the extension bridge were checked, but `execCommand` writes were intercepted at the final boundary. Actual OS clipboard output remains unverified. Notifications were created and removed through native APIs; OS toast appearance/clicks and the `saveAs` chooser were not exercised. All downloaded bytes were locally authored, saved only under the owned temporary test directories and never opened or executed. Desktop and narrow permission panels were visually inspected.

Required blocker permissions, host access, content-script declarations and bundled rules remain unchanged. Four optional helper permissions were added. Final native source hashes match the workspace, with clipboard sink, Reddit hostname alias and loopback-rule overrides recorded separately. Existing builds were not rerun because rule inputs and outputs did not change. No tool, package or third-party engine was installed, no live site was visited, and nothing was committed or pushed. The guide documents the 2 MiB download cap, Firefox's ignored `silent` option and the possibility that an already accepted native save finishes after abrupt worker termination.

## Userscript DOM and tab helpers — 11 November 2026

`GM_addElement` / `GM.addElement` and `GM_openInTab` / `GM.openInTab` passed **300 Node tests** and the following native browser suites. [Evidence, source hashes and attempts](../verification/2026-11-11/userscript-helpers/summary.json) are retained locally.

| Browser | Userscript checks | Full blocker checks | Blocked-tab cleanup checks |
| --- | ---: | ---: | ---: |
| Chrome 157.0.8103.51 | 241 | 571 | 25 |
| Edge 157.0.4341.46 | 241 | 571 | 25 |
| Firefox 160.0 | 169 | 565 | 28 |

Native checks cover synchronous element returns, literal attributes/text, explicit and shadow-root parents, style compatibility, both tab API spellings, source-window placement, background/pinned tabs, close-before-open, native removal callbacks, revocation, absent grants and a blocked loopback destination. The existing storage, menu, matching, timing, dependency/resource, HTTP, manager and blocker fixtures also pass, including the Reddit repair. Unit cases verify forged/native-ID handles, document and connection binding, creation/close failures, uncertain lookup after a tab moves windows, revocation during pending creation, limits across disconnect and opening-rate limits.

Two initial Chrome attempts failed because the new test assumed every API-created tab qualified for automatic popup cleanup. The retained native trace shows the destination was blocked, but Chrome's initial tab event had no opener. The fixture now verifies the block, the existing conservative cleanup boundary and explicit script-owned closure; the product's popup-cleanup policy was not relaxed. Three intermediate successful runs are also retained separately from the final matching source snapshots.

All execution used installed browsers, disposable profiles and locally authored loopback fixtures behind deny proxies. Native runtime hashes match the workspace; the blocker suites retain the documented Reddit hostname alias and blocked-tab suites add only synthetic loopback rules to their disposable packages. Manifest permissions are unchanged. No packages or third-party scripts were installed, and no live site was tested. Element insertion respects browser security policies; Firefox container options, CSP bypass and handles surviving native connection loss remain unsupported. The rule builders were not rerun for this helper-only pass; their earlier same-day results are below. Nothing was committed or pushed.

## Reddit app-popup repair — 11 November 2026

The change passed **290 Node tests**, **21 cosmetic compilation assertions**, **237 offline rule/import assertions** and **338 threat-evidence/build assertions**. The full native blocker suites passed **571 checks in Chrome 157.0.8103.51**, **571 in Edge 157.0.4341.46** and **565 in Firefox 160.0**. [Evidence and source hashes](../verification/2026-11-11/reddit-popup/summary.json) include the earlier failed attempts and the [before](../verification/2026-11-11/reddit-popup/reddit-before.png) / [after](../verification/2026-11-11/reddit-popup/reddit-after.png) fixture captures, which were visually inspected.

The fixture first reproduces a fullscreen app promotion blocking native clicks and root scrolling. The real extension then restores a native pointer click and PageDown scrolling while keeping the ordinary ad canary hidden. Checks cover delayed prompts, native modal closure/reopening, separate login dialogs, adjacent decorative backdrops, open shadow-root mutations, fixed-body offsets, root and main-content inertness, class locks surviving prompt removal, preserved page edits, pauses and resumes, non-Reddit lookalikes, and bounded scan shutdown/recovery. Existing network, cosmetic, picker, popup and settings checks remain in the full suites.

All testing used locally authored loopback pages, disposable profiles and deny proxies. The copied `reddit.js` factory aliases only the loopback `/reddit-fixture` hostname to `www.reddit.com`; the report records original and fixture hashes separately. All other packaged runtime bytes match the current workspace, and independent unit tests check the real hostname boundary. No live Reddit page or suspicious destination was contacted. Recognition of the screenshot's live DOM remains unverified; other wording, closed shadow roots and event-listener-only locks are outside the tested coverage. Manifest permissions and bundled network rules did not change; version remains 1.9.0. This pass did not rerun the separate userscript or blocked-tab cleanup suites.

The first full Edge attempt timed out at the existing cosmetic fixture before the Reddit checks; later full runs passed, and no cause is asserted for that timeout. Firefox's first launch timed out before assertions and left processes using that exact disposable profile; those process trees were closed before a fresh run passed. Raw attempt reports are retained. No personal browser profile was changed, and nothing was committed or pushed.

## Userscript dependencies and HTTP — 9 November 2026

The next compatibility pass passed **287 Node tests**, **21 cosmetic assertions**, **237 rule/import assertions** and **338 threat-evidence/build assertions**. Browser results:

| Browser | Userscript checks | Existing blocker checks | Blocked-tab cleanup checks |
| --- | ---: | ---: | ---: |
| Chrome 157.0.8103.39 | 215 | 541 | 25 |
| Edge 157.0.4341.42 | 215 | 541 | 25 |
| Firefox 159.0.1 | 144 | 535 | 28 |

All checks passed. The [retained report](../verification/2026-11-09/userscript-dependencies/summary.json) records native evidence, file hashes, screenshots and earlier attempts. All three complete userscript suites exercised the final manager files. Blocker suites preceded a UI-only preview size/focus adjustment; their blocker, transport, compiler, host, manifest and rule hashes still match. Cleanup suites and final userscript suites match all their recorded files. No blocker rules or manifest permissions changed; the manifest adds the bundled HTTP transport to Firefox's background script list.

The native fixtures use locally authored libraries, CSS, binary bytes and HTTP responses from two owned loopback origins. They verify explicit preparation without save/startup downloads, SHA-256 pins, ordered dependencies, isolated globals, legacy/modern resources, Blob URL bytes, default document-end, case-insensitive include/exclude rules and GM_info grants. HTTP checks cover callbacks, promises, progress, JSON/binary/Blob/document responses, 404 behavior, invalid JSON, forbidden headers, @connect rejection before external contact, redirects, oversized responses, cookies, anonymous requests, timeout, abort and disable cancellation. Existing value, menu, matching, timing, world-limit and editor tests remain in the suites. The local ad canary stays blocked during dependency and GM HTTP execution.

Unit coverage also checks corrupt caches at startup, stale preparation after edit/delete/disable, preserved data on download failures, source edits invalidating changed declarations, grant isolation, forged connection IDs, bounds, port loss and no request retries. Chrome initially exposed a pending-promise bug: initiating a port disconnect does not fire that side's own disconnect listener. Explicit revocation now settles requests directly, and the unit harness models native disconnect behavior. The two earlier failing Chrome attempts are retained. Obsolete tests that rejected every @require now reject insecure HTTP dependency URLs or unsupported directives.

Desktop and narrow dependency panels and the read-only preview were visually inspected. Firefox's preview now opens at its heading with keyboard focus; all three browser suites verified that final adjustment. Tests used deny proxies, disposable profiles and no personal browser data. No external script, tool or package was installed or executed, and no suspicious destination was visited. The user guide documents remaining compatibility limits, including native world limits, strict library execution, bounded HTTP and no automatic updates. Version stays 1.9.0. This work remains local and uncommitted.

## Userscript compatibility — 8 November 2026

The expanded userscript subset passed **278 Node unit tests**, **21 cosmetic-compiler assertions**, **237 offline rule/import assertions** and **338 threat-evidence/build assertions**. Native results for the final runtime bytes:

| Browser | Userscript checks | Existing blocker checks | Blocked-tab cleanup checks |
| --- | ---: | ---: | ---: |
| Chrome 157.0.8103.39 | 165 | 541 | 25 |
| Edge 157.0.4341.42 | 165 | 541 | 25 |
| Firefox 159.0.1 | 97 | 535 | 28 |

All checks passed. The [retained report](../verification/2026-11-08/userscript-compatibility/summary.json) links the native evidence, source hashes, screenshots and earlier failed attempts. Each run's recorded runtime hashes matched the workspace; the manifest, permissions, blocker engine and bundled rules were unchanged. The background router only adds trusted extension-page menu commands. Cleanup tests add harmless loopback-only rules to their disposable copies.

The shared native fixtures exercise synchronous legacy reads, immediate legacy writes, modern bulk storage/defaults/deletion, cross-tab value listeners, menu registration/removal, pointer and Tab/Enter input, disable revocation, document-start/body/end/idle, include/match union, include-only query/fragment rules and top-frame scope. Ten simultaneous legacy scripts hydrate in native worlds. Chrome and Edge additionally exercise worker-stop reconnection and their existing manager import/export, stale-draft and shutdown-pressure checks. Firefox's actual optional-permission checkbox and Allow button were exercised without editing its permission store. Its focused suite does not duplicate all Chrome/Edge editor and worker-restart checks.

Fault-injection unit coverage includes failed writes and rollback, delayed acknowledgements, reentrant value listeners, grant/capability isolation, forged menu requests, quota failures and control priority. Before-fix tests reproduced simultaneous cache and menu startup being rejected by the ordinary per-tab request budget. Both now have separate bounded admission; menu changes coalesce while an update is in flight, and manager controls retain priority. Native tests verify all ten simultaneous scripts hydrate and publish menus. They also exposed Chromium's 10-world limit and incorrect include-only registration assumptions. The final compiler preserves native URL prefilters and stops privileged source execution when messaging is unavailable. The [compatibility guide](USER_GUIDE.md#modules-and-userscripts) explains these limits and the initial cache hydration delay.

Firefox keyboard activation first failed on both a script command and a plain button because native focus remained outside the page after its permission prompt. Focusing the owned selected browser corrected the harness; the final checks use real pointer and keyboard input. Startup, prompt-handling, diagnostic and native-registration failures are retained in `attempts.json` beside the report. Final popup command layouts and narrow manager screenshots were inspected. No external script package was installed or executed, no listed destination was visited, and no personal browser profile was used. These offline results do not establish compatibility with every existing userscript or live-site ad coverage. Version remains 1.9.0; this work was not committed or pushed.

## Repository cleanup — 8 November 2026

The documentation and ignore-file cleanup passed **258 Node unit tests**, **21 cosmetic-compiler assertions**, **237 offline rule/import assertions** and **338 threat-evidence/build assertions**. All **83 local documentation links** resolved, and the five relocated historical reports retained their text apart from rebased links. Hash comparisons confirmed that **469 runtime, data and retained evidence files** were unchanged. Ignore checks covered 25 representative paths, including packaged rules, local environment files, signing keys and generated build output.

These checks used local files and isolated test fixtures. No browser suite or live-site test was rerun for this documentation-only change; the native browser results below retain their original dates. The transient `rules/.build.lock` was removed from Git tracking, while rule data and evidence required by the builder remain versioned.

## Verification

Firefox cleanup was added on 5 November 2026 and verified in **Firefox 159.0.1** with `extensions.dnr.feedback` disabled. All **258 unit tests** passed. Firefox passed **28 native cleanup checks** and **533 existing blocker checks**; Chrome and Edge each passed **25 cleanup checks** and **539 blocker checks**. Coverage includes domain/static blocks, redirects, initially blank tabs, preserved loaded/pinned/manual tabs, cancellations, site exceptions, global pause, earlier redirect exceptions, disabled rules, rule-read failures and navigation/settings races. Uncertain Firefox conditions and redirect chains longer than eight hops preserve the tab. Tests used disposable profiles, owned loopback pages and deny proxies; suspicious domains were never visited. The cleanup harness adds two harmless loopback rules only to its test copy. Windows test-launch/cleanup failures and their resolved retries are retained in [the Firefox cleanup report](../verification/2026-11-05/firefox-blocked-tabs/summary.json). Reload Module Engine in Firefox under `about:debugging#/runtime/this-firefox` to activate the change; no preference or permission change is needed.

On 5 November 2026, a local Chrome fixture reproduced the blocked-destination tab remaining open while no request reached the destination. Automatic cleanup now correlates native tab creation, the first navigation, a failed request and the matching rule's block action. **192 unit tests** passed, including 25 new cleanup checks for event ordering, action validation, navigation races, rule changes, capacity, expiry, unsupported feedback and error recovery. Chrome and Edge each passed **17 native cleanup checks** and **539 existing blocker checks**. The cleanup harness adds one loopback-only static canary to its disposable package; the general blocker suite uses the unmodified package. No suspicious site was opened or contacted. See [the cleanup verification report](../verification/2026-11-05/blocked-tabs/summary.json). Reload the unpacked extension to activate this behavior; no new permission or per-site switch is needed for cleanup.

On 4 November 2026, the userscript queue-exhaustion finding was reproduced: 100 GM requests made module-off, script-disable and delete fail with a busy error. After reserving manager capacity, prioritizing controls and bounding GM traffic, all **167 unit tests**, **64 userscript-manager checks per browser**, and **539 blocker checks per browser** passed in Chrome and Edge. Native manager controls completed while a bounded local script kept sending requests; old capabilities were rejected and local ad blocking remained active. Fault-injection tests cover in-flight writes, failed shutdown rollback, rapid disable/re-enable, and capacity recovery after errors. Tests used disposable profiles and owned loopback fixtures behind a deny proxy. Firefox userscript execution was not tested in this change. See the [security-fix evidence](../verification/2026-11-04/userscript-control/summary.json), including the before-fix failures and the initial sandbox browser-startup/cleanup failure. Reload the unpacked extension and affected pages to apply the fix.

On 30 October 2026, version **1.9.0** passed **157 unit tests**, **237 rule/import assertions**, **338 threat-policy assertions**, **21 cosmetic-compiler assertions**, and **465 blocker plus 46 userscript-manager checks in each of Chrome and Edge**. Tests use fresh profiles, owned loopback fixtures and a deny proxy. They exercise actual ad blocking while scripts run, independent switches, isolated GM storage, rejected administrative messages, scope/timing/frame rules, browser permission revocation, worker restart, import/export, stale drafts, deletion and keyboard cancellation. Desktop and narrow manager layouts and the existing popup were inspected. A wildcard-heavy scope stall and an Edge permission-error handling failure were reproduced before their fixes. The existing bundled blocker assets were hash-compared with the early task package; source changes are isolated in a patch against the pre-task snapshot. See the [1.9 verification report](../verification/2026-10-30/modular-extension/summary.json) for exact versions, hashes, earlier failures and cleanup.

**Historical Firefox 159 results on 1 November 2026:** 533 checks for 1.9.0, alongside 539 each in Chrome and Edge. Firefox 159 dropped `--remote-allow-system-access`, so the test harness sets `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS` for its own test browser. Saved userscripts and the Allow userscript access button were not exercised in that run; both now have the 8 November coverage above. Extension-update restoration is covered by unit tests, and actual worker stop/restart by Chrome and Edge tests. A full reload of the temporary CDP-loaded extension encountered Chrome's OFFSTORE protection; that protection was not bypassed. These offline checks do not establish blocking coverage for every live site. No new dependencies were installed. Reload the unpacked extension to use this version.

On 29 October 2026, version **1.8.0** passed **112 unit tests**, **237 rule-builder assertions**, **338 threat-evidence assertions**, **21 cosmetic-compiler assertions**, and **462 checks each in Chrome and Edge**. The browser runs used fresh profiles, native editor input and loopback fixtures behind a deny-all proxy; Chrome was visible. New checks cover native request matching, precedence, actual blocking and restoration of a harmless local script, stale additions and deletions, invalid drafts, popup synchronization, evidence display, messaging failure/recovery, and keyboard scrolling at narrow widths. The popup regression was reproduced before its fix. Desktop and narrow layouts were inspected. Runtime copies were hash-compared with the workspace, and an independent build reproduced all rule outputs, including the new evidence bundle. Existing catalogs, list snapshots, rule bytes and permission declarations remain unchanged. See the [1.8 verification summary](../verification/2026-10-29/network-filters/summary.json) for retained successes, failures, hashes and cleanup evidence. No malware site was visited and nothing was downloaded or installed.

**Firefox is unverified for 1.8.0.** One attempt timed out during automation startup; a retry reached the automation service, which rejected navigation to the extension page before any assertions could run. Its security settings were not weakened. The temporary profiles were closed. Historical Firefox passes below belong to earlier versions, not this build. After rebuilding, reload the unpacked extension: file hashes describe the packaged files, not an older ruleset already compiled in a running browser.

On 29 October 2026, version 1.7.0 passed **85 unit tests**, **237 rule-builder assertions**, **334 threat-policy assertions**, **21 focused cosmetic-compiler assertions**, and **398 Chrome / 398 Edge / 392 Firefox browser checks**. Browser tests used fresh profiles and loopback fixtures behind a deny-all external proxy; Chrome was visible. Alongside the existing network and cosmetic regressions, browser checks cover native picker input, reversible previews, DOM mutations, keyboard-only selection, page navigation, simultaneous openings, failed saves, concurrent editor changes and a local page requiring Trusted Types. Unit tests also cover worker restarts, session expiry, stale-page rejection and storage failures. Desktop and narrow picker layouts were inspected. The separate rebuild reproduces the packaged rules; catalog/list inputs and permission declarations remain unchanged. See [the verification summary](../verification/2026-10-29/picker/summary.json), including source hashes and retained test-harness failures with their corrections. No sites listed as malware were visited and nothing was downloaded or installed for this upgrade. These results do not establish live-site ad-blocking coverage. The [1.6](../verification/2026-10-29/procedural/summary.json) and [1.5](../verification/2026-10-29/upgrade/summary.json) records remain available separately.

Node 22+ and PowerShell 7+ are sufficient; no third-party test packages are used.

```powershell
node --test tests/*.test.cjs
pwsh -NoProfile -File tests/cosmetic-rules.test.ps1
pwsh -NoProfile -File tests/rules.test.ps1
pwsh -NoProfile -File tests/threat-rules.test.ps1
node tests/browser-smoke.cjs chrome --headed
node tests/browser-smoke.cjs firefox
node tests/browser-smoke.cjs edge
node tests/same-tab-redirects-browser.cjs chrome
node tests/same-tab-redirects-browser.cjs edge
node tests/frame-redirects-browser.cjs chrome
node tests/frame-redirects-browser.cjs edge
node tests/popup-guard-browser.cjs chrome
node tests/popup-guard-browser.cjs edge
# Focused Reddit fixtures only; still loopback-only with a disposable profile.
node tests/browser-smoke.cjs edge --reddit-only
# Focused notification/install prompt fixtures, also available for edge and firefox.
node tests/browser-smoke.cjs chrome --prompts-only
node tests/live-network-browser.cjs chrome
node tests/live-network-browser.cjs edge
node tests/userscripts-browser.cjs chrome --native-helper-prompt
node tests/userscripts-browser.cjs edge --native-helper-prompt
node tests/userscripts-firefox.cjs firefox
# Headless core/editor suites; run desktop helpers separately with native permission acceptance.
node tests/userscripts-browser.cjs chrome --skip-desktop
node tests/userscripts-browser.cjs edge --skip-desktop
node tests/userscripts-browser.cjs chrome --desktop-only --native-helper-prompt
node tests/userscripts-browser.cjs edge --desktop-only --native-helper-prompt
# Focused URL installation and manual updates; no desktop-helper permission prompt.
node tests/userscripts-browser.cjs chrome --install-only
node tests/userscripts-browser.cjs edge --install-only
node tests/userscripts-firefox.cjs firefox --install-only
node tests/blocked-tabs-browser.cjs chrome
node tests/blocked-tabs-browser.cjs edge
node tests/blocked-tabs-browser.cjs firefox
```

The browser script defaults to the standard Windows installation paths; `BLOCKADS_TEST_BROWSER` can select another executable. It copies the extension into a temporary directory and uses a fresh browser profile. The smoke suite records original runtime hashes and the documented Reddit fixture hostname alias separately; other packaged files are unchanged. A local deny proxy rejects every non-loopback request without resolving or forwarding it, with speculative DNS disabled. A reserved-name canary verifies that the proxy is enforcing this policy. DNR matching uses synthetic URLs; actual extension blocking is exercised only against loopback HTTP and WebSocket fixtures. Firefox's simulator uses the HTTP(S) handshake representation for WebSocket checks; real local handshake tests separately verify enforcement. The script checks popup errors, site exceptions, an already-open page's flagging toggle, cosmetic filtering in cross-origin frames, and a synthetic pop-up attempt from a cross-origin frame. It does not visit listed sites or alter a personal browser profile. The current dated-threat assertion intentionally fails after expiry until evidence is reviewed again.

The separate `live-network-browser.cjs` regression is also offline: it tests live-mode proxy routing using owned IPv4/IPv6 loopback canaries and synthetic DNS, with every upstream connection forbidden. Unit tests cover private/reserved addresses, numeric aliases, mixed DNS answers, address pinning, timeouts, disconnects and shutdown. The picker regression reproduces page selector substitution and checks that native edits, previews and saves still work with closed controls. See the [29 October security-fix evidence](../verification/2026-10-29/security-fixes/summary.json). **Historical limitation from 29 October 2026:** Firefox automation rejected extension-popup navigation before checks began; this also reproduces with the saved pre-fix launcher and picker, so these fixes have runtime evidence in Chrome and Edge only.

Evidence and popup screenshots are saved in the printed temporary directory. Firefox extension pages cannot set a viewport, so their narrow layouts are measured inside frames; the picker on an ordinary fixture page uses native input in all three browsers. Browser processes started by the test are closed afterward. Unit tests inject failures to cover rollback and quota paths; catalog/build tests use local malformed-data fixtures, rejected legacy imports and a forced publication failure.

On Windows, Edge may relaunch itself during compatibility initialization. The harness follows the endpoint written into its fresh profile using loopback WebSocket debugging, keeps the deny proxy alive through shutdown, and verifies cleanup against that exact test profile. Chrome continues to use a debugging pipe. Expected proxy peer resets are recorded; other proxy errors fail the run. No personal profiles, browser policies or security settings are changed.

Live testing is a separate, explicit opt-in command. It opens a **visible**, signed-out test browser, denies browser file downloads, retains reported-threat filtering during the ad/tracker/cosmetic-off comparison, and permits only named service domains through its proxy. Other providers remain denied in both phases, so absence of ads alone cannot be counted as a pass. Ordinary page resources and video streaming still use the network. It does not open ad destinations, submit forms or solve verification challenges. Pages change over time; a completed observation run does not mean every site's ads were blocked.

Both live harnesses disable Chromium's implicit loopback/link-local proxy bypass and permit CONNECT only on port 443 after every returned DNS address passes a conservative public-unicast policy. The connection uses a validated literal IP, with no second hostname lookup; mixed public/private answers, reserved and transition addresses, plain HTTP (including certificate-looking paths), and HTTP upgrades are refused. `live-site-check.cjs` additionally enforces its named service-domain allowlist. This guard is not an operating-system sandbox. Sites with incomplete certificate chains or special network requirements may fail closed. The single-page evidence records the actual visibility and click options, including the click implied by `--popups-only`, and retains per-phase interaction results.

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

# Only the per-site pop-up blocker on (all filter lists off), compared with it off.
node tests/site-ad-check.cjs chrome https://example.com/page --allow-live-sites --visible --popups-only
node tests/live-site-check.cjs chrome --allow-live-sites fandom
```

See [the dated-threat verification report](history/THREAT-ADDITIONS-2026-10-18.md) for version 1.0.3 checks and limits, and [the earlier fixes](history/CHANGES-2026-10-18.md) for the 1.0.2 baseline.

## Streaming sites, search ads and blocker detection

Visible Chrome checks on 18 October 2026 (version 1.0.4) confirmed that request blocking is active and YouTube/Twitch playback can work, but captured a YouTube video ad with Module Engine enabled. Domain rules cannot block those ads because YouTube serves them from the same hosts as the video.

Version 1.1.0 adds the YouTube filter described above. On 19 October 2026, two signed-out visible Chrome samples of a widely viewed music video showed with Module Engine enabled: no ad-schedule fields in the player data, no ad playing, and the 3:33 music video itself playing at about 10 seconds. With the ad, tracker and cosmetic layers off, the same page received `adPlacements`, `adSlots` and `playerAds` and played a "Sponsored" video ad (84 s and 35 s) with a sponsored sidebar card ([screenshots and evidence](../verification/2026-10-19/youtube)). Big Buck Bunny played normally in both phases and received no ads in either. These are short signed-out samples, not proof against every ad format: YouTube changes its player regularly, may insert ads into the video stream itself, and may show a blocker warning. If ads return, the skip fallback still mutes and jumps over an ad the player labels as one. A short Twitch sample showed no blocker warning, but did not establish suppression of stream ads. Google Search presented an unusual-traffic check with filtering enabled and disabled, so live Search ad coverage remains unverified. Blocking ad hosts does not necessarily remove sponsored results served inside a search page, and the threat list cannot identify every fake organic search result.

There is no general anti-detection layer in this extension. Some sites measure whether ad-like page elements were hidden or ad requests failed; playback can also depend on the site's server responses. A site-specific compatibility change needs a reproducible case and a playback/content regression check. Hiding an entire warning overlay does not establish that playback works. No detection bypass or copied uBOL script/filter list was added during this verification.

On 19 October 2026 (UTC), `tests/site-ad-check.cjs` compared a book page and a chapter page on the Chinese novel site m.xsw.tw. Its ads came from Google AdSense: with ads off each page made about 34–39 ad requests and showed search-ad boxes, an in-page ad badge, a large ad slot and a sticky bottom banner; with Module Engine on, the single ad-loader request was blocked and no ad element appeared ([evidence](../verification/2026-10-19/xsw-tw)). The check did not click or tap. At that time the harness forwarded plain-HTTP requests with certificate file suffixes to accommodate an incomplete certificate chain. That exception was removed on 29 October: a file suffix does not validate a destination or its contents. Sites that require this HTTP fetch may now fail certificate validation in the live harness.

The same day, the novel site uukanshu.cc was checked in a visible window with one click on an empty page area (its Cloudflare protection refuses headless browsers; no challenge was shown or solved). Version 1.1.0 left a 300×250 ad, a 210×150 ad and a click pop-up to `political-effort.com` in place: those networks were not in any list. The 7 hosts involved are now in `lists/site-ad-hosts.json`. Afterwards, with Module Engine on, the page's three ad-loader requests were blocked, no ad server was contacted, no ad frame appeared and the click opened nothing; with filtering off, the page showed a fake "READ FULL — DOWNLOAD" button, a crypto-casino ad and the click pop-up ([evidence](../verification/2026-10-19/uukanshu)). Domains such as `political-effort.com` look generated and may be replaced by the ad network, so this site needs rechecking over time.

Version 1.3.0 was rechecked on both sites with every layer on, including the community lists: no ad frame, no click pop-up, and the chapter text intact (filters off: ad frames on both, and the uukanshu click pop-up). A separate uukanshu run with **all filter lists off** and only *Block pop-ups on this site* on blocked the click pop-up to `political-effort.com` by itself; with that switch also off, the page attempted the same pop-up ([evidence](../verification/2026-10-19/community-and-popups)). The pop-up blocker therefore still applies if that network changes domains.

On 21 October 2026 (UTC), version 1.4.0 flagging was checked on the same uukanshu.cc chapter. With every layer on, nothing was flagged (no ad server loaded). With the ad, tracker, community and cosmetic layers off, it flagged 3 of the 7 ad servers found by hand: `political-effort.com` (random-looking script address, throwaway-looking domain, 300×250 frame), `pubadx.one` (ad address and placement settings) and `insecure-brief.com` (throwaway-looking domain). It missed `a-ads.com` (a 210×150 frame, not a standard ad size), the aotter servers and `zealous-deposit.pro`, whose addresses look ordinary ([evidence](../verification/2026-10-21/flagging)).

The [live-site record](history/LIVE-SITE-VERIFICATION-2026-10-18.md) separates observed extension blocks from restrictions imposed by the test proxy, and includes the Fandom before/after check.
