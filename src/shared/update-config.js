/* Signed-update settings for this release, written by scripts/update-signing.cjs
   (see "Publishing a reported-threat update" in docs/DEVELOPMENT.md).

   threatSource: the public folder that holds the signed reported-threat list,
   for example https://raw.githubusercontent.com/<owner>/Module-Engine/main/updates/threats/.
   While it is empty, this build never checks for updates and uses the list
   bundled with it.

   keys: public keys whose signatures are accepted. Their private keys stay
   outside the repository. To rotate, add the new key, publish with it, and
   remove the old key in a later release. */
globalThis.ModuleEngineUpdateConfig = Object.freeze({
  threatSource: "",
  keys: Object.freeze([
  ])
});
