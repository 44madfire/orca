import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import {
  resetAgentHibernationCoordinatorForTests,
  startAgentHibernationCoordinator
} from './agent-hibernation-coordinator'
import { hydrateDrivers } from './pane-manager/mobile-driver-state'
import { resetForegroundTerminalTabIdsForTests } from './foreground-terminal-tabs'
import { resetAgentHibernationOutputActivityForTests } from './agent-hibernation-output-activity'
import {
  observeHibernationPtyBindings,
  resetHibernationPaneAgeForTests
} from './agent-hibernation-pane-age'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import type { AppState } from '@/store/types'

const NOW = 10_000_000
const LEAVES = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
  '55555555-5555-4555-8555-555555555555'
]
const LEAF = LEAVES[0]!
const SSH_TARGET_ID = 'box-1'
const SSH_HOST_ID = `ssh:${SSH_TARGET_ID}` as const
const ptyIdFor = (leafIndex: number): string => `ssh:${SSH_TARGET_ID}@@pty-${leafIndex + 1}`

const mockRuntimeCall = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()

vi.stubGlobal('window', {
  api: {
    runtime: { call: mockRuntimeCall },
    runtimeEnvironments: { call: mockRuntimeEnvironmentCall }
  }
})

function tab(worktreeId: string): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(leafCount: number): TerminalLayoutSnapshot {
  const leafIds = LEAVES.slice(0, leafCount)
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: Object.fromEntries(leafIds.map((leafId, i) => [leafId, ptyIdFor(i)]))
  }
}

function entry(leafId: string, worktreeId: string, index: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1,
    stateStartedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1,
    paneKey: `tab-1:${leafId}`,
    tabId: 'tab-1',
    worktreeId,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: `session-${index + 1}` },
    stateHistory: []
  }
}

type SshStateOptions = {
  leafCount?: number
  worktreeId?: string
  folderWorkspace?: boolean
  overrides?: Partial<AppState>
}

function installEligibleSshState(
  shutdown = vi.fn().mockResolvedValue(undefined),
  {
    leafCount = 1,
    worktreeId = 'wt-bg',
    folderWorkspace = false,
    overrides = {}
  }: SshStateOptions = {}
): typeof shutdown {
  const entries = LEAVES.slice(0, leafCount).map((leafId, i) => entry(leafId, worktreeId, i))
  useAppStore.setState({
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    } as never,
    activeWorktreeId: 'wt-active',
    repos: [],
    worktreesByRepo: folderWorkspace
      ? ({} as never)
      : ({
          'fixture-repo': [{ id: worktreeId, repoId: 'fixture-repo', hostId: SSH_HOST_ID }]
        } as never),
    folderWorkspaces: folderWorkspace
      ? ([{ id: 'folder-1', connectionId: SSH_TARGET_ID }] as never)
      : ([] as never),
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [worktreeId]: [tab(worktreeId)] },
    terminalLayoutsByTabId: { 'tab-1': layout(leafCount) },
    ptyIdsByTabId: { 'tab-1': LEAVES.slice(0, leafCount).map((_, i) => ptyIdFor(i)) },
    agentStatusByPaneKey: Object.fromEntries(entries.map((e) => [e.paneKey, e])) as never,
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    shutdownCompletedAgentPaneForHibernation: shutdown as never,
    shutdownWorktreeTerminals: vi.fn() as never,
    ...overrides
  })
  // Why: a pane idle long enough to hibernate has been observed by earlier passes, so seed an
  // old PTY binding — otherwise the binding-age floor defers every candidate on its first tick.
  const state = useAppStore.getState()
  observeHibernationPtyBindings({
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    now: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 60_000,
    idleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
  })
  return shutdown
}

function sshListResult(
  ptyIds: string[],
  worktreeId = 'wt-bg',
  opts: { truncated?: boolean; hostIds?: string[]; omittedHostIds?: string[] } = {}
) {
  return {
    terminals: ptyIds.map((ptyId) => ({
      handle: `handle-${ptyId}`,
      ptyId,
      worktreeId,
      worktreePath: '/tmp/wt-bg',
      branch: 'feature',
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      title: 'Agent',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    })),
    totalCount: ptyIds.length,
    truncated: opts.truncated ?? false,
    hostScope: {
      hostIds: opts.hostIds ?? [SSH_HOST_ID],
      omittedHostIds: opts.omittedHostIds ?? ['local']
    }
  }
}

/** Queue of `terminal.list` answers on the client's own runtime; the last one repeats. */
function installLocalListResponses(
  ...responses: (ReturnType<typeof sshListResult> | Error | 'never-resolves')[]
): void {
  const queue = [...responses]
  mockRuntimeCall.mockImplementation((args: { method: string }) => {
    if (args.method !== 'terminal.list') {
      return Promise.resolve({ id: 'default', ok: true, result: {} })
    }
    const response = queue.length > 1 ? queue.shift()! : (queue[0] ?? new Error('no answer'))
    if (response === 'never-resolves') {
      return new Promise(() => {})
    }
    if (response instanceof Error) {
      return Promise.reject(response)
    }
    return Promise.resolve({ id: 'terminal-list', ok: true, result: response })
  })
}

