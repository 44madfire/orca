import { describe, expect, it } from 'vitest'
import {
  movePaneKeyedRecord,
  removePaneKeys,
  removePaneKeysByTabPrefix
} from '@/store/slices/agent-status-pane-keyed-records'
import { buildOrphanTerminalCleanupPatch } from '@/store/slices/terminal-orphan-helpers'
import { createTestStore, makeTab, seedStore } from '@/store/slices/store-test-helpers'
import { getMostUrgentPromptCacheStartedAt } from './prompt-cache-timer-selection'

// The countdown index is keyed by the cacheTimerByKey record identity, so every
// producer must publish a fresh record; a mutating writer would show a stale timer.
const WORKTREE = 'repo1::/repo1'
const CARD_TABS = [{ id: 'tab-a' }, { id: 'tab-b' }]

function storeWithIdleClaudeTab(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    tabsByWorktree: {
      [WORKTREE]: [makeTab({ id: 'tab-a', worktreeId: WORKTREE, title: '✳ Claude Code' })]
    }
  })
  return store
}

function urgentStartedAt(store: ReturnType<typeof createTestStore>): number | null {
  return getMostUrgentPromptCacheStartedAt(CARD_TABS, store.getState().cacheTimerByKey)
}

describe('prompt cache countdown index invalidation', () => {
  it('follows every setCacheTimerStartedAt write', () => {
    const store = storeWithIdleClaudeTab()
    expect(urgentStartedAt(store)).toBeNull()

    store.getState().setCacheTimerStartedAt('tab-a:pane-1', 1_000)
    expect(urgentStartedAt(store)).toBe(1_000)

    store.getState().setCacheTimerStartedAt('tab-a:pane-1', 400)
    expect(urgentStartedAt(store)).toBe(400)

    store.getState().setCacheTimerStartedAt('tab-b:pane-1', 900)
    expect(urgentStartedAt(store)).toBe(400)

    store.getState().setCacheTimerStartedAt('tab-a:pane-1', null)
    expect(urgentStartedAt(store)).toBe(900)
  })

  it('follows seeded timers and the real pane write that clears the seed', () => {
    const store = storeWithIdleClaudeTab()
    store.getState().seedCacheTimersForIdleTabs()
    expect(store.getState().cacheTimerByKey['tab-a:seed']).toEqual(expect.any(Number))
    expect(urgentStartedAt(store)).toBe(store.getState().cacheTimerByKey['tab-a:seed'])

    store.getState().setCacheTimerStartedAt('tab-a:pane-1', 5)
    expect(store.getState().cacheTimerByKey['tab-a:seed']).toBeUndefined()
    expect(urgentStartedAt(store)).toBe(5)
  })

  it('follows pane retire, pane move, and tab-close cleanup', () => {
    const record: Record<string, number | null> = {
      'tab-a:pane-1': 100,
      'tab-b:pane-1': 200
    }
    expect(getMostUrgentPromptCacheStartedAt(CARD_TABS, record)).toBe(100)

    const retired = removePaneKeys(record, new Set(['tab-a:pane-1']))
    expect(getMostUrgentPromptCacheStartedAt(CARD_TABS, retired)).toBe(200)

    const closed = removePaneKeysByTabPrefix(record, 'tab-a')
    expect(getMostUrgentPromptCacheStartedAt(CARD_TABS, closed)).toBe(200)

    const moved = movePaneKeyedRecord(record, 'tab-a:pane-1', 'tab-c:pane-1')
    expect(getMostUrgentPromptCacheStartedAt(CARD_TABS, moved)).toBe(200)
    expect(getMostUrgentPromptCacheStartedAt([{ id: 'tab-c' }], moved)).toBe(100)

    // No-op writes keep the identity, which is what lets the index be shared.
    expect(removePaneKeys(record, new Set(['tab-z:pane-1']))).toBe(record)
    expect(movePaneKeyedRecord(record, 'tab-z:pane-1', 'tab-y:pane-1')).toBe(record)
  })

  it('follows the orphan-terminal sweep', () => {
    const store = storeWithIdleClaudeTab()
    store.getState().setCacheTimerStartedAt('tab-a:pane-1', 42)
    expect(urgentStartedAt(store)).toBe(42)

    const patch = buildOrphanTerminalCleanupPatch(store.getState(), WORKTREE, new Set(['tab-a']))
    expect(getMostUrgentPromptCacheStartedAt(CARD_TABS, patch.cacheTimerByKey)).toBeNull()
  })
})
