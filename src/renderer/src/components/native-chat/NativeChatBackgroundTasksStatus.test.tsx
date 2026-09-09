// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const TASKS: AgentSessionBackgroundTask[] = [
  { id: 'codex-agent:child-1', kind: 'agent', description: 'count_a' },
  { id: 'codex-command:exec-1', kind: 'command', description: 'sleep 90' }
]

function renderStrip(props: { supportsTaskStop: boolean; supportsStopAll: boolean }): {
  onStop: ReturnType<typeof vi.fn>
} {
  const onStop = vi.fn()
  render(
    <NativeChatBackgroundTasksStatus
      isVisible
      tasks={TASKS}
      settledTasks={[]}
      indicatorActive
      supportsTaskStop={props.supportsTaskStop}
      supportsStopAll={props.supportsStopAll}
      stoppingTaskIds={new Set()}
      stoppingAll={false}
      onStop={onStop}
    />
  )
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return { onStop }
}

describe('NativeChatBackgroundTasksStatus stop affordances', () => {
  it('offers a per-task stop on a host that accepts targeted stops', () => {
    renderStrip({ supportsTaskStop: true, supportsStopAll: true })
    expect(screen.getByLabelText('Stop count_a')).toBeInTheDocument()
    expect(screen.queryByLabelText('Stop background tasks')).not.toBeInTheDocument()
  })

  it('falls back to a stop-all on a host that only accepts an untargeted stop', () => {
    renderStrip({ supportsTaskStop: false, supportsStopAll: true })
    expect(screen.getByLabelText('Stop background tasks')).toBeInTheDocument()
  })

  it('offers no stop at all when the provider exposes none', () => {
    // Codex: a Stop button here would be a control that cannot act.
    renderStrip({ supportsTaskStop: false, supportsStopAll: false })
    expect(screen.queryByLabelText('Stop background tasks')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Stop count_a')).not.toBeInTheDocument()
    expect(screen.getByText('count_a')).toBeInTheDocument()
    expect(screen.getByText('sleep 90')).toBeInTheDocument()
  })
})

describe('background-tasks strip header', () => {
  function renderHeader(tasks: AgentSessionBackgroundTask[]): HTMLElement {
    render(
      <NativeChatBackgroundTasksStatus
        isVisible
        tasks={tasks}
        settledTasks={[]}
        indicatorActive
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={() => {}}
      />
    )
    return screen.getByRole('button', { expanded: false })
  }

  it('leads each kind segment with that kind icon and keeps the counts in the accessible name', () => {
    const header = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'a2', kind: 'agent' },
      { id: 'a3', kind: 'agent' },
      { id: 'm1', kind: 'monitor' }
    ])
    expect(header).toHaveAttribute('aria-label', '3 agents · 1 monitor')
    expect(header.querySelector('.lucide-bot')).toBeInTheDocument()
    // Heartbeat, the same glyph the agent sidebar shows for monitoring.
    expect(header.querySelector('.lucide-activity')).toBeInTheDocument()
    // Two kind icons and the chevron: the aggregate state dot is gone.
    expect(header.querySelectorAll('svg')).toHaveLength(3)
    for (const icon of header.querySelectorAll('svg')) {
      expect(icon).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('carries no icon on a collapsed total, which spans kinds', () => {
    const header = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'c1', kind: 'command' },
      { id: 'm1', kind: 'monitor' },
      { id: 'w1', kind: 'workflow' }
    ])
    expect(header).toHaveAttribute('aria-label', '4 background tasks')
    expect(header.querySelectorAll('svg')).toHaveLength(1)
  })
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
        supportsStopAll={false}
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
