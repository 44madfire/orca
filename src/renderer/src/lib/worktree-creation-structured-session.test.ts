import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivateAndRevealResult } from './worktree-activation'

type SelectionState = {
  pendingWorktreeCreations: Record<string, unknown>
  activeView?: string
  activeRepoId?: string
  activeWorktreeId?: string
  activeWorkspaceExecutionHostId?: string
  activePendingCreationId?: string
}

const mocks = vi.hoisted(() => ({
  state: { pendingWorktreeCreations: { 'creation-1': {} } } as SelectionState,
  listener: null as ((state: SelectionState) => void) | null,
  unsubscribe: vi.fn(),
  startStructuredAgentLaunch: vi.fn(),
  cancelStructuredAgentLaunch: vi.fn(),
  closeStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
  activateStructuredAgentSessionById: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => mocks.state,
    subscribe: vi.fn((listener: (state: SelectionState) => void) => {
      mocks.listener = listener
      return mocks.unsubscribe
    })
  })
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredAgentLaunch: mocks.startStructuredAgentLaunch,
  cancelStructuredAgentLaunch: mocks.cancelStructuredAgentLaunch
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => ({ id: worktreeId })
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: mocks.ensureWorktreeHasInitialTerminal
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: vi.fn()
}))

vi.mock('@/lib/launch-structured-agent-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { pendingWorktreeCreations: { 'creation-1': {} } }
    mocks.listener = null
    mocks.closeStructuredAgentSession.mockResolvedValue('closed')
    mocks.callRuntimeRpc.mockResolvedValue(undefined)
  })

  it('cancels and retires a session when its pending creation is dismissed', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const launchResult = new Promise<{ sessionId: string; fence: number }>((resolve) => {
      resolveLaunch = resolve
    })
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult,
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    const resultPromise = launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: {
        repoId: 'repo-1',
        name: 'routing-recovery',
        setupDecision: 'run',
        agent: 'codex',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: 'Fix the route',
        quickTelemetry: null
      },
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    mocks.state = { pendingWorktreeCreations: {} }
    mocks.listener?.(mocks.state)
    resolveLaunch({ sessionId: 'session-1', fence: 1 })

    await expect(resultPromise).resolves.toEqual({
      accepted: true,
      cancelled: true,
      visibilityUnknown: false,
      activation: false,
      primaryTabId: null
    })
    expect(mocks.cancelStructuredAgentLaunch).toHaveBeenCalledWith('worktree-1', 'session-1')
    expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith({ kind: 'local' }, 'session-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
      worktree: { id: 'worktree-1' },
      tabId: 'agent-session:session-1',
      reason: 'user'
    })
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it.each([
    'unchanged',
    'already-activated',
    'background',
    'activeView',
    'activeRepoId',
    'activeWorktreeId',
    'activeWorkspaceExecutionHostId',
    'activePendingCreationId',
    'navigate-away-and-back'
  ] as const)('respects selection at successful receipt: %s', async (scenario) => {
    const launch = Promise.withResolvers<{ sessionId: string; fence: number }>()
    const activation = { primaryTabId: null } as ActivateAndRevealResult
    mocks.activateAndRevealWorktree.mockReturnValue(activation)
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: launch.promise,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
    const result = launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: {
        repoId: 'repo-1',
        name: 'routing-recovery',
        setupDecision: 'run',
        agent: 'codex',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      },
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: scenario !== 'background',
      fallbackStartupOpt: undefined,
      activation: scenario === 'already-activated' ? activation : false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    if (scenario.startsWith('active') || scenario === 'navigate-away-and-back') {
      const initialState = mocks.state
      const field = scenario === 'navigate-away-and-back' ? 'activeWorktreeId' : scenario
      mocks.state = { ...mocks.state, [field]: 'other-selection' }
      mocks.listener?.(mocks.state)
      if (scenario === 'navigate-away-and-back') {
        mocks.state = initialState
        mocks.listener?.(mocks.state)
      }
    }
    launch.resolve({ sessionId: 'session-1', fence: 1 })
    await result
    if (scenario === 'unchanged') {
      expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('worktree-1', {
        providesInitialSurface: true
      })
      expect(mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.activateStructuredAgentSessionById.mock.invocationCallOrder[0]
      )
    } else {
      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    }
    expect(mocks.activateStructuredAgentSessionById).toHaveBeenCalledTimes(
      scenario === 'unchanged' || scenario === 'already-activated' ? 1 : 0
    )
    expect(mocks.ensureWorktreeHasInitialTerminal).not.toHaveBeenCalled()
  })

  it('reports an unknown launch without claiming a visible surface', async () => {
    const releaseCallerAfterUnknownOutcome = vi.fn()
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-unknown',
      launchResult: Promise.reject(new Error('connection lost')),
      isVisibilityUnknown: () => true,
      releaseCallerAfterUnknownOutcome,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: {
          repoId: 'repo-1',
          name: 'routing-recovery',
          setupDecision: 'run',
          agent: 'codex',
          pendingFirstAgentMessageRename: false,
          note: '',
          startupPlan: null,
          quickPrompt: 'Fix the route',
          quickTelemetry: null
        },
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      accepted: true,
      cancelled: false,
      visibilityUnknown: true,
      activation: false,
      primaryTabId: null
    })

    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(releaseCallerAfterUnknownOutcome).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })
})
