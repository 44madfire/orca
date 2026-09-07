import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { LegacyWorkerRecoveryPorts } from './runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeStore } from './runtime-store-contract'
import { it, expect, vi } from 'vitest'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import { runLegacyWorkerTerminalRecovery } from './runtime-legacy-worker-terminal-recovery-runner'
function harness() {
  let plan: LegacyWorkerTerminalRecoveryPlan = {
    blockedPanes: [{ paneKey: 'a', worktreeId: 'wt', contractVersion: 1, settled: true }],
    candidates: [],
    ambiguousDispatchIds: []
  }
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: {}
  }
  let fail = false
  const notify = vi.fn()
  const store = {
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      if (fail) {
        throw new Error('stage failed')
      }
      session = next
    },
    getWorkspaceSessionHostIds: () => ['local']
  }
  const p = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
    () => store as unknown as RuntimeStore,
    () => null as never,
    () => 'local' as never,
    notify
  )
  vi.spyOn(
    p as unknown as { getPlan: () => LegacyWorkerTerminalRecoveryPlan },
    'getPlan'
  ).mockImplementation(() => plan)
  const ports = {
    preparePlan: () => p.prepare(),
    persist: async () => new Set(),
    updateRetry: () => {},
    reconcileRequestedReleases: async () => {}
  } as unknown as LegacyWorkerRecoveryPorts
  return {
    p,
    ports,
    notify,
    fences: () => session.legacyWorkerResumeFencesByPaneKey ?? {},
    clear: () => {
      plan = { blockedPanes: [], candidates: [], ambiguousDispatchIds: [] }
    },
    fail: (v: boolean) => {
      fail = v
    }
  }
}
it('round1 stale recovery result cannot reinstall a retired fence', async () => {
  const h = harness()
  let release!: (x: ReadonlySet<string>) => void
  h.ports.persist = () =>
    new Promise((r) => {
      release = r
    })
  const recovery = runLegacyWorkerTerminalRecovery({} as never, h.ports, {})
  expect(h.fences()).toEqual({ a: true })
  h.clear()
  h.p.prepare()
  release(new Set())
  const result = await recovery
  expect(result).not.toHaveProperty('blockedPaneKeys')
  expect(h.fences()).toEqual({})
  h.p.prepare()
  expect(h.fences()).toEqual({})
})
it('round1 failed staging does not publish an untracked fence', async () => {
  const h = harness()
  h.fail(true)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await runLegacyWorkerTerminalRecovery({} as never, h.ports, {})
  } finally {
    warn.mockRestore()
  }
  expect(h.fences()).toEqual({})
  expect(h.notify).not.toHaveBeenCalled()
  h.clear()
  h.fail(false)
  h.p.prepare()
  expect(h.fences()).toEqual({})
})
