# Module Engine

A modular browser extension for **Chrome, Edge and Firefox**, combining local ad blocking with an optional userscript manager.

Module Engine uses the browser's Manifest V3 APIs and bundled filter data. It runs as an extension, without a localhost service or a package-install step. Formerly **BlockAds Shield**.

## Features

- **Independent modules:** pause ad blocking without disabling userscripts, or keep the userscript module off entirely.
- **Ad and tracker filtering:** bundled network rules, EasyList snapshots, cosmetic hiding, advanced page hiding and a visual element picker.
- **Custom controls:** blocked domains, allowed domains, per-site exceptions and scoped request filters.
- **Pop-up protection:** an optional per-site pop-up guard and automatic cleanup of confirmed blocked blank pop-up tabs.
- **Local userscripts:** import, edit, enable and export `.user.js` files, with explicit site scopes and a documented subset of GM APIs.
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

Saving an edited script disables it until you enable it again. Disabling a script prevents future registrations and revokes its storage access; reload open pages to remove code that has already run.

The manager supports a focused subset of userscript metadata and GM APIs. It does not fetch script code or updates, and it does not claim full Violentmonkey compatibility. See the [userscript compatibility table](docs/USER_GUIDE.md#modules-and-userscripts).

## Browser support and verification

The most recent native browser checks were completed on **5 November 2026**:

| Browser | Ad-blocking checks | Blocked-tab cleanup checks | Cleanup availability |
| --- | ---: | ---: | --- |
| Chrome 156 | 539 passed | 25 passed | Loaded unpacked, with native rule feedback |
| Edge 156 | 539 passed | 25 passed | Loaded unpacked, with native rule feedback |
| Firefox 159.0.1 | 533 passed | 28 passed | Conservative rule checks; no debugging preference needed |

There were also **258 passing unit tests**. Browser checks used disposable profiles and owned loopback fixtures behind deny proxies. Firefox's native userscript execution remains unverified; Chrome and Edge have separate userscript-manager coverage. See the [verification records and limitations](docs/VERIFICATION.md).

Blocked-tab cleanup applies to new tabs with a browser-reported opener and a confirmed blocked initial navigation. Existing, pinned, previously loaded and uncertain tabs stay open. A blocked link intentionally opened in a new tab can also qualify. Full behavior is documented in the [user guide](docs/USER_GUIDE.md#controls-and-scope).

## Privacy and limits

Module Engine has no telemetry. Settings, script source, script values and activity records stay in browser extension storage. Scripts you enable can themselves read matching pages and make web requests, so review their code before enabling them.

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
