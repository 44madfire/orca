// @vitest-environment happy-dom

import { createElement, StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSearchCoverageStore } from './ai-vault-search-coverage-store'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'
import {
  AI_VAULT_SEARCH_COVERAGE_POLL_MS,
  useAiVaultSearchCoveragePoll
} from './ai-vault-search-coverage-poll'

function coverage(backfill: AiVaultSearchCoverage['backfill']): AiVaultSearchCoverage {
  return {
    enabled: true,
    sessionsIndexed: 5,
    messagesIndexed: 20,
    providers: [],
    backfill,
    filesPending: 0,
    lastIndexedAt: null
  }
}

let searchCoverage: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  searchCoverage = vi.fn().mockResolvedValue(coverage('complete'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchCoverage } }
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
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(false), { wrapper })
    expect(searchCoverage).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('keeps observing a completed index so a later clear can report rebuilding', async () => {
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(true), { wrapper })
    await act(async () => {})

    expect(result.current?.sessionsIndexed).toBe(5)
    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS * 3)
    })
    expect(searchCoverage).toHaveBeenCalledTimes(callsAfterFirstRead + 3)
  })

  it('publishes consistently slow successes without overlapping polls', async () => {
    searchCoverage.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(coverage('running')), 5_000))
    )
    const { result } = renderHook(() => useAiVaultSearchCoveragePoll(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000)
    })
    expect(result.current?.backfill).toBe('running')
    expect(searchCoverage).toHaveBeenCalledTimes(3)
  })

  it('keeps polling while the backfill is still running', async () => {
    searchCoverage.mockResolvedValue(coverage('running'))
    renderHook(() => useAiVaultSearchCoveragePoll(true), { wrapper })
    await act(async () => {})

    const callsAfterFirstRead = searchCoverage.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AI_VAULT_SEARCH_COVERAGE_POLL_MS)
    })
    expect(searchCoverage.mock.calls.length).toBeGreaterThan(callsAfterFirstRead)
  })

  it('drops the last reading when search is turned off', async () => {
    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAiVaultSearchCoveragePoll(enabled),
      { initialProps: { enabled: true }, wrapper }
    )
    await act(async () => {})
    expect(result.current).not.toBeNull()

    rerender({ enabled: false })
    expect(result.current).toBeNull()
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
  const first = renderHook(() => useAiVaultSearchCoveragePoll(true))
  const second = renderHook(() => useAiVaultSearchCoveragePoll(true))
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
  expect(store.getSnapshot().coverage?.backfill).toBe('complete')
  releaseOld(coverage('running'))
  await Promise.resolve()
  expect(store.getSnapshot().coverage?.backfill).toBe('complete')
  unsubscribe()
})
