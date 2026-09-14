// Bounded Pi version probe tests (SNC1.10, deterministic, offline).
import { describe, expect, it, vi } from 'vitest'
import { createLazyPiVersionProbe } from './pi-runtime-compat'
import { probePiVersionBounded } from './pi-version-probe'
describe('Pi version probe uses the Pi launch env', () => {
  it('passes the resolved env to the spawn (GUI PATH safe)', async () => {
    const seen: { env?: NodeJS.ProcessEnv }[] = []
    const runImpl = vi.fn(async (spec: { env?: NodeJS.ProcessEnv }) => {
      seen.push({ env: spec.env })
      return { code: 0, signal: null, stdout: 'pi 0.85.1\n', stderr: '', timedOut: false }
    })
    const probed = await probePiVersionBounded({
      env: { PATH: '/resolved-swallow' } as NodeJS.ProcessEnv,
      runImpl: runImpl as never
    })
    expect(probed).toEqual({ ok: true, version: '0.85.1' })
    expect(seen[0]?.env).toMatchObject({ PATH: '/resolved-swallow' })
  })
  it('proves pi only on the resolved PATH (ambient miss still falls back)', async () => {
    const runImpl = vi.fn(async (spec: { program: string; env?: NodeJS.ProcessEnv }) => {
      const path = (spec.env?.['PATH'] as string | undefined) ?? ''
      if (path.includes('/resolved-only')) {
        return { code: 0, signal: null, stdout: '0.86.0', stderr: '', timedOut: false }
      }
      throw new Error('spawn ENOENT')
    })
    await expect(probePiVersionBounded({ runImpl: runImpl as never })).resolves.toMatchObject({
      ok: false
    })
    await expect(
      probePiVersionBounded({
        env: { PATH: '/resolved-only' } as NodeJS.ProcessEnv,
        runImpl: runImpl as never
      })
    ).resolves.toEqual({ ok: true, version: '0.86.0' })
  })
  it('caches the lazy probe across acquires (one bounded spawn)', async () => {
    let resolveCalls = 0
    const lazy = createLazyPiVersionProbe({
      resolveEnv: async () => {
        resolveCalls += 1
        return { PATH: '/resolved' } as NodeJS.ProcessEnv
      },
      command: 'pi-test-missing-zzz'
    })
    expect(resolveCalls).toBe(0)
    const first = lazy()
    const second = lazy()
    expect(first).toBe(second)
    await expect(first).resolves.toBeNull()
    expect(resolveCalls).toBe(1)
  })
})
