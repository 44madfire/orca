import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import {
  mayRetireBindingAfterFailedReattach,
  recoverUnverifiableReattach
} from './unverifiable-reattach-recovery'

const state = vi.hoisted(() => ({
  deleteStateByWorktreeId: {} as Record<string, { isDeleting: boolean }>
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

vi.mock('../terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: vi.fn()
}))

describe('recoverUnverifiableReattach', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retries through the exact direct SSH lease when one exists', () => {
    const attempt = { attemptId: 'attempt-1' }
    const settleDirectSshPaneRetryAttempt = vi.fn()

    recoverUnverifiableReattach(
      { directSshRetryAttempt: attempt, settleDirectSshPaneRetryAttempt } as never,
      'ssh:target@@pty-1'
    )

    expect(settleDirectSshPaneRetryAttempt).toHaveBeenCalledExactlyOnceWith(attempt, 'failed')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('remounts over the preserved PTY when no retry lease exists', () => {
    recoverUnverifiableReattach(
      {
        directSshRetryAttempt: undefined,
        deps: { tabId: 'tab-1' },
        terminalRecoveryGeneration: 2,
        terminalRecoveryInstance: { id: 3 }
      } as never,
      'ssh:target@@pty-1'
    )

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith({
      tabId: 'tab-1',
      ptyId: 'ssh:target@@pty-1',
      reason: 'reattach-unverifiable',
      terminalRecoveryGeneration: 2,
      terminalRecoveryInstanceId: 3
    })
  })
})

describe('replacement eligibility after failed reattach', () => {
  it.each([
    ['ordinary local', false, false, undefined, undefined, true],
    ['fenced local', true, false, undefined, undefined, false],
    ['deleting workspace', false, true, undefined, undefined, false],
    ['direct SSH', false, false, 'ssh-1', undefined, false],
    ['paired host', false, false, undefined, 'env-1', false]
  ] as const)('%s', (_name, blocked, deleting, connectionId, runtimeEnvironmentId, expected) => {
    state.deleteStateByWorktreeId = { 'wt-1': { isDeleting: deleting } }
    expect(
      mayRetireBindingAfterFailedReattach({
        deps: { worktreeId: 'wt-1' },
        connectionId,
        runtimeEnvironmentId,
        isLegacyWorkerAutomaticResumeBlocked: () => blocked
      } as never)
    ).toBe(expected)
  })
})
