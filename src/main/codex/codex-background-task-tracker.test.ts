import { describe, expect, it } from 'vitest'
import { CodexBackgroundTaskTracker } from './codex-background-task-tracker'
import { readCodexBackgroundTaskFrame } from './codex-background-task-frames'

// Frame shapes are copied verbatim from a `codex app-server` 0.153.4 stdio
// capture, so a rename on the real wire fails these rather than passing against
// a shape this repo invented.
const PRIMARY = '01a07d54-3785-71d0-b065-82c8ebbc572a'
const PARENT_TURN = '01a07d54-37be-72e1-8206-8f0c23dd2cef'
const CHILD_A = '01a07d54-5523-78a3-91f5-e0acb1dab065'
const CHILD_B = '01a07d54-6337-7793-a251-32410b3a6b2e'
const CHILD_TURN_A = '01a07d54-5542-72d3-80f4-e08f6bc991e7'

function subagentFrame(
  method: 'item/started' | 'item/completed',
  agentThreadId: string,
  kind: string,
  agentPath: string,
  turnId: string | null = PARENT_TURN
): Parameters<CodexBackgroundTaskTracker['observe']>[0] {
  return {
    method,
    threadId: PRIMARY,
    params: {
      item: {
        type: 'subAgentActivity',
        id: `call_${agentThreadId}`,
        kind,
        agentThreadId,
        agentPath
      },
      threadId: PRIMARY,
      ...(turnId === null ? {} : { turnId })
    }
  }
}

function commandFrame(input: {
  method: 'item/started' | 'item/completed'
  threadId?: string
  id: string
  command: string
  status: string
  turnId?: string
  commandActions?: unknown[]
}): Parameters<CodexBackgroundTaskTracker['observe']>[0] {
  const threadId = input.threadId ?? PRIMARY
  return {
    method: input.method,
    threadId,
    params: {
      item: {
        type: 'commandExecution',
        id: input.id,
        pluginId: null,
        scriptPath: null,
        command: input.command,
        cwd: '/tmp/probe',
        processId: '71831',
        source: 'unifiedExecStartup',
        status: input.status,
        commandActions: input.commandActions ?? [],
        aggregatedOutput: null,
        exitCode: input.status === 'completed' ? 0 : null,
        durationMs: null
      },
      threadId,
      turnId: input.turnId ?? PARENT_TURN
    }
  }
}

function turnCompleted(
  threadId: string,
  turnId: string
): Parameters<CodexBackgroundTaskTracker['observe']>[0] {
  return {
    method: 'turn/completed',
    threadId,
    params: { threadId, turn: { id: turnId, status: 'completed' } }
  }
}

describe('readCodexBackgroundTaskFrame', () => {
  it('reads the app-server field names, not the rollout dialect', () => {
    expect(
      readCodexBackgroundTaskFrame(
        subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'),
        PRIMARY
      )
    ).toEqual({
      kind: 'subagent',
      agentThreadId: CHILD_A,
      label: 'count_a',
      state: 'working',
      turnId: PARENT_TURN
    })
  })

  it('ignores the root node, which is the parent turn reporting itself', () => {
    expect(
      readCodexBackgroundTaskFrame(
        subagentFrame('item/started', PRIMARY, 'started', '/root'),
        PRIMARY
      )
    ).toBeNull()
  })

  it('is not a task, because the journal already settles it at turn end', () => {
    // `settleCodexJournalTurn` writes every still-active item `state: 'failed'`
    // on `turn/completed`. A strip row saying the same shell is still running
    // would contradict the row Orca just wrote about it.
    expect(
      readCodexBackgroundTaskFrame(
        commandFrame({
          method: 'item/started',
          id: 'exec-primary',
          command: "/bin/zsh -lc 'sleep 90'",
          status: 'inProgress'
        }),
        PRIMARY
      )
    ).toBeNull()
  })

  it('ignores a child thread completing its own turn', () => {
    expect(readCodexBackgroundTaskFrame(turnCompleted(CHILD_A, CHILD_TURN_A), PRIMARY)).toBeNull()
  })
})

