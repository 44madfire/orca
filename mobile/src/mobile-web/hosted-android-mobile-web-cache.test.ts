import { describe, expect, it, vi } from 'vitest'
import {
  parseAndroidGenerationPath,
  readAndroidCommittedGenerations,
  readSingleAndroidGeneration
} from '../../scripts/hosted-android-mobile-web-cache.mjs'

const hostOne = '1'.repeat(64)
const hostTwo = '2'.repeat(64)
const buildA = 'a'.repeat(64)
const buildB = 'b'.repeat(64)

describe('hosted Android mobile web cache evidence', () => {
  it('reads the host and build out of a committed generation path', () => {
    expect(
      parseAndroidGenerationPath(`no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`)
    ).toEqual({
      path: `no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`,
      hostIdentity: hostOne,
      buildId: buildA
    })
    expect(() =>
      parseAndroidGenerationPath(`no_backup/OrcaMobileWeb/${hostOne}/generations/../escape`)
    ).toThrow('Android cache returned an invalid generation path')
  })

  it('lists one committed generation per paired host', async () => {
    const runAdb = generationExecutor([
      `no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`,
      `no_backup/OrcaMobileWeb/${hostTwo}/generations/${buildB}`
    ])

    await expect(readAndroidCommittedGenerations('adb', runAdb)).resolves.toEqual([
      {
        path: `no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`,
        hostIdentity: hostOne,
        buildId: buildA
      },
      {
        path: `no_backup/OrcaMobileWeb/${hostTwo}/generations/${buildB}`,
        hostIdentity: hostTwo,
        buildId: buildB
      }
    ])
  })

  it('requires exactly one committed generation for single-host drills', async () => {
    const single = generationExecutor([`no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`])
    const two = generationExecutor([
      `no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`,
      `no_backup/OrcaMobileWeb/${hostTwo}/generations/${buildB}`
    ])

    await expect(readSingleAndroidGeneration('adb', single)).resolves.toMatchObject({
      buildId: buildA
    })
    await expect(readSingleAndroidGeneration('adb', two)).rejects.toThrow(
      'Expected one Android committed generation, found 2'
    )
  })

  // The staged tree is never an activation candidate, so the drill must not walk into it.
  it('never reports a staged tree as a committed generation', async () => {
    const runAdb = vi.fn(async (_command: string, args: string[]) => {
      expect(args).toContain(`no_backup/OrcaMobileWeb/*/generations/*`)
      return `no_backup/OrcaMobileWeb/${hostOne}/generations/${buildA}`
    })

    await expect(readAndroidCommittedGenerations('adb', runAdb)).resolves.toHaveLength(1)
  })
})

function generationExecutor(paths: string[]) {
  return vi.fn(async () => paths.join('\n'))
}
