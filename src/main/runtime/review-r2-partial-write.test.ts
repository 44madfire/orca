import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { RuntimeStore } from './runtime-store-contract'
import { it, expect, vi } from 'vitest'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
it('announces a successfully written host when a sibling fails and disappears before retry', () => {
  let plan: LegacyWorkerTerminalRecoveryPlan = {
    blockedPanes: [
      { paneKey: 'a', worktreeId: 'local', contractVersion: 1, settled: true },
      { paneKey: 'b', worktreeId: 'ssh:x', contractVersion: 1, settled: true }
    ],
    candidates: [],
    ambiguousDispatchIds: []
  }
  const sessions: Record<string, WorkspaceSessionState> = {
    local: getDefaultWorkspaceSession(),
    'ssh:x': getDefaultWorkspaceSession()
  }
  let fail = true
  const notify = vi.fn()
  const store = {
    getWorkspaceSessionHostIds: () => ['local', 'ssh:x'],
    getWorkspaceSession: (host: string) => sessions[host],
    setWorkspaceSession: (next: WorkspaceSessionState, host: string) => {
      if (fail && host === 'ssh:x') {
        throw new Error('host write failed')
      }
      sessions[host] = next
    }
  }
  const p = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
    () => store as unknown as RuntimeStore,
    () => null as never,
    (wt) => wt as never,
    notify
  )
  vi.spyOn(
    p as unknown as { getPlan: () => LegacyWorkerTerminalRecoveryPlan },
    'getPlan'
  ).mockImplementation(() => plan)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    p.prepare()
  } finally {
    warn.mockRestore()
  }
  expect(sessions.local.legacyWorkerResumeFencesByPaneKey).toEqual({ a: true })
  expect(notify).toHaveBeenCalledTimes(1)
  fail = false
  plan = {
    ...plan,
    blockedPanes: [{ paneKey: 'a', worktreeId: 'local', contractVersion: 1, settled: true }]
  }
  p.prepare()
  expect(notify).toHaveBeenCalled()
})
