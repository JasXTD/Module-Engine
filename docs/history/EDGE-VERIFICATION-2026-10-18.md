# Edge verification — BlockAds 1.0.3

**Passed 266 checks on Microsoft Edge 155.0.4283.62.** The extension runtime, UI, catalogs and generated rules are unchanged from the previously verified version 1.0.3. Only the browser test harness and verification documentation needed changes.

## What was verified

- All 24 reported-threat hostnames match using synthetic DNR requests. Checks cover HTTP(S), WebSocket handshakes, main-frame navigation, ports, case, credentials and a DNS root dot.
- Unlisted children, prefix/suffix lookalikes, shared-hosting neighbors and suspected-only indicators remain outside the threat rules.
- Reported-threat and master switches, site exceptions, concurrent settings changes, custom domains, IDN input and rejected-input recovery work.
- Actual HTTP and WebSocket blocking works against local fixtures, including an allowed/blocked/allowed WebSocket sequence.
- Cosmetic filtering changes live, respects top-page exceptions in cross-origin frames, and preserves ordinary content.
- Reopening the popup reconciles saved state. Active, error and long-domain Edge screenshots were visually inspected; automated pause, inherited-exception and overflow checks passed.
- No uncaught extension runtime errors or unexpected deny-proxy errors occurred. The final Edge process closed gracefully, with no leftover processes for its isolated profile.

The shared harness was also rerun successfully on Chrome 155.0.8059.85 (266 checks) and Firefox 158.0 (265 checks). All three records match the workspace runtime/ruleset SHA-256 values. The prior 25 background tests and 507 offline assertions remain applicable because their production inputs are unchanged; they were not rerun for this harness-only change.

## Startup issue and harness fix

The original launcher exited cleanly with code 0 before a debugging-pipe connection opened. Later inspection found that Edge had created a replacement process for compatibility handling, with `--edge-skip-compat-layer-relaunch` in its command line. A successful launcher exit therefore did not mean the browser was finished. This was a test-launch problem, not evidence that BlockAds failed to load.

Edge now uses a random loopback debugging port and the endpoint file inside the newly created test profile. The harness waits through a successful launcher exit, connects to the replacement browser, records its real process ID and keeps the network guard running through cleanup. [Microsoft documents Edge's loopback debugging interface and separate user-data directories](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/).

One diagnostic run also exposed an unhandled `ECONNRESET` when a client aborted a denied proxy connection. The harness now records expected peer resets and fails on other proxy errors. Shutdown checks both the connected browser and processes whose command lines name the exact private profile. Cleanup never targets Edge by executable name or touches another profile. Diagnostic browser processes were closed and a final inventory found no remaining BlockAds Edge test processes.

## Safety boundary

No malware hostname was visited, resolved, downloaded from or submitted to a scanner. Candidate addresses were only inert inputs to the browser's DNR testing API. No files, packages, feeds, browser binaries or malware samples were downloaded.

The tests used fresh profiles. All non-loopback HTTP(S) traffic went to a local proxy that rejects it without forwarding or resolving destinations; speculative networking and QUIC were disabled, and Chromium's resolver guard rejected non-loopback names. A reserved-name canary verified the proxy. Real page loads, HTTP requests and WebSocket handshakes used only loopback fixtures. Background Edge requests were denied; no candidate-host requests reached the proxy.

Personal Edge sessions, installed extensions, browser policies, sandbox configuration and system network settings were unchanged. The pre-existing normal Edge process remained running. No registry writes, installation repairs or browser downloads were needed.

## Evidence and limits

- [Edge results](../../verification/2026-10-18/dated-threats/edge.json), [Chrome regression results](../../verification/2026-10-18/dated-threats/chrome.json), [Firefox regression results](../../verification/2026-10-18/dated-threats/firefox.json).
- [Edge validation summary](../../verification/2026-10-18/dated-threats/edge-validation.json) includes protected-file hashes, source identity and cleanup checks.
- [Edge active popup](../../verification/2026-10-18/dated-threats/edge-popup-final.png), [error state](../../verification/2026-10-18/dated-threats/edge-popup-error.png), [long-domain state](../../verification/2026-10-18/dated-threats/edge-popup-long-domain.png).
- The original launcher failure is preserved as `verification/2026-10-18/dated-threats/edge-launcher-before-fix.json`.
- Pre-change harness, documentation and evidence copies are under `.artifacts/edge-verification-20261018-123016/`.

This verifies the installed Edge version with the unpacked extension in an isolated headless browser. It does not claim permanent store installation, full browser restart persistence, all website compatibility, or complete malware protection. Expiry and injected failure timing are covered by the existing unit harness; no system clock was changed. No personal-profile extension was installed or reloaded.

Reproduce without downloading dependencies:

```powershell
node tests/browser-smoke.cjs edge
```
