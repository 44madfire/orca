/* A fresh adapter (new app process) answering presence for a session an older process spawned. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { resolveProviderPtyPresence } from '../ipc/pty/provider/liveness'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter presence for a session this process never attached', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let restoredAdapter: DaemonPtyAdapter

  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    restoredAdapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
  })
  afterEach(async () => {
    restoredAdapter.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  it('reads the daemon instead of trusting its own empty cache', async () => {
    const { id } = await harness.adapter.spawn({ cols: 80, rows: 24 })

    // The cache is what `hasPty` alone answers; it is empty because nothing in this process
    // attached the session. The daemon still owns a live process under that id.
    expect(restoredAdapter.hasPty(id)).toBe(false)
    await expect(resolveProviderPtyPresence(restoredAdapter, id)).resolves.toBe(true)
  })

  it('still answers absent for an id the daemon never had', async () => {
    await expect(resolveProviderPtyPresence(restoredAdapter, 'never-spawned')).resolves.toBe(false)
  })

  it('answers absent after the session exits', async () => {
    const { id } = await harness.adapter.spawn({ cols: 80, rows: 24 })
    await harness.adapter.shutdown(id, { immediate: true })

    await expect(resolveProviderPtyPresence(restoredAdapter, id)).resolves.toBe(false)
  })
})
