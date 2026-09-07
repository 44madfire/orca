import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent-test-state'
import { registerWorktreeActivationReset } from './worktree-activation-test-harness'
import { getCreationProgressLabel, type WorktreeCreationRequest } from './pending-worktree-creation'

vi.mock('./worktree-creation-structured-session', () => ({
  launchStructuredWorktreeSession: vi.fn(async (args) => ({
    accepted: true,
    cancelled: false,
    visibilityUnknown: false,
    activation: args.activation,
    primaryTabId: args.primaryTabId
  }))
}))
vi.mock('./worktree-creation-completion', () => ({ completeWorktreeCreation: vi.fn() }))

const initialState = useAppStore.getState()
registerWorktreeActivationReset()
afterEach(() => {
  vi.restoreAllMocks()
  useAppStore.setState(initialState, true)
})

describe.each(['terminal', 'tasks'] as const)('native chat creation from %s', (activeView) => {
  it.each(['claude', 'codex'] as const)(
    'runs new-tab setup once without an idle shell or premature focus change for %s',
    async (agent) => {
      vi.clearAllMocks()
      const worktree = makeCreatedAgentWorktree()
      seedEmptyActivatableWorktree(worktree)
      const request: WorktreeCreationRequest = {
        repoId: worktree.repoId,
        name: 'feature',
        setupDecision: 'run',
        agent,
        agentLaunchRoute: 'structured-native-chat',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: '',
        quickTelemetry: null
      }
      const setup = { runnerScriptPath: '/tmp/setup-runner.sh', envVars: {} }
      useAppStore.setState({
        activeView,
        activePendingCreationId: 'creation-1',
        activeWorktreeId: 'previous-worktree',
        activeTabId: 'previous-tab',
        createWorktree: vi.fn().mockResolvedValue({ worktree, setup }),
        pendingWorktreeCreations: {
          'creation-1': {
            creationId: 'creation-1',
            phase: 'fetching',
            status: 'creating',
            startedAt: 1,
            indeterminate: false,
            loaderVisible: true,
            request
          }
        }
      })

      const launch =
        Promise.withResolvers<Awaited<ReturnType<typeof launchStructuredWorktreeSession>>>()
      vi.mocked(launchStructuredWorktreeSession).mockReturnValueOnce(launch.promise)
      const creation = executeWorktreeCreation('creation-1', request)
      await vi.waitFor(() => expect(launchStructuredWorktreeSession).toHaveBeenCalled())

      const state = useAppStore.getState()
      const tabs = state.tabsByWorktree[worktree.id]
      expect(tabs).toHaveLength(1)
      expect(tabs[0].customTitle).toBe('Setup')
      expect(state.pendingStartupByTabId[tabs[0].id]).toMatchObject({
        command: 'bash /tmp/setup-runner.sh'
      })
      expect(state.settings?.setupScriptLaunchMode).toBe('new-tab')
      expect(state.activeView).toBe(activeView)
      expect(state.activePendingCreationId).toBe('creation-1')
      expect(getCreationProgressLabel(state.pendingWorktreeCreations['creation-1'])).toBe(
        `Starting ${agent === 'claude' ? 'Claude' : 'Codex'} chat…`
      )
      expect(state.activeWorktreeId).toBe('previous-worktree')
      expect(state.activeTabId).toBe('previous-tab')
      expect(launchStructuredWorktreeSession).toHaveBeenCalledWith(
        expect.objectContaining({
          primaryTabId: null,
          shouldActivateOnCompletion: activeView === 'terminal'
        })
      )
      launch.resolve({
        accepted: true,
        cancelled: false,
        visibilityUnknown: false,
        activation: false,
        primaryTabId: null
      })
      await creation
      expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
    }
  )
})
