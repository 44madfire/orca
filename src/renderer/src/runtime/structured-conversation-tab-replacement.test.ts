// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { buildMirroredAgentTabs } from './web-session-tabs-sync/terminal-surfaces'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState,
  WT,
  ENV,
  NOW
} from './web-session-tabs-sync-test-harness'

beforeEach(resetWebSessionTabsSyncTestState)

describe('clear pane identity', () => {
  it.each(['agent-session', 'terminal'] as const)(
    'replaces a %s pane in its existing local position',
    (contentType) => {
      const state = makeState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'local-pane',
              entityId: contentType === 'terminal' ? 'local-pane' : 'old-session',
              contentType,
              structuredSessionId: contentType === 'terminal' ? 'old-session' : undefined,
              agentSessionAgent: 'codex',
              worktreeId: WT,
              groupId: 'local-group',
              label: 'Old',
              customLabel: null,
              color: null,
              createdAt: 1,
              sortOrder: 0,
              isPinned: true
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'local-group',
              worktreeId: WT,
              tabOrder: ['local-pane'],
              activeTabId: 'local-pane'
            }
          ]
        },
        activeGroupIdByWorktree: { [WT]: 'local-group' },
        activeTabId: 'local-pane',
        activeTabIdByWorktree: { [WT]: 'local-pane' },
        ...(contentType === 'terminal'
          ? {
              tabsByWorktree: {
                [WT]: [
                  {
                    id: 'local-pane',
                    worktreeId: WT,
                    ptyId: null,
                    title: 'Old',
                    customTitle: null,
                    color: null,
                    sortOrder: 0,
                    createdAt: 1
                  }
                ]
              }
            }
          : {})
      })
      const snapshot = makeSnapshot(
        [
          {
            type: 'agent-session',
            id: 'agent-session:new-session',
            sessionId: 'new-session',
            replacesSessionId: 'old-session',
            agent: 'codex',
            title: 'Codex Chat',
            isActive: true
          }
        ],
        { activeTabId: 'agent-session:new-session', activeTabType: 'agent-session' }
      )
      const next = applyWebSessionTabsSnapshot(state, snapshot, ENV, NOW, {
        contentScope: 'agent-session',
        preserveLocalLayout: true,
        terminalPtyMode: 'local'
      })
      expect(next.unifiedTabsByWorktree?.[WT]).toHaveLength(1)
      expect(next.unifiedTabsByWorktree?.[WT]?.[0]).toMatchObject({
        id: 'local-pane',
        entityId: 'new-session',
        contentType: 'agent-session',
        groupId: 'local-group',
        isPinned: true
      })
      expect(next.groupsByWorktree?.[WT]?.[0]).toMatchObject({
        tabOrder: ['local-pane'],
        activeTabId: 'local-pane'
      })
      expect(next.tabsByWorktree?.[WT] ?? []).toEqual([])
    }
  )
  it('gives reopened history its own tab when clear retained its former local ID', () => {
    const current = [
      {
        id: 'structured-agent-session-old-session',
        entityId: 'new-session',
        contentType: 'agent-session' as const,
        worktreeId: WT,
        groupId: 'g',
        label: 'Codex Chat',
        customLabel: null,
        color: null,
        createdAt: 1,
        sortOrder: 0
      }
    ]
    const snapshot = makeSnapshot([
      {
        type: 'agent-session',
        id: 'new-tab',
        sessionId: 'new-session',
        replacesSessionId: 'old-session',
        agent: 'codex',
        title: 'New',
        isActive: false
      },
      {
        type: 'agent-session',
        id: 'old-tab',
        sessionId: 'old-session',
        agent: 'codex',
        title: 'Old',
        isActive: true
      }
    ])
    const tabs = buildMirroredAgentTabs(snapshot, new Map(), 'g', 0, current, NOW)
    expect(new Set(tabs.map((tab) => tab.unifiedTab.id)).size).toBe(2)
    expect(tabs[0]!.unifiedTab.id).toBe(current[0]!.id)
    expect(tabs[1]!.unifiedTab.entityId).toBe('old-session')
  })
})
