// electron-builder afterSign hook — runs notarization via @electron/notarize
// after every binary inside the .app has been code-signed.
//
// Required env vars:
//   APPLE_API_KEY      — path to the App Store Connect API key (.p8 file)
//   APPLE_API_KEY_ID   — Key ID from App Store Connect
//   APPLE_API_ISSUER   — Issuer ID (UUID) from App Store Connect
//   APPLE_TEAM_ID      — 10-character Apple Team ID
//
// In CI without these env vars set (e.g. PR builds without secrets),
// notarization is skipped with a clear log line — the unsigned/unnotarized
// .app is still produced for smoke-testing purposes but is NOT distributable.

const { notarize } = require("@electron/notarize")

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== "darwin") return

  const apiKey = process.env.APPLE_API_KEY
  const apiKeyId = process.env.APPLE_API_KEY_ID
  const apiIssuer = process.env.APPLE_API_ISSUER
  const teamId = process.env.APPLE_TEAM_ID

  if (!apiKey || !apiKeyId || !apiIssuer || !teamId) {
    console.log(
      "[notarize] APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER / APPLE_TEAM_ID not set — skipping notarization. Build artifact is NOT distributable.",
    )
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  console.log(`[notarize] submitting ${appPath} via notarytool…`)

  await notarize({
    tool: "notarytool",
    appPath,
    appleApiKey: apiKey,
    appleApiKeyId: apiKeyId,
    appleApiIssuer: apiIssuer,
    teamId,
  })

  console.log("[notarize] complete — Apple has accepted the submission")
}
