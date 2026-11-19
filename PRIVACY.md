# Module Engine privacy policy

Last updated: 20 November 2026. Applies to Module Engine 1.9.0 and its optional local helpers.

Module Engine requires no account and has no project telemetry or analytics. Its core features work without sending your settings, scripts or browsing activity to the developer. The optional connections described below have separate controls.

## Data kept in your browser

Settings, custom filters, userscript source, cached dependencies, script values and activity records are stored locally in the browser. Optional network capture is off by default and records bounded request metadata, such as URLs, timing and errors. It does not capture request headers or bodies.

## Downloads and userscripts

Enabled filter updates contact list publishers. Script installation and enabled update checks contact the script's configured hosts. Preparing dependencies downloads the resources named by the script. These hosts receive normal connection information, including your IP address. The extension's list updates, script update checks and dependency downloads omit cookies and referrer information.

Enabled userscripts can read or change matching pages and may transmit information according to their code and granted access. Some helpers permit scoped cookie access or authenticated network requests. Review scripts, dependencies, site matches and requested permissions before enabling them. Third-party scripts and services have their own privacy practices.

## Optional MCP sharing

MCP is disconnected until you pair a local client and approve the information it may access. Depending on those scopes, shared information can include extension status, script source and metadata, diagnostic logs and captured network request metadata. Your client may forward it to its configured AI provider, whose privacy and retention practices also apply.

Firefox requests optional data-sharing permission before connecting. Declining leaves MCP disconnected while the blocker and userscript manager remain available. Disconnecting, closing the connected extension page or revoking permission stops further sharing; it does not retract information already received by a client or service. See the [MCP guide](docs/MCP.md) for scopes and session controls.

## Backups and local helpers

Backup exports are unencrypted JSON files saved to a location you choose. They can contain script source, saved values and other private information. Module Engine does not upload them. Protect or delete exported files yourself; they remain separate from the browser's stored data.

The optional external-editor helper reads only the script file you select and transfers its contents to the extension after pairing. It does not browse directories, write files or execute scripts. Local helpers are not installed or started automatically.

## Your controls

You can disable updates or modules, remove scripts, clear logs, stop network capture and disconnect local helpers. Browser settings also let you remove the add-on and its data. Copies you export or share with third parties must be managed separately. Disabling a script stops future execution and live helper access; reload open pages to remove code that has already run.

## Website and support

The project website contains no analytics scripts or external page assets. It is hosted on GitHub Pages, where GitHub handles requests under its [privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

For questions, open a [GitHub issue](https://github.com/JasXTD/Module-Engine/issues). Issues are public: do not include credentials, private backups or personal browsing logs. Information you choose to post there is handled by GitHub and is visible to the project's maintainers and other visitors.
