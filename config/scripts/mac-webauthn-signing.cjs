const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

// Why this exists: the Touch ID WebAuthn authenticator only works when the signed
// binary carries a `keychain-access-groups` entry for `<TEAM>.<bundle>.webauthn`,
// which `codesign` refuses to templatize (`$(TeamIdentifierPrefix)` is left
// verbatim), so the group is spliced in here from the team id at packaging time.
// The entry is restricted: macOS kills at launch any binary that claims it
// without an embedded provisioning profile authorising the group. Both inputs
// therefore travel together, and a build with neither keeps the base
// entitlements and simply never offers the authenticator.

const WEBAUTHN_KEYCHAIN_GROUP_SUFFIX = '.webauthn'

/** Inserts the identity and keychain-group keys before the closing `</dict>`. */
function renderWebAuthnEntitlements(baseEntitlementsXml, { teamId, appId }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error(
      `APPLE_TEAM_ID must be a 10-character Apple team id, got ${JSON.stringify(teamId)}`
    )
  }
  if (baseEntitlementsXml.includes('keychain-access-groups')) {
    throw new Error('base macOS entitlements must not already declare keychain-access-groups')
  }
  const closingIndex = baseEntitlementsXml.lastIndexOf('</dict>')
  if (closingIndex === -1) {
    throw new Error('base macOS entitlements plist has no closing </dict>')
  }
  const inserted = [
    '\t<key>com.apple.application-identifier</key>',
    `\t<string>${teamId}.${appId}</string>`,
    '\t<key>com.apple.developer.team-identifier</key>',
    `\t<string>${teamId}</string>`,
    '\t<key>keychain-access-groups</key>',
    '\t<array>',
    `\t\t<string>${teamId}.${appId}${WEBAUTHN_KEYCHAIN_GROUP_SUFFIX}</string>`,
    '\t</array>',
    ''
  ].join('\n')
  return (
    baseEntitlementsXml.slice(0, closingIndex) + inserted + baseEntitlementsXml.slice(closingIndex)
  )
}

/**
 * Resolves the mac signing inputs for one packaging run.
 * Returns `null` when the build is not a signed release or the provisioning
 * profile is absent, which keeps local and ad-hoc builds launchable.
 */
function resolveMacWebAuthnSigning({
  repoRoot,
  isMacRelease,
  appId,
  baseEntitlementsPath,
  env = process.env,
  outputDir = join(repoRoot, 'out', 'mac-signing')
}) {
  if (!isMacRelease) {
    return null
  }
  const profilePath = env.ORCA_MAC_PROVISIONING_PROFILE
  const teamId = env.APPLE_TEAM_ID
  if (!profilePath || !teamId) {
    return null
  }
  const absoluteProfilePath = resolve(repoRoot, profilePath)
  if (!existsSync(absoluteProfilePath)) {
    throw new Error(
      `ORCA_MAC_PROVISIONING_PROFILE points at a missing file: ${absoluteProfilePath}`
    )
  }
  const entitlementsXml = renderWebAuthnEntitlements(
    readFileSync(resolve(repoRoot, baseEntitlementsPath), 'utf8'),
    { teamId, appId }
  )
  mkdirSync(outputDir, { recursive: true })
  const entitlementsPath = join(outputDir, 'entitlements.mac.webauthn.plist')
  writeFileSync(entitlementsPath, entitlementsXml, 'utf8')
  return {
    entitlements: entitlementsPath,
    provisioningProfile: absoluteProfilePath,
    keychainAccessGroup: `${teamId}.${appId}${WEBAUTHN_KEYCHAIN_GROUP_SUFFIX}`
  }
}

module.exports = {
  WEBAUTHN_KEYCHAIN_GROUP_SUFFIX,
  renderWebAuthnEntitlements,
  resolveMacWebAuthnSigning
}
