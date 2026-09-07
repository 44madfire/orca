import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  renderWebAuthnEntitlements,
  resolveMacWebAuthnSigning
} = require('./mac-webauthn-signing.cjs')

const BASE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>com.apple.security.cs.allow-jit</key>
\t<true/>
</dict>
</plist>
`

const tempDirs = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'orca-mac-signing-'))
  tempDirs.push(root)
  await writeFile(join(root, 'entitlements.mac.plist'), BASE_PLIST)
  await writeFile(join(root, 'orca.provisionprofile'), 'profile-bytes')
  return root
}

describe('renderWebAuthnEntitlements', () => {
  it('adds the team-scoped identity and webauthn keychain group to the base plist', () => {
    const xml = renderWebAuthnEntitlements(BASE_PLIST, {
      teamId: 'ABCDE12345',
      appId: 'com.stablyai.orca'
    })
    expect(xml).toContain('<key>com.apple.security.cs.allow-jit</key>')
    expect(xml).toContain(
      '<key>com.apple.application-identifier</key>\n\t<string>ABCDE12345.com.stablyai.orca</string>'
    )
    expect(xml).toContain(
      '<key>com.apple.developer.team-identifier</key>\n\t<string>ABCDE12345</string>'
    )
    expect(xml).toContain('<string>ABCDE12345.com.stablyai.orca.webauthn</string>')
    expect(xml.trimEnd().endsWith('</plist>')).toBe(true)
  })

  it('rejects a team id that is not a 10-character Apple team id', () => {
    expect(() =>
      renderWebAuthnEntitlements(BASE_PLIST, { teamId: 'Lovecast LLC', appId: 'com.stablyai.orca' })
    ).toThrow(/APPLE_TEAM_ID/)
  })

  it('refuses to double-declare keychain-access-groups', () => {
    const xml = renderWebAuthnEntitlements(BASE_PLIST, { teamId: 'ABCDE12345', appId: 'x' })
    expect(() => renderWebAuthnEntitlements(xml, { teamId: 'ABCDE12345', appId: 'x' })).toThrow(
      /already declare/
    )
  })
})

describe('resolveMacWebAuthnSigning', () => {
  const baseOptions = (repoRoot, env) => ({
    repoRoot,
    isMacRelease: true,
    appId: 'com.stablyai.orca',
    baseEntitlementsPath: 'entitlements.mac.plist',
    outputDir: join(repoRoot, 'out'),
    env
  })

  it('writes a rendered entitlements file and resolves the profile path', async () => {
    const root = await makeRepo()
    const signing = resolveMacWebAuthnSigning(
      baseOptions(root, {
        APPLE_TEAM_ID: 'ABCDE12345',
        ORCA_MAC_PROVISIONING_PROFILE: 'orca.provisionprofile'
      })
    )
    expect(signing).toEqual({
      entitlements: join(root, 'out', 'entitlements.mac.webauthn.plist'),
      provisioningProfile: join(root, 'orca.provisionprofile'),
      keychainAccessGroup: 'ABCDE12345.com.stablyai.orca.webauthn'
    })
    expect(await readFile(signing.entitlements, 'utf8')).toContain(
      'ABCDE12345.com.stablyai.orca.webauthn'
    )
  })

  // Why: the restricted entitlement without its profile is a launch-time SIGKILL,
  // so a release missing the profile must fall back to the plain entitlements.
  it('returns null when the profile env is absent', async () => {
    const root = await makeRepo()
    expect(resolveMacWebAuthnSigning(baseOptions(root, { APPLE_TEAM_ID: 'ABCDE12345' }))).toBeNull()
  })

  it('returns null when the team id env is absent', async () => {
    const root = await makeRepo()
    expect(
      resolveMacWebAuthnSigning(
        baseOptions(root, { ORCA_MAC_PROVISIONING_PROFILE: 'orca.provisionprofile' })
      )
    ).toBeNull()
  })

  it('returns null for non-release builds even with every input present', async () => {
    const root = await makeRepo()
    expect(
      resolveMacWebAuthnSigning({
        ...baseOptions(root, {
          APPLE_TEAM_ID: 'ABCDE12345',
          ORCA_MAC_PROVISIONING_PROFILE: 'orca.provisionprofile'
        }),
        isMacRelease: false
      })
    ).toBeNull()
  })

  it('fails loudly when the profile path points nowhere', async () => {
    const root = await makeRepo()
    expect(() =>
      resolveMacWebAuthnSigning(
        baseOptions(root, {
          APPLE_TEAM_ID: 'ABCDE12345',
          ORCA_MAC_PROVISIONING_PROFILE: 'missing.provisionprofile'
        })
      )
    ).toThrow(/missing file/)
  })
})
