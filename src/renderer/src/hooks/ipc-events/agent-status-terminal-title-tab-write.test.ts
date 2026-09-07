import { describe, expect, it } from 'vitest'
import type { useAppStore } from '@/store'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { resolvePaneKey, shouldApplyResolvedAgentTerminalTitleToTab } from './agent-status-routing'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

/**
 * The two title slots this path straddles: `tab.title` (what it writes) and the layout's
 * `titlesByLeafId` (what only a mounted pane updates). They diverge whenever a hook-driven write
 * lands while the pane is unmounted.
 */
function storeWithDivergedTitleSlots(args: {
  tabTitle: string
  paneSlotTitle: string
}): ReturnType<typeof useAppStore.getState> {
  const tab: TerminalTab = {
    id: TAB_ID,
    ptyId: `pty-${TAB_ID}`,
    worktreeId: WORKTREE_ID,
    title: args.tabTitle,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        titlesByLeafId: { [LEAF_ID]: args.paneSlotTitle }
      }
    },
    worktreesByRepo: {},
    repos: []
  } as unknown as ReturnType<typeof useAppStore.getState>
}

describe('hook-driven tab title writes', () => {
  it('exposes the tab record title separately from the pane slot title', () => {
    const store = storeWithDivergedTitleSlots({
      tabTitle: 'Codex - action required',
      paneSlotTitle: 'Codex ready'
    })

    const resolved = resolvePaneKey(store, PANE_KEY)

    expect(resolved.title).toBe('Codex ready')
    expect(resolved.tabTitle).toBe('Codex - action required')
  })

  // Why: Orca writes "Codex - action required" itself on a blocked/waiting hook, into `tab.title`
  // only. When `done` arrived, the no-op guard compared the resolved title against the PANE slot —
  // which still read "Codex ready" — so the write was skipped and the tab kept asserting a question
  // the agent had already finished asking, for as long as the pane stayed unmounted.
  it('rewrites a stale action-required tab title once the agent reports done', () => {
    const store = storeWithDivergedTitleSlots({
      tabTitle: 'Codex - action required',
      paneSlotTitle: 'Codex ready'
    })
    const resolved = resolvePaneKey(store, PANE_KEY)
    const nextTitle = resolveAgentStatusTerminalTitle(
      { agentType: 'codex', state: 'done' },
      resolved.title
    )

    expect(nextTitle).toBe('Codex ready')
    // Comparing against the pane slot is what skipped the write.
    expect(
      shouldApplyResolvedAgentTerminalTitleToTab(store, PANE_KEY, resolved.title, nextTitle)
    ).toBe(false)
    // The tab record is the slot this path overwrites, so it is the one that decides.
    expect(
      shouldApplyResolvedAgentTerminalTitleToTab(store, PANE_KEY, resolved.tabTitle, nextTitle)
    ).toBe(true)
  })

  it('still skips the write when the tab record already holds the resolved title', () => {
    const store = storeWithDivergedTitleSlots({
      tabTitle: 'Codex ready',
      paneSlotTitle: 'Codex ready'
    })
    const resolved = resolvePaneKey(store, PANE_KEY)

    expect(
      shouldApplyResolvedAgentTerminalTitleToTab(store, PANE_KEY, resolved.tabTitle, 'Codex ready')
    ).toBe(false)
  })
})
