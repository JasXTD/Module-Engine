# Module Engine

A modular browser extension for **Chrome, Edge and Firefox**, combining local ad blocking with an optional userscript manager.

Module Engine uses the browser's Manifest V3 APIs and bundled filter data. It runs as an extension, without a localhost service or a package-install step. Formerly **BlockAds Shield**.

## Features

- **Independent modules:** pause ad blocking without disabling userscripts, or keep the userscript module off entirely.
- **Ad and tracker filtering:** bundled network rules, EasyList snapshots, cosmetic hiding, advanced page hiding and a visual element picker.
- **Custom controls:** blocked domains, allowed domains, per-site exceptions and scoped request filters.
- **Pop-up protection:** an optional per-site guard for pop-ups, embedded-frame takeovers and scripted page changes, including server-redirect chains stopped before their first request. Ordinary links and video controls remain usable; see the [scope and compatibility limits](docs/USER_GUIDE.md). Confirmed blocked blank pop-up tabs are also cleaned up automatically.
- **Reddit app prompts:** Page hiding removes recognized app-promotion overlays and releases their click and scroll locks. Coverage is tested with offline fixtures; live Reddit layouts can vary.
- **Userscripts:** import, edit, enable and export `.user.js` files; legacy and modern GM storage, listeners, page commands, DOM/tab helpers, clipboard writes, notifications, downloads, URL globs, cached dependencies/resources and bounded cross-origin HTTP requests.
- **Script installation and updates:** install from a direct URL and manually check for updates, with source/access review and approval before replacement. Saved values are retained.
- **Local activity and review:** inspect extension events, supported blocked-request logs and suspected-ad flags before choosing what to block.

## Getting started

The extension is currently installed from source. The blocker declares Chrome/Edge **121+** and Firefox **128+** as minimum versions; the optional userscript module also needs the browser's native `userScripts` API and permission controls.

### Chrome and Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked** and choose the repository folder containing `manifest.json`.
4. Open **Module Engine** from the extensions menu.

After pulling or editing source files, select **Reload** on the extension's browser page, then reload affected website tabs.

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose this repository's `manifest.json`.

Use **Reload** on that page after source changes. A temporary add-on must be loaded again after Firefox restarts; permanent distribution requires Mozilla signing.

## Using the modules

Ad blocking and userscripts have separate switches. Userscripts start disabled.

Open **Modules & scripts** to import or create a script. Review its source and site scope, grant userscript access if prompted, save it, then enable **Run this script** and reload a matching page. Chrome and Edge may also require **Allow User Scripts** on the browser's extension-details page.

Saving an edited script disables it until you enable it again. Disabling a script prevents future registrations, revokes live APIs and cancels its network requests; reload open pages to remove code that has already run.

