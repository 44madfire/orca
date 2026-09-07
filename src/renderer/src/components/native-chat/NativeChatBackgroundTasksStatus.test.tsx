// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('stops elapsed renders in a hidden pane and catches up on reveal', () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const committed = vi.fn()
  const view = (isVisible: boolean) => (
    <Profiler id="strip" onRender={committed}>
      <NativeChatBackgroundTasksStatus
        isVisible={isVisible}
        tasks={[{ id: 'shell', kind: 'command', startedAt: 1_000 }]}
        settledTasks={[]}
        indicatorActive
        supportsTaskStop={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    </Profiler>
  )
  const { rerender, unmount } = render(view(true))
  committed.mockClear()
  act(() => vi.advanceTimersByTime(1_000))
  expect(committed).toHaveBeenCalled()
  rerender(view(false))
  committed.mockClear()
  act(() => vi.advanceTimersByTime(10_000))
  expect(committed).not.toHaveBeenCalled()
  rerender(view(true))
  committed.mockClear()
  act(() => vi.advanceTimersByTime(1_000))
  expect(committed).toHaveBeenCalled()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})
