/* A fresh adapter (new app process) taking over a session an older process spawned. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { SessionNotFoundError } from './daemon-errors'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

// After an app restart a settled orchestration worker's pane reattaches under `attachOnly`. That
// reattach is what makes the restarted main process an owner of the daemon session, so every
// downstream consumer of the adapter cache — `hasPty`, resize, write, liveness, the serializer —
// sees a session main actually owns. The pane used to attach renderer-only, leaving this cache
// empty and `pty:hasPty` fabricating an absence the renderer closed the tab on (#16904 regression).
describe('DaemonPtyAdapter attach-only ownership after a restart', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let restartedAdapter: DaemonPtyAdapter

  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => createMockSubprocess())
    restartedAdapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
  })
  afterEach(async () => {
    restartedAdapter.dispose()
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  it('owns the session after an attach-only spawn, so the cache alone answers present', async () => {
    const { id } = await harness.adapter.spawn({ cols: 80, rows: 24 })
    expect(restartedAdapter.hasPty(id)).toBe(false)

    const attached = await restartedAdapter.spawn({
      cols: 80,
      rows: 24,
      sessionId: id,
      attachOnly: true
    })

    expect(attached.id).toBe(id)
    expect(attached.isReattach).toBe(true)
    expect(restartedAdapter.hasPty(id)).toBe(true)
  })

  it('refuses to create a session the daemon does not have', async () => {
    await expect(
      restartedAdapter.spawn({ cols: 80, rows: 24, sessionId: 'never-spawned', attachOnly: true })
    ).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(restartedAdapter.hasPty('never-spawned')).toBe(false)
  })

  it('refuses to replace a session that exited before the attach', async () => {
    const { id } = await harness.adapter.spawn({ cols: 80, rows: 24 })
    await harness.adapter.shutdown(id, { immediate: true })

    await expect(
      restartedAdapter.spawn({ cols: 80, rows: 24, sessionId: id, attachOnly: true })
    ).rejects.toBeInstanceOf(SessionNotFoundError)
    expect(restartedAdapter.hasPty(id)).toBe(false)
  })
})
