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
  useAppStore.setState({ automaticResumeBlockedPaneKeys: {}, automaticResumeFenceGeneration: 0 })
})

// The renderer's blocked-pane map starts empty on every boot, reload included, and is never
// persisted. Main answers the startup handshake with its committed fenced-pane set, versioned by
// its commit generation so this reply cannot override a lift that overtook it.
describe('seeding the resume fence from the renderer-startup handshake', () => {
  it('blocks every pane main reports as fenced', async () => {
    stubRecovery({ generation: 3, blockedPaneKeys: [PANE_KEY] })

    await recoverLegacyWorkerTerminalsAndSeedResumeFences()

    expect(useAppStore.getState().automaticResumeBlockedPaneKeys[PANE_KEY]).toBe(true)
  })

  // The snapshot is main's committed state, not the plan a pass started with, so a pane it no
  // longer claims is retired here. This is the only channel that can lift a fence for a pane with
  // no sleeping record after a reload, since `liftRetiredFences` can sweep only records.
  it('retires a pane main no longer reports as fenced', async () => {
    useAppStore.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, true, 4)
    stubRecovery({ generation: 5, blockedPaneKeys: [] })

    await recoverLegacyWorkerTerminalsAndSeedResumeFences()

    expect(useAppStore.getState().automaticResumeBlockedPaneKeys).toEqual({})
  })

  // A release or takeover can retire the fence after main read the reply but before it lands. The
  // newer lift carries a higher commit generation, so the older reply must not walk it back.
  it('drops a reply older than a lift that already arrived', async () => {
    useAppStore.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, false, 9)
    stubRecovery({ generation: 8, blockedPaneKeys: [PANE_KEY] })

    await recoverLegacyWorkerTerminalsAndSeedResumeFences()

    expect(useAppStore.getState().automaticResumeBlockedPaneKeys).toEqual({})
  })

  // A pass whose session write threw commits nothing, so it reports the previous committed state
  // at the previous generation rather than publishing keys the push channel never announced.
  it('applies a reply at the generation already applied', async () => {
    useAppStore.getState().setSleepingAgentAutomaticResumeBlocked(PANE_KEY, false, 6)
    stubRecovery({ generation: 6, blockedPaneKeys: [PANE_KEY] })

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
