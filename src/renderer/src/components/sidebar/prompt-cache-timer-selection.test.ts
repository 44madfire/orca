import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  getMostUrgentPromptCacheStartedAt,
  getPromptCacheCountdownForPane
} from './prompt-cache-timer-selection'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

describe('getMostUrgentPromptCacheStartedAt', () => {
  it('selects the oldest non-null timer for the worktree tabs in one cache pass', () => {
    const startedAt = getMostUrgentPromptCacheStartedAt([{ id: 'tab-1' }, { id: 'tab-2' }], {
      'tab-1:pane-a': 300,
      'tab-1:pane-b': null,
      'tab-2:seed': 200,
      'tab-3:pane-a': 100
    })

    expect(startedAt).toBe(200)
  })

  it('does not match tab id prefixes or malformed keys', () => {
    const startedAt = getMostUrgentPromptCacheStartedAt([{ id: 'tab-1' }], {
      'tab-10:pane-a': 100,
      'tab-1': 50,
      'tab-1:pane-a': 300
    })

    expect(startedAt).toBe(300)
  })

  it('shares one timer inventory pass across visible cards and unrelated store writes', () => {
    const cards = Array.from({ length: 423 }, (_, index) =>
      Array.from({ length: 3 }, (_, tab) => ({ id: `tab-${index * 3 + tab}` }))
    )
    const inventory = Object.fromEntries(
      cards.flatMap((tabs) => tabs.map((tab) => [`${tab.id}:seed`, 100]))
    )
    const enumerate = vi.fn(Reflect.ownKeys)
    const timers = new Proxy<Record<string, number | null>>(inventory, { ownKeys: enumerate })
    let total = 0
    for (let write = 0; write < 100; write++) {
      for (const tabs of cards.slice(0, 20)) {
        total += getMostUrgentPromptCacheStartedAt(tabs, timers) ?? 0
      }
    }

    expect(total).toBe(200_000)
    expect(enumerate).toHaveBeenCalledTimes(1)
  })

  it('updates minima on timer replacement and tab membership changes', () => {
    const tabs = [{ id: 'tab-1' }]
    const original = { 'tab-1:seed': 300, 'tab-1:pane-a': 200, 'tab-2:pane-a': 100 }
    expect(getMostUrgentPromptCacheStartedAt(tabs, original)).toBe(200)
    expect(getMostUrgentPromptCacheStartedAt([{ id: 'tab-2' }], original)).toBe(100)

    const cleared = { ...original, 'tab-1:pane-a': null }
    expect(getMostUrgentPromptCacheStartedAt(tabs, cleared)).toBe(300)
    const replaced = { ...cleared, 'tab-1:pane-b': 0 }
    expect(getMostUrgentPromptCacheStartedAt(tabs, replaced)).toBe(0)
    const removed = { 'tab-2:pane-a': 100 }
    expect(getMostUrgentPromptCacheStartedAt(tabs, removed)).toBeNull()

    expect(getMostUrgentPromptCacheStartedAt(tabs, original)).toBe(200)
    expect(getMostUrgentPromptCacheStartedAt([], original)).toBeNull()
    expect(getMostUrgentPromptCacheStartedAt(undefined, original)).toBeNull()
  })
})

describe('getPromptCacheCountdownForPane', () => {
  it('selects the exact pane timer with the ttl used for gating', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)
    const otherPaneKey = makePaneKey('tab-1', LEAF_B)

    expect(
      getPromptCacheCountdownForPane(
        paneKey,
        {
          [paneKey]: 300,
          [otherPaneKey]: 100
        },
        5000
      )
    ).toEqual({ startedAt: 300, ttlMs: 5000 })
  })

  it('does not fall back to seed timers for per-pane row ownership', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)

    expect(getPromptCacheCountdownForPane(paneKey, { 'tab-1:seed': 300 }, 5000)).toBeNull()
  })

  it('rejects malformed pane keys and null timer values', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)

    expect(getPromptCacheCountdownForPane('tab-1:1', { 'tab-1:1': 300 }, 5000)).toBeNull()
    expect(getPromptCacheCountdownForPane(paneKey, { [paneKey]: null }, 5000)).toBeNull()
  })

  it('requires a positive ttl', () => {
    const paneKey = makePaneKey('tab-1', LEAF_A)

    expect(getPromptCacheCountdownForPane(paneKey, { [paneKey]: 300 }, 0)).toBeNull()
  })
})
