import { describe, expect, it } from 'vitest'
import { shouldRetainDisposedPaneSpawn } from './disposed-spawn-retention'

const TAB = 'tab-a'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function state(overrides: {
  tabs?: Record<string, { id: string }[]>
  layouts?: Record<string, { root: unknown }>
}) {
  return {
    tabsByWorktree: (overrides.tabs ?? { wt: [{ id: TAB }] }) as never,
    terminalLayoutsByTabId: (overrides.layouts ?? {}) as never
  }
}

describe('shouldRetainDisposedPaneSpawn', () => {
  it('keeps the PTY for a tab that still exists and has no persisted layout yet', () => {
    // A brand-new single-pane tab has no layout row until its first pane binds.
    expect(shouldRetainDisposedPaneSpawn(state({}), TAB, LEAF)).toBe(true)
  })

  it('keeps the PTY when the layout still names the leaf', () => {
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ layouts: { [TAB]: { root: { type: 'leaf', leafId: LEAF } } } }),
        TAB,
        LEAF
      )
    ).toBe(true)
  })

  it('kills the PTY when the tab is gone from every worktree', () => {
    expect(
      shouldRetainDisposedPaneSpawn(state({ tabs: { wt: [{ id: 'other-tab' }] } }), TAB, LEAF)
    ).toBe(false)
  })

  it('kills the PTY when the leaf was removed from a split layout', () => {
    expect(
      shouldRetainDisposedPaneSpawn(
        state({ layouts: { [TAB]: { root: { type: 'leaf', leafId: OTHER_LEAF } } } }),
        TAB,
        LEAF
      )
    ).toBe(false)
  })

  it('finds the tab under a worktree other than the one it was opened in', () => {
    // A tab moved between worktrees mid-spawn is still a live surface.
    expect(
      shouldRetainDisposedPaneSpawn(state({ tabs: { wt: [], other: [{ id: TAB }] } }), TAB, LEAF)
    ).toBe(true)
  })
})