describe('CodexBackgroundTaskTracker', () => {
  it('stays silent while the spawning turn is still running', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    tracker.observe(subagentFrame('item/started', CHILD_B, 'started', '/root/read_b'))
    expect(tracker.state).toBeNull()
  })

  it('reports the children still live when the spawning turn completes', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    tracker.observe(subagentFrame('item/started', CHILD_B, 'started', '/root/read_b'))
    expect(tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))).toBe(true)
    expect(tracker.state).toEqual({
      state: 'monitoring',
      supportsStopAll: false,
      tasks: [
        { id: `codex-agent:${CHILD_A}`, kind: 'agent', description: 'count_a' },
        { id: `codex-agent:${CHILD_B}`, kind: 'agent', description: 'read_b' }
      ]
    })
  })

  it('never settles a child on a turn boundary, only on its own activity kind', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    // A second turn coming and going says nothing about the first turn's child.
    tracker.observe(turnCompleted(PRIMARY, 'turn-2'))
    expect(tracker.state?.tasks).toHaveLength(1)
    tracker.observe(subagentFrame('item/completed', CHILD_A, 'completed', '/root/count_a'))
    expect(tracker.state).toBeNull()
  })

  it('is idempotent across the duplicate item/started and item/completed delivery', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    expect(
      tracker.observe(subagentFrame('item/completed', CHILD_A, 'started', '/root/count_a'))
    ).toBe(false)
    expect(tracker.state?.tasks).toHaveLength(1)
  })

  it('does not resurrect a settled child when a stale started frame replays', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    tracker.observe(subagentFrame('item/completed', CHILD_A, 'completed', '/root/count_a'))
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    expect(tracker.state).toBeNull()
  })

  it('reports an interrupted child as stopped, which its own kind names', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    tracker.observe(subagentFrame('item/completed', CHILD_A, 'interrupted', '/root/count_a'))
    expect(tracker.state).toBeNull()
  })

  it('leaves a subagent shell to the row of the child that ran it', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/one'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    tracker.observe(
      commandFrame({
        method: 'item/started',
        threadId: CHILD_A,
        id: 'exec-child',
        command: "/bin/zsh -lc 'sleep 90'",
        status: 'inProgress',
        turnId: CHILD_TURN_A
      })
    )
    expect(tracker.state?.tasks).toEqual([
      { id: `codex-agent:${CHILD_A}`, kind: 'agent', description: 'one' }
    ])
  })

  it('reports activity Codex placed in no turn immediately', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/count_a', null))
    expect(tracker.state?.tasks).toHaveLength(1)
  })

  it('keeps a child working when nothing ever reports its outcome', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/one'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    // `turn/interrupt` on a child ends its turn and emits no activity item;
    // an overdue working row beats claiming an outcome nothing verified.
    tracker.observe(turnCompleted(CHILD_A, CHILD_TURN_A))
    expect(tracker.state?.tasks).toHaveLength(1)
  })

  it('clears everything when the session is gone', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/one'))
    tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))
    expect(tracker.clear()).toBe(true)
    expect(tracker.state).toBeNull()
    expect(tracker.clear()).toBe(false)
  })

  it('publishes only when the reported roster actually changed', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    // Nothing reportable yet: a spawn inside a live turn changes no output.
    expect(tracker.observe(subagentFrame('item/started', CHILD_A, 'started', '/root/one'))).toBe(
      false
    )
    expect(tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))).toBe(true)
    expect(tracker.observe(turnCompleted(PRIMARY, PARENT_TURN))).toBe(false)
  })

  it('ignores frames from every other notification method', () => {
    const tracker = new CodexBackgroundTaskTracker(PRIMARY)
    expect(
      tracker.observe({
        method: 'thread/tokenUsage/updated',
        threadId: PRIMARY,
        params: { threadId: PRIMARY, tokenUsage: { total: { totalTokens: 10 } } }
      })
    ).toBe(false)
    expect(tracker.state).toBeNull()
  })
})
