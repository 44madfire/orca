import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session-wire'
import {
  backgroundTasksDotState,
  backgroundTasksHeaderContent,
  buildBackgroundTaskGroups,
  resolveBackgroundTaskName
} from './background-task-roster'

const NOW = 1_000_000

function agent(
  id: string,
  overrides: Partial<AgentSessionBackgroundTask> = {}
): AgentSessionBackgroundTask {
  return { id, kind: 'agent', state: 'working', startedAt: NOW - 60_000, ...overrides }
}

function header(
  tasks: AgentSessionBackgroundTask[],
  settled: AgentSessionBackgroundTask[] = [],
  narrow = false
) {
  return backgroundTasksHeaderContent(buildBackgroundTaskGroups(tasks, settled), {
    narrow,
    now: NOW
  })
}

describe('backgroundTasksHeaderContent', () => {
  it('lists all states for a single-kind fan-out (agents only)', () => {
    expect(header([agent('a'), agent('b'), agent('c', { state: 'waiting' })])).toEqual({
      segments: ['3 agents'],
      detail: '2 working, 1 waiting'
    })
  })

  it('names a single working agent', () => {
    expect(header([agent('a')])).toEqual({ segments: ['1 agent'], detail: 'working' })
  })

  it('counts by kind for a mixed roster without a partial state breakdown', () => {
    expect(
      header([
        agent('a'),
        agent('b'),
        { id: 's', kind: 'command', state: 'working', startedAt: NOW },
        { id: 'm', kind: 'monitor', state: 'monitoring', startedAt: NOW }
      ])
    ).toEqual({ segments: ['2 agents', '1 shell', '1 monitor'], detail: null })
  })

  it('shows elapsed for a single shell command', () => {
    expect(
      header([{ id: 's', kind: 'command', state: 'working', startedAt: NOW - 72_000 }])
    ).toEqual({ segments: ['1 shell command'], detail: '1m 12s' })
  })

  it('leads with the attention state when a single agent needs the user', () => {
    expect(header([agent('a', { state: 'waiting' })])).toEqual({
      segments: ['1 agent waiting'],
      detail: 'needs approval'
    })
  })

  it('reports lost contact above running work', () => {
    expect(
      header([agent('a', { state: 'unverifiable' }), agent('b', { state: 'unverifiable' })])
    ).toEqual({ segments: ['2 agents unverifiable'], detail: 'no contact' })
  })

  it('keeps the existing copy for a host that sends state without a task list', () => {
    expect(header([])).toEqual({ segments: [], detail: 'Monitoring background tasks' })
  })

  it('drops the breakdown for an honest total past the segment cap', () => {
    expect(
      header([
        agent('a'),
        { id: 'b', kind: 'command', state: 'working', startedAt: NOW },
        { id: 'c', kind: 'monitor', state: 'monitoring', startedAt: NOW },
        { id: 'd', kind: 'workflow', state: 'working', startedAt: NOW },
        agent('e'),
        { id: 'f', kind: 'command', state: 'working', startedAt: NOW },
        { id: 'g', kind: 'unknown', startedAt: NOW }
      ])
    ).toEqual({ segments: ['7 background tasks'], detail: null })
  })

  it('falls back to the total on a narrow strip', () => {
    expect(
      header([agent('a'), { id: 's', kind: 'command', state: 'working', startedAt: NOW }], [], true)
    ).toEqual({ segments: ['2 background tasks'], detail: null })
    // A single task stays named: the short form fits.
    expect(header([agent('a')], [], true)).toEqual({ segments: ['1 agent'], detail: 'working' })
  })

  it('drops the state list when every task is done', () => {
    expect(
      header(
        [],
        [
          agent('a', { state: 'done' }),
          agent('b', { state: 'done' }),
          agent('c', { state: 'done' })
        ]
      )
    ).toEqual({ segments: ['3 agents'], detail: null })
  })

  it('counts unknown tasks instead of hiding them', () => {
    expect(header([{ id: 'u', kind: 'unknown', startedAt: NOW }])).toEqual({
      segments: ['1 task'],
      detail: 'working'
    })
  })
})

describe('backgroundTasksDotState', () => {
  const groups = (tasks: AgentSessionBackgroundTask[]) => buildBackgroundTaskGroups(tasks, [])

  it('lets lost contact outrank running work', () => {
    expect(
      backgroundTasksDotState(groups([agent('a'), agent('b', { state: 'unverifiable' })]))
    ).toBe('unverifiable')
  })

  it('keeps the aggregate monitoring identity for mixed kinds', () => {
    expect(
      backgroundTasksDotState(
        groups([agent('a'), { id: 's', kind: 'command', state: 'working', startedAt: NOW }])
      )
    ).toBe('monitoring')
  })

  it('reports the liveliest state for a single kind', () => {
    expect(backgroundTasksDotState(groups([agent('a'), agent('b', { state: 'waiting' })]))).toBe(
      'working'
    )
    expect(backgroundTasksDotState(groups([agent('a', { state: 'waiting' })]))).toBe('waiting')
  })
})

describe('buildBackgroundTaskGroups', () => {
  it('groups by kind in fixed order, keeping first-seen order inside a group', () => {
    const built = buildBackgroundTaskGroups(
      [
        { id: 'm', kind: 'monitor', startedAt: 3 },
        agent('late', { startedAt: 2 }),
        agent('early', { startedAt: 1 })
      ],
      [agent('settled', { state: 'done', startedAt: 0 })]
    )
    expect(built.map((group) => group.kind)).toEqual(['agent', 'monitor'])
    expect(built[0].tasks.map((entry) => entry.task.id)).toEqual(['settled', 'early', 'late'])
    expect(built[0].tasks[0].settled).toBe(true)
  })

  it('defaults the state slot so a stateless row still reads as work', () => {
    const built = buildBackgroundTaskGroups([{ id: 'a', kind: 'agent' }], [])
    expect(built[0].tasks[0].state).toBe('working')
    const monitor = buildBackgroundTaskGroups([{ id: 'm', kind: 'monitor' }], [])
    expect(monitor[0].tasks[0].state).toBe('monitoring')
  })
})

describe('resolveBackgroundTaskName', () => {
  it('prefers description, then name, then the kind label', () => {
    expect(
      resolveBackgroundTaskName({ id: 'a', kind: 'agent', description: 'review PR', name: 'deep' })
    ).toBe('review PR')
    expect(resolveBackgroundTaskName({ id: 'a', kind: 'agent', name: 'deep_review' })).toBe(
      'deep_review'
    )
    expect(resolveBackgroundTaskName({ id: 'a', kind: 'agent' })).toBe('Background agent')
  })

  it('rejects empty-after-trim and placeholder names', () => {
    expect(resolveBackgroundTaskName({ id: 'a', kind: 'agent', description: '   ' })).toBe(
      'Background agent'
    )
    expect(
      resolveBackgroundTaskName({
        id: 'a',
        kind: 'command',
        description: 'Unknown',
        name: ' task '
      })
    ).toBe('Background command')
  })
})