function terminalListCallCount(): number {
  return mockRuntimeCall.mock.calls.filter(([args]) => args?.method === 'terminal.list').length
}

afterEach(() => {
  resetAgentHibernationCoordinatorForTests()
  clearRuntimeCompatibilityCacheForTests()
  resetForegroundTerminalTabIdsForTests()
  resetAgentHibernationOutputActivityForTests()
  resetHibernationPaneAgeForTests()
  hydrateDrivers([])
  mockRuntimeCall.mockReset()
  mockRuntimeEnvironmentCall.mockReset()
  vi.useRealTimers()
})

// Live validation on a Linux SSH target observed 0 `terminal.list` calls and 5 hibernation
// shutdowns for a workspace with `hostId: 'ssh:…'`: the fresh-evidence requirement covered
// paired runtimes only, so an SSH workspace hibernated on client bookkeeping alone.
describe('ssh-hosted hibernation requires execution-host evidence', () => {
  it('asks the execution host and hibernates nothing when the relay rejects every tick', async () => {
    vi.useFakeTimers()
    installLocalListResponses(new Error('relay unavailable'))
    const shutdown = installEligibleSshState(vi.fn().mockResolvedValue(undefined), { leafCount: 5 })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
    expect(terminalListCallCount()).toBeGreaterThan(0)
  })

  it('hibernates nothing while the host listing never resolves', async () => {
    vi.useFakeTimers()
    installLocalListResponses('never-resolves')
    const shutdown = installEligibleSshState(vi.fn().mockResolvedValue(undefined), { leafCount: 5 })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(10_000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('hibernates nothing across an alternating good/failed host answer flap', async () => {
    vi.useFakeTimers()
    installLocalListResponses(
      sshListResult([ptyIdFor(0)]),
      new Error('relay unavailable'),
      sshListResult([ptyIdFor(0)]),
      new Error('relay unavailable')
    )
    const shutdown = installEligibleSshState()
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(4000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('fails closed on a truncated host listing', async () => {
    vi.useFakeTimers()
    installLocalListResponses(sshListResult([ptyIdFor(0)], 'wt-bg', { truncated: true }))
    const shutdown = installEligibleSshState()
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(4000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('fails closed when the listing did not cover the workspace SSH host', async () => {
    vi.useFakeTimers()
    // The client's own runtime answered for its local PTYs; the relay to the box never did.
    // An empty answer from a host that was not asked is not evidence the PTY exited.
    installLocalListResponses(
      sshListResult([], 'wt-bg', { hostIds: ['local'], omittedHostIds: [SSH_HOST_ID] })
    )
    const shutdown = installEligibleSshState()
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(4000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('fails closed when the host is too old to publish a listing scope', async () => {
    vi.useFakeTimers()
    const { hostScope: _hostScope, ...withoutScope } = sshListResult([ptyIdFor(0)])
    installLocalListResponses(withoutScope as ReturnType<typeof sshListResult>)
    const shutdown = installEligibleSshState()
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(4000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('requires host evidence for an SSH folder workspace too', async () => {
    vi.useFakeTimers()
    installLocalListResponses(new Error('relay unavailable'))
    const worktreeId = folderWorkspaceKey('folder-1')
    const shutdown = installEligibleSshState(vi.fn().mockResolvedValue(undefined), {
      worktreeId,
      folderWorkspace: true
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(4000)

    expect(shutdown).not.toHaveBeenCalled()
    expect(terminalListCallCount()).toBeGreaterThan(0)
  })

  it('does not widen eligibility to a PTY the client never bound to this tab', async () => {
    vi.useFakeTimers()
    installLocalListResponses(sshListResult([ptyIdFor(0)]))
    const shutdown = installEligibleSshState(vi.fn().mockResolvedValue(undefined), {
      overrides: { ptyIdsByTabId: { 'tab-1': [] } }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(4000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('still hibernates when the reachable SSH host reports the pane PTY live', async () => {
    vi.useFakeTimers()
    installLocalListResponses(sshListResult([ptyIdFor(0)]))
    const shutdown = installEligibleSshState()
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: ptyIdFor(0)
    })
    expect(mockRuntimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ requireFreshPtyLiveness: true })
      })
    )
  })

  it('stops hibernating a pane the host stopped reporting between ticks', async () => {
    vi.useFakeTimers()
    installLocalListResponses(
      sshListResult([ptyIdFor(0)]),
      sshListResult([ptyIdFor(0)]),
      sshListResult(['ssh:box-1@@pty-other'])
    )
    const shutdown = installEligibleSshState()
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(2000)

    expect(shutdown).not.toHaveBeenCalled()
  })
})
