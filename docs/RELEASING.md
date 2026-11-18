# Releasing Module Engine

How a version is packaged and how installed copies then update themselves. Every step here runs offline except the uploads, which need the publisher's own accounts; `scripts/package-extension.cjs` never signs, uploads or contacts anything.

[Development](DEVELOPMENT.md) · [Verification](VERIFICATION.md) · [README](../README.md)

## How installed copies update

| Browser | How people install it | How it updates |
| --- | --- | --- |
| Chrome | Chrome Web Store listing | The store updates installed copies after each accepted upload. |
| Microsoft Edge | Microsoft Edge Add-ons listing | The same, through Edge Add-ons. |
| Firefox | A Mozilla-signed package from the project's releases | Firefox checks the package's `update_url` (every 24 hours by default) and installs a higher signed version. |
| Any | Unpacked or temporary source install (development) | Never: reload the folder by hand. |

Chrome and Edge on Windows and macOS install extensions only from their stores, apart from enterprise policy, so a self-hosted Chrome package cannot update ordinary installs. Firefox allows self-distribution, but only of packages Mozilla has signed.

Inside every install, the filter lists (EasyList and EasyList China) update themselves from their publishers. The reported-threat list can update itself from the project folder once `src/shared/update-config.js` names one; see [Development](DEVELOPMENT.md#publishing-a-reported-threat-update).

## Before the first public release

These are the publisher's decisions; nothing in the code makes them.

- **Licence.** Module Engine's own source is MIT ([LICENSE](../LICENSE)). Bundled lists and vendored code keep their own licences, listed in the [README](../README.md#attribution-and-licensing); store listings that ask for a licence take MIT for the extension.
- **Firefox add-on ID.** The manifest's `browser_specific_settings.gecko.id` is `blockads-shield@local.extension`, from the old name. Mozilla ties every signed version to this ID, and an installed copy only takes updates with the same ID. Choose the permanent ID before the first signed package, for example one based on the project's domain or repository.
- **Store accounts and listing details.** These are a Chrome Web Store developer account, a Microsoft Partner Center account for Edge and an addons.mozilla.org account for Firefox signing. Stores ask for a privacy disclosure and a reason for each permission: `<all_urls>`, `scripting`, `webRequest`, `declarativeNetRequestFeedback` and the optional `userScripts`. [Permissions](USER_GUIDE.md#permissions) describes what each is for.
- **Update addresses.** Once the repository exists, the Firefox update manifest is served from it, for example `https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/firefox/updates.json`. The reported-threat folder is served from the same place.

## Each release

1. **Version.** `node scripts/package-extension.cjs version 1.10.0` raises `manifest.json`'s version; every store and Firefox need a higher version than the last. Rebuild the rules first if the bundled lists or catalogs changed (see [Development](DEVELOPMENT.md#reviewed-catalog-and-rule-builds)).
2. **Tests.** Run the Node and PowerShell suites from the [README](../README.md#development-quick-start) and the browser suites in [Verification](VERIFICATION.md). Then run `node tests/package-browser.cjs chrome`, `edge` and `firefox`, which load the built packages themselves.
3. **Packages.**

   ```bash
   node scripts/package-extension.cjs build --firefox-update-url https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/firefox/updates.json
   ```

   This writes these files to `dist/`:
   - `module-engine-<version>-chromium.zip`, for both Chrome and Edge;
   - `module-engine-<version>-firefox.zip`;
   - `SHA256SUMS`.

   Both archives hold exactly the files the browser tests load, listed in `scripts/extension-files.cjs`. Each manifest drops the other browser's keys. The same source gives byte-identical archives.
4. **Chrome and Edge.** Upload the Chromium archive in the Chrome Web Store Developer Dashboard and in Microsoft Partner Center. After review, the stores update installed copies.
5. **Firefox.** Upload the Firefox archive to addons.mozilla.org's Developer Hub, and choose to distribute it on your own. Mozilla validates and signs it, adding `META-INF` signature files; fix anything its validation reports. Download the signed `.xpi` and attach it to the GitHub release for this version. Then record it:

   ```bash
   node scripts/package-extension.cjs firefox-update --xpi module-engine-1.10.0-firefox.xpi --link https://github.com/<owner>/Module-Engine/releases/download/v1.10.0/module-engine-1.10.0-firefox.xpi
   ```

   This adds the version, link and SHA-256 to `updates/firefox/updates.json`. It refuses a package without Mozilla's signature files, with another add-on ID, or without an `update_url`. Commit and push that file; installed copies pick the version up at their next check.

The command-line alternative to the Developer Hub upload is Mozilla's `web-ext sign`, which needs a separate install and the publisher's API keys.
