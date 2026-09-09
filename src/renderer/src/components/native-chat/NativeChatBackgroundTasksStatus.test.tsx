// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'
import { MONITOR_GLYPH_COLOR } from './native-chat-background-task-kinds'
import { AgentStateDot } from '@/components/AgentStateDot'

afterEach(cleanup)

/** The strip's disclosure is parent-owned; this stands in for that owner. */
function DisclosureHost(
  props: Omit<
    Parameters<typeof NativeChatBackgroundTasksStatus>[0],
    'expanded' | 'onExpandedChange'
  >
): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <NativeChatBackgroundTasksStatus
      {...props}
      expanded={expanded}
      onExpandedChange={setExpanded}
    />
  )
}

const TASKS: AgentSessionBackgroundTask[] = [
  { id: 'codex-agent:child-1', kind: 'agent', description: 'count_a' },
  { id: 'codex-command:exec-1', kind: 'command', description: 'sleep 90' }
]

function renderStrip(props: { supportsTaskStop: boolean; supportsStopAll: boolean }): {
  onStop: ReturnType<typeof vi.fn>
} {
  const onStop = vi.fn()
  render(
    <DisclosureHost
      tasks={TASKS}
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

describe('NativeChatBackgroundTasksStatus row glyphs', () => {
  function glyphClassFor(kind: AgentSessionBackgroundTask['kind']): string {
    render(
      <DisclosureHost
        tasks={[{ id: 'row-1', kind, description: 'row one' }]}
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const row = screen.getByText('row one').closest('li')
    const cls = row?.querySelector('svg')?.getAttribute('class') ?? ''
    return lucideGlyphName(cls)
  }

  /** Colour sits on the 16px slot the glyph inherits through currentColor. */
  function glyphSlotClassFor(kind: AgentSessionBackgroundTask['kind']): string {
    render(
      <DisclosureHost
        tasks={[{ id: 'row-1', kind, description: 'row one' }]}
        supportsTaskStop={false}
        supportsStopAll={false}
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const row = screen.getByText('row one').closest('li')
    const svg = row?.querySelector('svg')
    return `${svg?.parentElement?.getAttribute('class') ?? ''} ${svg?.getAttribute('class') ?? ''}`
  }

  /** The `lucide-<name>` token identifies the glyph; sizing and color classes
   *  legitimately differ between a row slot and a state dot. */
  function lucideGlyphName(className: string): string {
    return className.split(/\s+/).find((c) => c.startsWith('lucide-')) ?? ''
  }

  it('draws a monitor with the same heartbeat the monitoring dot uses', () => {
    // Monitoring is one idea app-wide; the strip must not invent a second glyph.
    const monitorGlyph = glyphClassFor('monitor')
    cleanup()
    const { container } = render(<AgentStateDot state="monitoring" size="md" title={null} />)
    const dotGlyph = lucideGlyphName(container.querySelector('svg')?.getAttribute('class') ?? '')
    expect(monitorGlyph).not.toBe('')
    expect(monitorGlyph).toBe(dotGlyph)
  })

  it('gives the monitor heartbeat the amber the monitoring dot uses', () => {
    // Same glyph on a muted grey would not read as the same thing. Reading the
    // colour from the module is what actually pins the two together: a hardcoded
    // string here would let the strip and the dot drift apart silently.
    expect(glyphSlotClassFor('monitor')).toContain(MONITOR_GLYPH_COLOR)
    cleanup()
    const { container } = render(<AgentStateDot state="monitoring" size="md" title={null} />)
    expect(container.querySelector('svg')?.getAttribute('class')).toContain(MONITOR_GLYPH_COLOR)
  })

  it('leaves the other kinds muted, so only monitoring reads as a state', () => {
    for (const kind of ['agent', 'command', 'workflow', 'unknown'] as const) {
      expect(glyphSlotClassFor(kind)).not.toContain(MONITOR_GLYPH_COLOR)
      cleanup()
    }
  })

  it('keeps a subagent visually distinct from a monitor', () => {
    const agentGlyph = glyphClassFor('agent')
    cleanup()
    const monitorGlyph = glyphClassFor('monitor')
    expect(agentGlyph).not.toBe(monitorGlyph)
  })
})

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

  it('withholds a row stop the host reported it cannot act on', () => {
    // Claude publishes foreground rows with `stoppable: false`: the session
    // accepts targeted stops, but not for this row.
    const onStop = vi.fn()
    render(
      <DisclosureHost
        tasks={[
          { id: 'fore-1', kind: 'agent', description: 'in-turn subagent', stoppable: false },
          { id: 'back-1', kind: 'agent', description: 'backgrounded subagent' }
        ]}
        supportsTaskStop
        supportsStopAll
        stoppingTaskIds={new Set()}
        stoppingAll={false}
        onStop={onStop}
      />
    )
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    expect(screen.getByText('in-turn subagent')).toBeInTheDocument()
    expect(screen.queryByLabelText('Stop in-turn subagent')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Stop backgrounded subagent')).toBeInTheDocument()
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
