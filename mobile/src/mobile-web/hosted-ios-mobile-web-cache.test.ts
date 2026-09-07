import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readCommittedBuildId,
  readIosCommittedGenerations
} from '../../scripts/hosted-ios-mobile-web-cache.mjs'
import { selectHostedIosWebContentPid } from '../../scripts/hosted-ios-webcontent-process.mjs'

const buildA = 'a'.repeat(64)
const buildB = 'b'.repeat(64)
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('hosted iOS mobile web cache evidence', () => {
  it('reports the single committed generation per paired host', async () => {
    const root = await createAppData()
    await writeGeneration(root, '1'.repeat(64), buildA)
    await writeGeneration(root, '2'.repeat(64), buildB)

    await expect(readIosCommittedGenerations(root)).resolves.toEqual([
      expect.objectContaining({ hostIdentity: '1'.repeat(64), buildId: buildA }),
      expect.objectContaining({ hostIdentity: '2'.repeat(64), buildId: buildB })
    ])
  })

  it('skips a host with no committed generation and refuses more than one', async () => {
    const root = await createAppData()
    const empty = await hostRoot(root, '1'.repeat(64))
    await mkdir(empty, { recursive: true })
    const doubled = await hostRoot(root, '2'.repeat(64))
    await mkdir(path.join(doubled, 'generations', buildA), { recursive: true })
    await mkdir(path.join(doubled, 'generations', buildB), { recursive: true })

    await expect(readCommittedBuildId(empty)).resolves.toBeNull()
    await expect(readCommittedBuildId(doubled)).rejects.toThrow(
      'iOS host kept 2 generations instead of one'
    )
  })

  // The staged tree is never an activation candidate, so the drill must not report it.
  it('ignores a staged tree beside the committed generation', async () => {
    const root = await createAppData()
    const host = await writeGeneration(root, '1'.repeat(64), buildA)
    await mkdir(path.join(host, 'tmp', buildB), { recursive: true })

    await expect(readCommittedBuildId(host)).resolves.toBe(buildA)
  })

  it('selects only the simulator WebContent child', () => {
    const processes = [
      '  100 1 /System/Library/com.apple.WebKit.WebContent',
      '  200 67323 /Runtime/WebContentExtension.appex/com.apple.WebKit.WebContent -LaunchArguments',
      '  300 90000 /Runtime/WebContentExtension.appex/com.apple.WebKit.WebContent -LaunchArguments'
    ].join('\n')

    expect(selectHostedIosWebContentPid(processes, 67323)).toBe(200)
    expect(() => selectHostedIosWebContentPid(`${processes}\n${processes}`, 67323)).toThrow(
      'Expected one iOS WebContent process, found 2'
    )
  })
})

async function createAppData() {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-ios-cache-evidence-'))
  temporaryRoots.push(root)
  return root
}

async function hostRoot(root: string, hostIdentity: string) {
  return path.join(root, 'Library', 'Application Support', 'OrcaMobileWeb', hostIdentity)
}

async function writeGeneration(root: string, hostIdentity: string, buildId: string) {
  const host = await hostRoot(root, hostIdentity)
  await mkdir(path.join(host, 'generations', buildId), { recursive: true })
  return host
}
