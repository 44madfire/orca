import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  settleStructuredAgentLaunch: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  activateStructuredAgentSessionById: vi.fn()
}))

vi.mock('@/lib/structured-agent-launch-settlement', () => ({
  settleStructuredAgentLaunch: mocks.settleStructuredAgentLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

import { settleFullCreationStructuredLaunch } from './full-creation-structured-launch'

const baseArgs = {
  structuredLaunch: true,
  agent: 'codex' as const,
  worktreeId: 'worktree-1',
  prompt: 'Fix the route',
  startup: { command: 'codex' } as never,
  pendingFirstAgentMessageRename: true,
  applyWorktreeMeta: vi.fn().mockResolvedValue(undefined)
}

describe('settleFullCreationStructuredLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips the loop when the route is not structured', async () => {
    await expect(
      settleFullCreationStructuredLaunch({ ...baseArgs, structuredLaunch: false })
    ).resolves.toBeNull()
    expect(mocks.settleStructuredAgentLaunch).not.toHaveBeenCalled()
  })

  it('hands the loop the prompt and activates the structured tab when ready', async () => {
    mocks.settleStructuredAgentLaunch.mockImplementation(
      async (_worktreeId, _agent, _options, hooks) => {
        hooks.onStructuredReady('session-1')
        return { kind: 'structured', sessionId: 'session-1' }
      }
    )

    await expect(
      settleFullCreationStructuredLaunch({ ...baseArgs, promptDelivery: 'draft' })
    ).resolves.toEqual({ kind: 'structured', sessionId: 'session-1' })
    expect(mocks.settleStructuredAgentLaunch).toHaveBeenCalledWith(
      'worktree-1',
      'codex',
      { prompt: 'Fix the route', promptDelivery: 'draft' },
      expect.anything()
    )
    expect(mocks.activateStructuredAgentSessionById).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      sessionId: 'session-1'
    })
  })

  it('marks the rename flag and opens the startup terminal as the legacy fallback', async () => {
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'fallback-tab' })
    mocks.settleStructuredAgentLaunch.mockImplementation(
      async (_worktreeId, _agent, _options, hooks) => ({
        kind: 'refused-then-legacy',
        ...(await hooks.legacyFallback())
      })
    )

    await expect(settleFullCreationStructuredLaunch(baseArgs)).resolves.toEqual({
      kind: 'refused-then-legacy',
      activation: { primaryTabId: 'fallback-tab' },
      primaryTabId: 'fallback-tab'
    })
    expect(baseArgs.applyWorktreeMeta).toHaveBeenCalledWith('worktree-1', {
      pendingFirstAgentMessageRename: true
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      sidebarRevealBehavior: 'auto',
      createNewTerminalForStartup: true,
      startup: baseArgs.startup
    })
  })
})
