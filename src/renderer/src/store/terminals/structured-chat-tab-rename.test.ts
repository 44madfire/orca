import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { createTestStore, makeWorktree, seedStore } from '../slices/store-test-helpers'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

const WORKTREE = 'local-repo::/tmp/app'
const STRUCTURED_TAB_ID = 'structured-agent-session-codex-1'

function structuredTab(): Tab {
  return {
    id: STRUCTURED_TAB_ID,
    entityId: 'codex-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function storeWithStructuredTab(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    repos: [{ id: 'local-repo', path: '/tmp/app', name: 'app' }] as never,
    worktreesByRepo: {
      'local-repo': [makeWorktree({ id: WORKTREE, repoId: 'local-repo', path: '/tmp/app' })]
    },
    unifiedTabsByWorktree: { [WORKTREE]: [structuredTab()] }
  })
  return store
}

function labelOf(store: ReturnType<typeof createTestStore>): string | null | undefined {
  return store
    .getState()
    .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.id === STRUCTURED_TAB_ID)?.customLabel
}

describe('renaming a structured chat tab', () => {
  it('writes the custom label onto the agent-session tab', () => {
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Flaky retry test')
    expect(labelOf(store)).toBe('Flaky retry test')
  })

  it('clears the custom label when the rename is emptied', () => {
    const store = storeWithStructuredTab()
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, 'Flaky retry test')
    // Guard: without the intermediate assertion this case passes on a rename
    // that never wrote anything, since the label starts out null too.
    expect(labelOf(store)).toBe('Flaky retry test')
    store.getState().setTabCustomTitle(STRUCTURED_TAB_ID, null)
    expect(labelOf(store)).toBeNull()
  })
})
