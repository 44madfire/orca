// @vitest-environment happy-dom

import { createElement, StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchCoverageStore } from './ai-vault-search-coverage-store'
import type {
  AiVaultSearchCoverage,
  AiVaultSearchIndexingProgress
} from '../../../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_COVERAGE_POLL_MS,
  useAiVaultSearchCoveragePoll
} from './ai-vault-search-coverage-poll'

function coverage(
  backfill: AiVaultSearchCoverage['backfill'],
  indexing?: Partial<AiVaultSearchIndexingProgress>
): AiVaultSearchCoverage {
  return {
    enabled: true,
    sessionsIndexed: 5,
    messagesIndexed: 20,
    providers: [],
    backfill,
    filesPending: 0,
    lastIndexedAt: null,
    ...(indexing
      ? {
          indexing: {
            phase: 'indexing',
            filesProcessed: 1,
            filesTotal: 10,
            failures: 0,
            startedAt: 0,
            ...indexing
          }
        }
      : {})
  }
}

let searchCoverage: ReturnType<typeof vi.fn>
let focusListeners: (() => void)[]

beforeEach(() => {
  vi.useFakeTimers()
  focusListeners = []
  searchCoverage = vi.fn().mockResolvedValue(coverage('running', { phase: 'indexing' }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        searchCoverage,
        onWindowFocused: (callback: () => void) => {
          focusListeners.push(callback)
          return () => {
            focusListeners = focusListeners.filter((listener) => listener !== callback)
          }
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element =>
  createElement(StrictMode, null, children)

describe('useAiVaultSearchCoveragePoll', () => {
  it('asks for nothing while transcript search is off', () => {
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(false, null, 'off'), {
      wrapper
    })
    expect(searchCoverage).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('keeps polling while the backfill is still running', async () => {
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'running-owner'), { wrapper })
    await act(async () => {})

    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFirstRead)
  })

  it('stops polling once the index reports it is up to date', async () => {
    searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
    const { result } = renderHook(
      () => useAiVaultSearchCoveragePoll(true, null, 'complete-owner'),
      {
        wrapper
      }
    )
    await act(async () => {})

    expect(result.current?.sessionsIndexed).toBe(5)
    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 5)
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead)
  })

  it('stops polling a host that reports no indexing progress at all', async () => {
    searchCoverage.mockResolvedValue(coverage('complete'))
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'legacy-owner'), { wrapper })
    await act(async () => {})

    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 5)
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead)
  })

  it('re-reads a settled index when the window is focused again', async () => {
    searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'focus-owner'), { wrapper })
    await act(async () => {})
    const callsAfterFirstRead = searchCoverage.mock.calls.length

    await act(async () => {
      focusListeners.forEach((listener) => listener())
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead + 1)
  })

  it('resumes polling when a focus read finds the index working again', async () => {
    searchCoverage.mockResolvedValue(coverage('complete', { phase: 'complete' }))
    renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'refocus-owner'), { wrapper })
    await act(async () => {})

    searchCoverage.mockResolvedValue(coverage('running', { phase: 'indexing' }))
    await act(async () => {
      focusListeners.forEach((listener) => listener())
    })
    const callsAfterFocus = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFocus)
  })

  it('publishes consistently slow successes without overlapping polls', async () => {
    searchCoverage.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(coverage('running', { phase: 'indexing' })), 5_000)
        )
    )
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'slow-owner'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(result.current?.backfill).toBe('running')
    expect(searchCoverage).toHaveBeenCalledTimes(3)
  })

  it('drops the last reading when search is turned off', async () => {
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useAiVaultSearchCoveragePoll(enabled, null, 'toggle-owner'),
      { initialProps: { enabled: true }, wrapper }
    )
    await act(async () => {})
    expect(result.current).not.toBeNull()

    rerender({ enabled: false })
    expect(result.current).toBeNull()
  })

  it('publishes the coverage a search already returned instead of re-reading it', async () => {
    const fromSearch = coverage('running', { phase: 'indexing', filesProcessed: 7 })
    const { rerender, result } = renderHook(
      ({ latest }: { latest: AiVaultSearchCoverage | null }) =>
        useAiVaultSearchCoveragePoll(true, latest, 'observe-owner'),
      { wrapper, initialProps: { latest: null as AiVaultSearchCoverage | null } }
    )
    await act(async () => {})
    const callsAfterMount = searchCoverage.mock.calls.length

    await act(async () => {
      rerender({ latest: fromSearch })
    })
    // A result arriving must publish what it carried, not spend a round trip re-asking for it.
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterMount)
    expect(result.current?.indexing?.filesProcessed).toBe(7)
  })
})

