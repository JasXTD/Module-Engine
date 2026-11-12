# Module Engine verification

These are dated results, not a promise that every live site is blocked. The latest records are from 13 November 2026, covering the userscript editor, tags/order, HTTP/download compatibility and blocker regressions. Older records describe their own source snapshots and limitations.

[Installation](../README.md#getting-started) · [User guide](USER_GUIDE.md) · [Development](DEVELOPMENT.md)

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