The editor highlights source and reports syntax errors with **Go to error**. Add local tags or author `@tag` metadata, search/filter the library, and use **Earlier** / **Later** to set script start order within each timing phase. Saving tags alone keeps the script enabled. See [editing and organization](docs/USER_GUIDE.md#editing-and-organizing-scripts).

For a hosted script, choose **Install from URL**, paste its direct HTTPS source URL, then **Fetch for review**. Review the code and access before choosing **Install script**. Later, select the script and choose **Check for updates**. **Apply update** uses the reviewed bytes, preserves saved values and pauses the script until you enable it again. See [installation and update limits](docs/USER_GUIDE.md#installing-and-updating-scripts).

Scripts can add commands to the extension popup for their page. Legacy GM reads are synchronous once saved values load; that initial loading can delay `document-start`. Modern GM storage methods return promises, and stored values remain JSON-compatible and private to each script.

Chrome and Edge support 10 isolated userscript worlds in one document. Keep overlapping script scopes within that limit; the library can still hold 32 scripts for different sites.

For scripts with `@require` or `@resource`, save the script, choose **Prepare dependencies**, and review the cached contents before enabling it. Nothing downloads on import, save or startup. Scripts with a network grant can use `GM_xmlhttpRequest` or `GM.xmlHttpRequest`; the manager displays their destination scope.

Scripts can grant `GM_addElement` / `GM.addElement` to create DOM elements, or `GM_openInTab` / `GM.openInTab` to open HTTP(S) tabs and close their own tabs through a returned handle. Both API styles return synchronously. See the [helper options, lifecycle and compatibility limits](docs/USER_GUIDE.md#element-and-tab-helpers).

The manager supports a focused subset of userscript metadata and GM APIs, without automatic script updates or full Violentmonkey compatibility. See the [compatibility table and request limits](docs/USER_GUIDE.md#modules-and-userscripts).

Clipboard, notification and download helpers need an exact `@grant` plus optional browser access. Select the script and choose **Allow helper access**. Both legacy and modern spellings are supported; downloads use HTTP(S), `@connect` scope, a 16 MiB cap and unique filenames. HTTP requests support FormData, upload progress, 8 MiB bodies/responses and up to five checked redirects. Upload progress needs helper access; Firefox also needs it to follow redirects. See [request options and limits](docs/USER_GUIDE.md#userscript-http-requests) and [desktop helper behavior](docs/USER_GUIDE.md#clipboard-notifications-and-downloads).

## Browser support and verification

The Reddit app-popup repair and full blocker suites passed offline on **11 November 2026**: Chrome **571**, Edge **571** and Firefox **565** checks. These use synthetic page layouts; live Reddit coverage is not yet verified. See the [current verification record](docs/VERIFICATION.md#reddit-app-popup-repair--11-november-2026).

The latest editor, organization and HTTP/download pass completed on **13 November 2026**:

| Browser | Userscript checks | Ad-blocking checks | Blocked-tab cleanup checks |
| --- | ---: | ---: | ---: |
| Chrome 157 | 310 core/editor; 54 helper-stage checks | 573 passed | 25 passed |
| Edge 157 | 310 core/editor; 54 helper-stage checks | 573 passed | 25 passed |
| Firefox 160.0 | 275 combined | 567 passed | 28 passed |

There were also **345 passing unit tests**. Browser checks used disposable profiles and owned loopback fixtures behind deny proxies. They exercised the editor, tags/order, multipart uploads, native progress, guarded redirects, anonymous cookies, an exact 3 MiB native download and existing userscript behavior. Clipboard writes used a test sink, preserving the Windows clipboard; actual OS clipboard output remains unverified. Chrome's helper stage completed before a later UI automation timeout; its core checks passed separately. Firefox's final combined run passed after intermittent tab-unload console failures, which remain recorded. See the [verification records and limitations](docs/VERIFICATION.md#userscript-editor-and-transfers--13-november-2026).

Blocked-tab cleanup applies to new tabs with a browser-reported opener and a confirmed blocked initial navigation. Existing, pinned, previously loaded and uncertain tabs stay open. A blocked link intentionally opened in a new tab can also qualify. Full behavior is documented in the [user guide](docs/USER_GUIDE.md#controls-and-scope).

## Privacy and limits

Module Engine has no telemetry. Settings, script source, cached dependencies, script values and activity records stay in browser extension storage. Explicit dependency preparation downloads the listed files without cookies. Enabled scripts can read matching pages; a network grant can send data and use destination cookies unless `anonymous: true` is set. Review code, dependencies and API access before enabling a script.

The bundled lists are manually maintained and do not update automatically. Ad filtering can miss ads, affect legitimate pages or vary by site. The reported-threat layer uses dated evidence and disables itself when that evidence expires; its current policy expires on **30 November 2026 at 00:00 UTC**. It is not comprehensive malware protection.

Permission purposes and the distinction between site pauses, allowed domains and custom blocks are documented in the [user guide](docs/USER_GUIDE.md#permissions).

## Documentation

- [User guide](docs/USER_GUIDE.md): modules, controls, custom filters, permissions and the element picker.
- [Development](docs/DEVELOPMENT.md): source organization, rule builds and local working files.
- [Verification](docs/VERIFICATION.md): dated results, offline test commands and explicit live-test opt-ins.
- [List contracts and provenance](lists/README.md): reviewed inputs, bundled snapshots and generated rules.
- [Project history](docs/history/README.md): dated reviews and preserved version notes.

## Development quick start

The tests use installed **Node.js 22+** and **PowerShell 7+**, with no third-party test packages. Run these from the repository root:

```powershell
node --test tests/*.test.cjs
pwsh -NoProfile -File tests/cosmetic-rules.test.ps1
pwsh -NoProfile -File tests/rules.test.ps1
pwsh -NoProfile -File tests/threat-rules.test.ps1
```

Browser test commands and offline isolation details are in [Verification](docs/VERIFICATION.md#verification). Keep raw working output in `.artifacts/`; reviewed historical evidence remains under `verification/`.

## Attribution and licensing

The bundled [EasyList](https://easylist.to/) and [EasyList China](https://github.com/easylist/easylistchina/) snapshots are by the EasyList authors. Their source headers and [snapshot catalog](lists/community-lists.json) identify the upstream sources, hashes and [EasyList licence](https://easylist.to/pages/licence.html). The generated community rules are derived from those lists.

No project-wide license has been selected for Module Engine's original source. Third-party list attribution and licensing are separate from that decision. The preserved [project overview](docs/history/PROJECT-NOTES-2026-11-08.md#previous-project-overview) records the earlier references and attribution notes.