it('drops coverage from the previous runtime immediately and polls the new owner', async () => {
  const { result, rerender } = renderHook(
    ({ host }) => useAiVaultSearchCoveragePoll(true, null, host),
    { initialProps: { host: 'runtime:a' }, wrapper }
  )
  await act(async () => {})
  expect(result.current?.sessionsIndexed).toBe(5)
  let release!: (value: AiVaultSearchCoverage) => void
  searchCoverage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  rerender({ host: 'runtime:b' })
  expect(result.current).toBeNull()
  await act(async () => {
    release({ ...coverage('complete'), sessionsIndexed: 9 })
  })
  expect(result.current?.sessionsIndexed).toBe(9)
})

it('shares a single polling subscription between surfaces', async () => {
  const first = renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'shared-owner'))
  const second = renderHook(() => useAiVaultSearchCoveragePoll(true, null, 'shared-owner'))
  await act(async () => {})
  expect(searchCoverage).toHaveBeenCalledTimes(1)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  })
  expect(searchCoverage).toHaveBeenCalledTimes(2)
  first.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  })
  expect(searchCoverage).toHaveBeenCalledTimes(3)
  second.unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
  })
  expect(searchCoverage).toHaveBeenCalledTimes(3)
})

it('observes controls after mutation and ignores the outstanding older poll', async () => {
  let releaseOld!: (value: AiVaultSearchCoverage) => void
  let finishAction!: () => void
  searchCoverage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseOld = resolve
      })
  )
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  const controlled = store.control(
    () =>
      new Promise<void>((resolve) => {
        finishAction = resolve
      })
  )
  await vi.advanceTimersByTimeAsync(8_000)
  expect(searchCoverage).toHaveBeenCalledTimes(1)
  finishAction()
  await controlled
  expect(store.getSnapshot().coverage?.backfill).toBe('running')
  releaseOld(coverage('complete'))
  await Promise.resolve()
  expect(store.getSnapshot().coverage?.backfill).toBe('running')
  unsubscribe()
})

it('still reports busy when the last surface unsubscribes mid-control', async () => {
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  let finishAction!: () => void
  const controlled = store.control(
    () =>
      new Promise<void>((resolve) => {
        finishAction = resolve
      })
  )
  unsubscribe()

  // Why: a snapshot that forgot the running action would let a second surface start a rival one.
  expect(store.getSnapshot().busy).toBe(true)
  const rival = vi.fn().mockResolvedValue(undefined)
  await store.control(rival)
  expect(rival).not.toHaveBeenCalled()

  finishAction()
  await controlled
  expect(store.getSnapshot().busy).toBe(false)
})

it('keeps the last good reading when the only surface unmounts', async () => {
  const store = createSearchCoverageStore()
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(store.getSnapshot().coverage).not.toBeNull()
  unsubscribe()
  // Why: resetting here made the settings panel flash "Reading index status…" on a remount.
  expect(store.getSnapshot().coverage).not.toBeNull()
})

it('ages one indexing run from the renderer clock, not the host clock', async () => {
  const store = createSearchCoverageStore()
  searchCoverage.mockResolvedValue(coverage('running', { phase: 'updating', startedAt: 10 ** 12 }))
  const unsubscribe = store.subscribe(() => undefined)
  await vi.advanceTimersByTimeAsync(0)
  const first = store.getSnapshot()
  expect(first.observedAt - first.phaseSince).toBe(0)

  await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 2)
  const later = store.getSnapshot()
  expect(later.phaseSince).toBe(first.phaseSince)
  expect(later.observedAt - later.phaseSince).toBeGreaterThanOrEqual(
    AI_VAULT_SEARCH_COVERAGE_POLL_MS
  )
  unsubscribe()
})
