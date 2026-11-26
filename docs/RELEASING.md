# Releasing Module Engine

How a version is packaged and how installed copies then update themselves. Every step here runs offline except the uploads, which need the publisher's own accounts; `scripts/package-extension.cjs` never signs, uploads or contacts anything.

[Development](DEVELOPMENT.md) · [Verification](VERIFICATION.md) · [README](../README.md)

## How installed copies update

| Browser | How people install it | How it updates |
| --- | --- | --- |
| Chrome | Chrome Web Store listing | The store updates installed copies after each accepted upload. |
| Microsoft Edge | Microsoft Edge Add-ons listing | The same, through Edge Add-ons. |
| Firefox (public listing) | Firefox Add-ons (AMO) | Mozilla hosts and updates accepted versions. Build without `--firefox-update-url`. |
| Firefox (self-distribution) | A Mozilla-signed package from the project's releases | Firefox checks the package's `update_url` and installs a higher signed version. |
| Any | Unpacked or temporary source install (development) | Never: reload the folder by hand. |

Chrome and Edge on Windows and macOS install extensions only from their stores, apart from enterprise policy, so a self-hosted Chrome package cannot update ordinary installs. Firefox allows self-distribution, but only of packages Mozilla has signed.

Inside every install, the filter lists (EasyList and EasyList China) update themselves from their publishers. The reported-threat list can update itself from the project folder once `src/shared/update-config.js` names one; see [Development](DEVELOPMENT.md#publishing-a-reported-threat-update).

## Before the first public release

These are the publisher's decisions; nothing in the code makes them.

- **Licence.** Module Engine's own source is MIT ([LICENSE](../LICENSE)). Bundled lists and vendored code keep their own licences, listed in the [README](../README.md#attribution-and-licensing); store listings that ask for a licence take MIT for the extension.
- **Firefox add-on ID.** The manifest's `browser_specific_settings.gecko.id` is `blockads-shield@local.extension`, from the old name. Mozilla ties every signed version to this ID, and an installed copy only takes updates with the same ID. Choose the permanent ID before the first signed package, for example one based on the project's domain or repository.
- **Store accounts and listing details.** These are a Chrome Web Store developer account, a Microsoft Partner Center account for Edge and an addons.mozilla.org account for Firefox signing. Stores ask for a privacy disclosure and a reason for each permission in the uploaded manifest, including `<all_urls>`, `scripting`, `webRequest` and the optional `userScripts`. [Permissions](USER_GUIDE.md#permissions) describes what each is for.
- **Update addresses.** A public Firefox listing needs no custom extension update address. For self-distribution, serve the Firefox update manifest from the project, for example `https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/firefox/updates.json`. Reported-threat updates have their own independently configured address.
- **Firefox data disclosure.** The manifest declares no required data collection. The optional MCP connection can send browsing activity, script/request information and technical diagnostics to the user's selected local client, which may forward them to its AI service. The Firefox package requires Firefox 142+ and asks for the three optional data permissions before connecting; denial, Disconnect, page unload or permission revocation prevents further sharing. This is not project telemetry. Installed userscripts have their own reviewed grants and can transmit data according to their code. See [Mozilla's data-consent requirements](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) and [MCP](MCP.md).

## Each release

1. **Version.** `node scripts/package-extension.cjs version 1.10.0` raises `manifest.json`'s version; every store and Firefox need a higher version than the last. Rebuild the rules first if the bundled lists or catalogs changed (see [Development](DEVELOPMENT.md#reviewed-catalog-and-rule-builds)).
2. **Tests.** Run the Node and PowerShell suites from the [README](../README.md#development-quick-start) and the browser suites in [Verification](VERIFICATION.md). Then run `node tests/package-browser.cjs chrome`, `edge` and `firefox --listed`, which load the built packages themselves. Omit `--listed` to test the self-distributed Firefox update configuration.
3. **Packages.**

   ```bash
   node scripts/package-extension.cjs build
   ```

   This writes these files to `dist/`:
   - `module-engine-<version>-chromium.zip`, for both Chrome and Edge;
   - `module-engine-<version>-firefox.zip`;
   - `SHA256SUMS`.

   Both archives hold exactly the files the browser tests load, listed in `scripts/extension-files.cjs`. Each manifest drops the other browser's keys. The Chromium store manifest also removes `declarativeNetRequestFeedback` (used here only for unpacked debug events) and `webRequestBlocking` (used only by the Firefox helpers). The Firefox manifest removes Chromium's `offscreen` permission. The source manifest retains these permissions for Firefox and unpacked development. The same source gives byte-identical archives. Local worktrees, `.artifacts`, tests and verification history are excluded. `manifest.json` is at the archive root, as [Mozilla requires](https://extensionworkshop.com/documentation/publish/package-your-extension/).
4. **Chrome and Edge.** Upload the Chromium archive in the Chrome Web Store Developer Dashboard and in Microsoft Partner Center. After review, the stores update installed copies.
5. **Firefox public listing.** In the [Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution), choose **On this site** and upload `module-engine-<version>-firefox.zip`. Select desktop platforms; Android has not been validated. Mozilla performs server validation, review and signing. The local ZIP is unsigned, and local tests are not an AMO approval. Upload the corresponding reviewer source archive when asked; generated rules and styles can be rebuilt from its bundled inputs. Accepted public versions use Mozilla's update service.
6. **Firefox self-distribution (alternative).** Build into a separate output directory with `--firefox-update-url https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/firefox/updates.json`. Choose **On your own** at the Developer Hub. After signing completes, download the signed XPI. Obtain the `file.hash` for that signed version independently from your authenticated Mozilla Add-ons version record. Copy Mozilla's full `sha256:…` value into the command below. A hash computed from the candidate XPI itself provides no independent check. [Mozilla version detail API](https://mozilla.github.io/addons-server/topics/api/addons.html#version-detail)

   ```bash
   node scripts/package-extension.cjs firefox-update --xpi module-engine-1.10.0-firefox.xpi --amo-hash sha256:<digest-from-mozilla> --link https://github.com/<owner>/Module-Engine/releases/download/v1.10.0/module-engine-1.10.0-firefox.xpi
   ```

   The helper checks the exact archive bytes against Mozilla's digest before reading the package or writing `updates/firefox/updates.json`. It also checks the signature filenames, add-on ID and update address. Firefox performs the cryptographic signature verification at installation. Attach the verified XPI to the release, then publish the updated manifest.

The command-line alternative to the Developer Hub upload is Mozilla's `web-ext sign`, which needs a separate install and the publisher's API keys.

## Reviewer source archive

Commit the release changes before archiving so the source matches the upload. Use the version from the committed manifest for the archive name.

```powershell
$version = (git show HEAD:manifest.json | ConvertFrom-Json).version
git archive --format=zip --output="dist/module-engine-$version-source.zip" HEAD LICENSE PRIVACY.md README.md manifest.json src icons lists rules vendor scripts docs tests mcp development
```

Extract the source, then run `node scripts/package-extension.cjs build` from its root to reproduce the upload. No npm packages, downloads or bundler are required; Node 22+ is used. JavaScript is shipped readable. Included prebuilt rule files are also reproducible offline with PowerShell 7+: `pwsh -NoProfile -File scripts/build-rules.ps1`, followed by the same packaging command. The list inputs, catalogs, compiler scripts and third-party provenance/licences are included. See [Development](DEVELOPMENT.md#reviewed-catalog-and-rule-builds) and [Mozilla's source-submission guide](https://extensionworkshop.com/documentation/publish/source-code-submission/).

## AMO version notes for 1.9.2

Use these notes for the 1.9.2 submission.

```text
Module Engine 1.9.2 fixes eight issues in filtering, userscript updates and backup previews.

- Blocking or allowing a host such as www.example.com keeps the www prefix when you save the entry.
- Requests from a paused site or frame no longer create flags. Other flags identify the site you visited.
- Updated filter-list exceptions can unhide elements covered by bundled hiding rules.
- Open tabs apply page-hiding changes when a filter list updates or rolls back.
- The Activity log distinguishes custom request filters from custom domain blocks.
- Userscript install and update screens explain when updates can install automatically and when they need approval.
- If a userscript update check fails, the previously downloaded update stays available for review alongside the error.
- Backup previews show accent color changes, the dark-website setting and the individual hosts added to or removed from its exception list.
```

## AMO notes to reviewer for 1.9.2

Copy the following into Notes to Reviewer. Upload the matching source ZIP in the source-code step.

```text
No website account, subscription, test username or password is required. Please test on desktop Firefox 142 or later; Android has not been validated and is not included in the intended release platforms.

Open the toolbar popup or the add-on's options page. Ad blocking and userscripts have separate switches. The userscript module starts disabled. To test it, open Modules & scripts, choose Allow userscript access and approve Firefox's prompt, enable the module, then create or import a script with an explicit site match. Review and save it, enable Run this script, and reload a matching ordinary HTTP(S) page. Browser-restricted pages are not script targets. Saving an edit pauses that script again. Optional clipboard, notification, download, cookie and network helper access depends on the script's declared grants and separate browser approval.

To test Backup & restore, download a backup, change a saved setting, select the backup and inspect the preview, then acknowledge and choose Replace and restore. This replaces saved settings and the script library. Restored scripts and their module remain disabled. Backups are local, unencrypted JSON; they are not sent to a server and do not include browser permissions or MCP connection approvals.

The extension has no project telemetry or required data collection. Filter updates download lists from their publishers. User-installed scripts may access their matched pages and transmit data according to their source and granted access. Optional MCP debugging connects only after in-page approval and Firefox's optional data-consent prompt. It sends the selected status, script information and diagnostic/request metadata to the user's local MCP client, which may forward it to its configured AI service. No AI account is required for the blocker or userscript manager. MCP is off unless explicitly paired; source ZIP docs/MCP.md explains the optional Node-based server and client setup.

The matching source ZIP contains readable JavaScript, bundled rule inputs, compiler scripts and third-party licences/provenance. From its extracted root, run node scripts/package-extension.cjs build using Node 22+. To regenerate the bundled rules first, run pwsh -NoProfile -File scripts/build-rules.ps1 with PowerShell 7+, then the packaging command. The Firefox upload is dist/module-engine-1.9.2-firefox.zip. Build and testing details are in docs/RELEASING.md, docs/DEVELOPMENT.md and docs/VERIFICATION.md.
```
