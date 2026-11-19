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
- **Store accounts and listing details.** These are a Chrome Web Store developer account, a Microsoft Partner Center account for Edge and an addons.mozilla.org account for Firefox signing. Stores ask for a privacy disclosure and a reason for each permission: `<all_urls>`, `scripting`, `webRequest`, `declarativeNetRequestFeedback` and the optional `userScripts`. [Permissions](USER_GUIDE.md#permissions) describes what each is for.
- **Update addresses.** A public Firefox listing needs no custom extension update address. For self-distribution, serve the Firefox update manifest from the project, for example `https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/firefox/updates.json`. Reported-threat updates have their own independently configured address.
- **Firefox data disclosure.** The manifest declares no required data collection. The optional MCP connection can send browsing activity, script/request information and technical diagnostics to the user's selected local client, which may forward them to its AI service. Firefox 140+ asks for the three optional data permissions before connecting; denial, Disconnect, page unload or permission revocation prevents further sharing. Earlier Firefox versions retain the explicit in-page scope approval. This is not project telemetry. Installed userscripts have their own reviewed grants and can transmit data according to their code. See [Mozilla's data-consent requirements](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) and [MCP](MCP.md).

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

   Both archives hold exactly the files the browser tests load, listed in `scripts/extension-files.cjs`. Each manifest drops the other browser's keys. The same source gives byte-identical archives. Local worktrees, `.artifacts`, tests and verification history are excluded. `manifest.json` is at the archive root, as [Mozilla requires](https://extensionworkshop.com/documentation/publish/package-your-extension/).
4. **Chrome and Edge.** Upload the Chromium archive in the Chrome Web Store Developer Dashboard and in Microsoft Partner Center. After review, the stores update installed copies.
5. **Firefox public listing.** In the [Mozilla Add-ons Developer Hub](https://addons.mozilla.org/developers/addon/submit/distribution), choose **On this site** and upload `module-engine-<version>-firefox.zip`. Select desktop platforms; Android has not been validated. Mozilla performs server validation, review and signing. The local ZIP is unsigned, and local tests are not an AMO approval. Upload the corresponding reviewer source archive when asked; generated rules and styles can be rebuilt from its bundled inputs. Accepted public versions use Mozilla's update service.
6. **Firefox self-distribution (alternative).** Build into a separate output directory with `--firefox-update-url https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/firefox/updates.json`. Choose **On your own** at the Developer Hub. After signing completes, download the signed XPI. Obtain the `file.hash` for that signed version independently from your authenticated Mozilla Add-ons version record. Copy Mozilla's full `sha256:…` value into the command below. A hash computed from the candidate XPI itself provides no independent check. [Mozilla version detail API](https://mozilla.github.io/addons-server/topics/api/addons.html#version-detail)

   ```bash
   node scripts/package-extension.cjs firefox-update --xpi module-engine-1.10.0-firefox.xpi --amo-hash sha256:<digest-from-mozilla> --link https://github.com/<owner>/Module-Engine/releases/download/v1.10.0/module-engine-1.10.0-firefox.xpi
   ```

   The helper checks the exact archive bytes against Mozilla's digest before reading the package or writing `updates/firefox/updates.json`. It also checks the signature filenames, add-on ID and update address. Firefox performs the cryptographic signature verification at installation. Attach the verified XPI to the release, then publish the updated manifest.

The command-line alternative to the Developer Hub upload is Mozilla's `web-ext sign`, which needs a separate install and the publisher's API keys.

## Reviewer source archive

Commit the release changes before archiving so the source matches the upload. Replace `1.9.0` with the release's actual version:

```powershell
$sourceEvidence = @((Get-Content -Raw lists/site-ad-hosts.json | ConvertFrom-Json).hosts.evidence | Sort-Object -Unique)
git archive --format=zip --output=dist/module-engine-1.9.0-source.zip HEAD LICENSE README.md manifest.json src icons lists rules vendor scripts docs tests mcp development $sourceEvidence
```

Extract the source, then run `node scripts/package-extension.cjs build` from its root to reproduce the upload. No npm packages, downloads or bundler are required; Node 22+ is used. JavaScript is shipped readable. Included prebuilt rule files are also reproducible offline with PowerShell 7+: `pwsh -NoProfile -File scripts/build-rules.ps1`, followed by the same packaging command. The list inputs, catalogs, compiler scripts and third-party provenance/licences are included. See [Development](DEVELOPMENT.md#reviewed-catalog-and-rule-builds) and [Mozilla's source-submission guide](https://extensionworkshop.com/documentation/publish/source-code-submission/).
