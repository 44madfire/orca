import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import * as terminalProjection from './mobile-session-terminal-projection'
import { OrcaRuntimeService } from './orca-runtime'

const WORKTREE = 'repo::/workspace'
const CHAT = 'agent-session:chat'

type RuntimeInternals = {
  getAvailableAuthoritativeWindow(): unknown
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  buildHeadlessMobileSessionBrowserTabs: () => never[]
  reconcileHeadlessMobileSessionBrowserTabs: () => void
  hasServeOrSshOwnedBinding(tab: { ptyId?: string }): boolean
  hasRecentExpiredSshLeasePane(): boolean
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(
    worktreeId: string,
    options: {
      allowAttachedWindow: boolean
      onlyRuntimeOwnedTerminals?: boolean
      runtimeOwnedTerminalCandidateKnown?: boolean
      force?: boolean
    }
  ): Set<string>
}

function setup() {
  const runtime = new OrcaRuntimeService() as unknown as RuntimeInternals
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE]: ['first', 'second'].map((id, sortOrder) => ({
        id,
        worktreeId: WORKTREE,
        ptyId: `renderer-${id}`,
        title: id,
        customTitle: null,
        color: null,
        sortOrder,
        createdAt: 1
      }))
    },
    activeTabIdByWorktree: { [WORKTREE]: 'first' }
  }
  const snapshot: RuntimeMobileSessionTabsSnapshot = {
    worktree: WORKTREE,
    publicationEpoch: 'structured:restore',
    snapshotVersion: 1,
    activeGroupId: 'chat-group',
    activeTabId: CHAT,
    activeTabType: 'agent-session',
    tabGroups: [{ id: 'chat-group', activeTabId: CHAT, tabOrder: [CHAT] }],
    tabs: [
      {
        type: 'agent-session',
        id: CHAT,
        sessionId: 'chat',
        agent: 'codex',
        title: 'Chat',
        isActive: true
      }
    ]
  }
  runtime.getAvailableAuthoritativeWindow = () => ({ id: 1 })
  runtime.getWorkspaceSessionForWorktree = () => session
  runtime.buildHeadlessMobileSessionBrowserTabs = vi.fn(() => [])
  runtime.reconcileHeadlessMobileSessionBrowserTabs = vi.fn()
  runtime.hasServeOrSshOwnedBinding = (tab) => tab.ptyId?.startsWith('serve-') === true
  runtime.hasRecentExpiredSshLeasePane = () => false
  runtime.mobileSessionTabsByWorktree.set(WORKTREE, snapshot)
  const rebuild = vi.spyOn(terminalProjection, 'buildHeadlessMobileSessionTerminalTabs')
  return { runtime, session, snapshot, rebuild }
}

afterEach(() => vi.restoreAllMocks())

describe('persisted terminal hydration behind non-terminal snapshots', () => {
  it.each([false, true])('preserves the active chat and its group (browser split: %s)', (split) => {
    const { runtime, session, snapshot } = setup()
    if (split) {
      snapshot.tabs.push({
        type: 'browser',
        id: 'browser',
        browserWorkspaceId: 'page',
        browserPageId: 'browser',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        title: 'Page',
        url: 'about:blank',
        isActive: false
      })
      snapshot.tabGroups!.unshift({
        id: 'browser-group',
        activeTabId: 'browser',
        tabOrder: ['browser']
      })
      snapshot.tabGroupLayout = {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.4,
        first: { type: 'leaf', groupId: 'browser-group' },
        second: { type: 'leaf', groupId: 'chat-group' }
      }
      session.tabGroups = {
        [WORKTREE]: snapshot.tabGroups!.map((group) => ({ ...group, worktreeId: WORKTREE }))
      }
      session.tabGroupLayouts = { [WORKTREE]: snapshot.tabGroupLayout }
    }

    const reconciled = runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })
    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!

    expect(
      result.tabs.filter((tab) => tab.type === 'terminal').map((tab) => tab.parentTabId)
    ).toEqual(['first', 'second'])
    expect(result.tabs).toEqual(expect.arrayContaining(snapshot.tabs))
    expect(result.activeTabId).toBe(CHAT)
    expect(result.activeTabType).toBe('agent-session')
    expect(result.activeGroupId).toBe('chat-group')
    expect(result.tabGroups).toContainEqual({
      id: 'chat-group',
      activeTabId: CHAT,
      tabOrder: [CHAT, 'first', 'second']
    })
    expect(result.tabGroupLayout).toEqual(snapshot.tabGroupLayout)
    if (split) {
      expect(result.tabGroups).toContainEqual(snapshot.tabGroups![0])
    }
    expect(reconciled.has(WORKTREE)).toBe(false)
  })

  it('keeps the existing chat groups ahead of a stale persisted split', () => {
    const { runtime, session, snapshot } = setup()
    session.tabGroups = {
      [WORKTREE]: ['left', 'right'].map((id) => ({
        id,
        worktreeId: WORKTREE,
        activeTabId: null,
        tabOrder: []
      }))
    }
    session.tabGroupLayouts = {
      [WORKTREE]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.5,
        first: { type: 'leaf', groupId: 'left' },
        second: { type: 'leaf', groupId: 'right' }
      }
    }
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })
    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(result.tabGroups).toEqual([
      { ...snapshot.tabGroups![0], tabOrder: [CHAT, 'first', 'second'] }
    ])
    expect(result.tabGroupLayout).toBeUndefined()
  })

  it('only reconciles browsers when terminals already exist', () => {
    const { runtime, snapshot, rebuild } = setup()
    snapshot.tabs.push({
      type: 'terminal',
      id: 'existing::leaf',
      parentTabId: 'existing',
      leafId: 'leaf',
      title: 'Existing',
      isActive: false
    })

    const reconciled = runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true
    })

    expect(reconciled.has(WORKTREE)).toBe(true)
    expect(rebuild).not.toHaveBeenCalled()
    expect(runtime.buildHeadlessMobileSessionBrowserTabs).not.toHaveBeenCalled()
    expect(runtime.reconcileHeadlessMobileSessionBrowserTabs).toHaveBeenCalledWith(
      WORKTREE,
      snapshot
    )
    expect(runtime.mobileSessionTabsByWorktree.get(WORKTREE)).toBe(snapshot)
  })

  it('still merges runtime-owned terminals and filters attached renderer terminals', () => {
    const { runtime, session, snapshot, rebuild } = setup()
    session.tabsByWorktree[WORKTREE]![1]!.ptyId = 'serve-second'

    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true,
      onlyRuntimeOwnedTerminals: true,
      runtimeOwnedTerminalCandidateKnown: true
    })

    const result = runtime.mobileSessionTabsByWorktree.get(WORKTREE)!
    expect(rebuild).toHaveBeenCalledOnce()
    expect(result.tabs).toEqual([
      snapshot.tabs[0],
      expect.objectContaining({ type: 'terminal', parentTabId: 'second', ptyId: 'serve-second' })
    ])
  })

  it('still replaces existing tabs on a forced rebuild', () => {
    const { runtime } = setup()
    runtime.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(WORKTREE, {
      allowAttachedWindow: true,
      force: true
    })
    expect(runtime.mobileSessionTabsByWorktree.get(WORKTREE)!.tabs.map((tab) => tab.type)).toEqual([
      'terminal',
      'terminal'
    ])
  })
})
