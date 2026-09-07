import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { recoverLegacyWorkerTerminalsAndSeedResumeFences } from './legacy-worker-resume-fence-seed'

const PANE_KEY = 'tab-1:11111111-2222-4333-8444-555555555555'

function stubRecovery(result: unknown): ReturnType<typeof vi.fn> {
  const recover = vi.fn().mockResolvedValue(result)
  vi.stubGlobal('window', {
    ...globalThis.window,
    api: { app: { recoverLegacyWorkerTerminalsForRendererStartup: recover } }
  })
  return recover
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, false)
})

// The renderer's blocked-pane map starts empty on every boot, reload included, and is never
// persisted. Main answers the startup handshake with the fenced-pane set so the fence survives.
describe('seeding the resume fence from the renderer-startup handshake', () => {
  it('blocks every pane main reports as fenced', async () => {
    stubRecovery({ blockedPaneKeys: [PANE_KEY] })

    await recoverLegacyWorkerTerminalsAndSeedResumeFences()

    expect(useAppStore.getState().automaticResumeBlockedPaneKeys[PANE_KEY]).toBe(true)
  })

  // An unreadable recovery plan also yields an empty set, and loss of contact with the plan is
  // never evidence that a pane stopped needing its fence — so the seed only ever adds.
  it('leaves an already-blocked pane alone when main reports nothing', async () => {
    useAppStore.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true)
    stubRecovery({ blockedPaneKeys: [] })

    await recoverLegacyWorkerTerminalsAndSeedResumeFences()

    expect(useAppStore.getState().automaticResumeBlockedPaneKeys[PANE_KEY]).toBe(true)
  })

  // A paired/web client has no wire method for the fence yet and resolves an empty snapshot.
  it('tolerates a client that cannot answer the handshake', async () => {
    stubRecovery(undefined)

    await expect(recoverLegacyWorkerTerminalsAndSeedResumeFences()).resolves.toBeUndefined()

    expect(useAppStore.getState().automaticResumeBlockedPaneKeys).toEqual({})
  })
})
