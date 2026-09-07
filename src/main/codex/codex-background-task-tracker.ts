// The Codex producer for the native-chat background-tasks strip.
//
// WHAT THE STRIP MEANS HERE. It is the surface for work that OUTLIVES its turn:
// the header renders a `monitoring` dot, the Claude producer blanks itself while
// a foreground turn runs, and `conversationCommandBlocked` refuses conversation
// commands while it is populated. Work still inside a turn already has its own
// surfaces — the working status, the turn activity line, and the durable
// `subagent-group` row. So a Codex child becomes strip-visible only once the
// primary turn that spawned it has completed and it is still unsettled.
//
// Codex has no `is_backgrounded` flag, so "backgrounded" is derived from that
// turn boundary rather than read off the wire. Measured on `codex app-server`
// 0.153.4: a `spawn_agent` child reported `subAgentActivity kind=completed`
// 95.8s AFTER the parent turn completed. `turn/completed` therefore REVEALS a
// child here and never settles one.
//
// Nothing in this file may write a terminal state a frame did not report. A
// child interrupted out of band never sends a terminal `subAgentActivity` at
// all (measured: `turn/interrupt` on a child thread ends its turn and emits no
// activity item), so it stays `working` until the session ends. An overdue
// working row is a smaller lie than claiming an outcome nothing verified.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import type { NativeChatSubagentState } from '../../shared/native-chat-types'
import {
  isTerminalSubagentState,
  readCodexBackgroundTaskFrame,
  type CodexBackgroundTaskEvent
} from './codex-background-task-frames'

/** Bounds on maps that only provider events grow; no snapshot ever prunes them. */
const MAX_TRACKED_CHILDREN = 128
const MAX_COMPLETED_TURNS = 256
const MAX_TASK_DESCRIPTION_CHARS = 512

/** Seeded fingerprint for a session that has never reported anything, so the
 *  first frame that changes no output is not mistaken for a transition. */
const EMPTY_ROSTER_FINGERPRINT = '[]'

/** Namespaced so a task id stays readable as what it points at, and so a future
 *  kind cannot collide with a child thread id. */
const AGENT_TASK_PREFIX = 'codex-agent:'

type TrackedChild = {
  label: string | undefined
  state: NativeChatSubagentState
  /** Parent turn the child was spawned in; null when Codex named none. */
  turnId: string | null
}

/** Normalized once at receipt, not per projection: the roster is re-projected on
 *  every observed frame, and the bound is a property of the stored value. */
function description(value: string | null): string | undefined {
  if (value === null) {
    return undefined
  }
  const collapsed = value.trim().replace(/\s+/g, ' ')
  return collapsed.length > 0 ? collapsed.slice(0, MAX_TASK_DESCRIPTION_CHARS) : undefined
}

export class CodexBackgroundTaskTracker {
  private readonly children = new Map<string, TrackedChild>()
  /** Primary-thread turns Codex has reported finished. Membership is what makes
   *  a child reportable; it is never used to change a child's own state. */
  private readonly completedTurns = new Set<string>()
  private publishedFingerprint = EMPTY_ROSTER_FINGERPRINT

  constructor(private readonly primaryThreadId: string) {}

  get state(): AgentSessionBackgroundTaskState | null {
    const tasks = this.tasks()
    return tasks.length === 0
      ? null
      : {
          state: 'monitoring',
          tasks,
          // Codex exposes no honest stop: `turn/interrupt` on a child ends its
          // turn without emitting a terminal activity item and leaves its shell
          // running, so the row it left behind would claim an outcome nothing
          // verified.
          supportsStopAll: false
        }
  }

  /** Returns true when the published state changed and must be republished. */
  observe(event: CodexBackgroundTaskEvent): boolean {
    const frame = readCodexBackgroundTaskFrame(event, this.primaryThreadId)
    if (!frame) {
      return false
    }
    if (frame.kind === 'turn-completed') {
      this.rememberCompletedTurn(frame.turnId)
    } else {
      this.upsertChild(frame.agentThreadId, frame.label, frame.state, frame.turnId)
    }
    return this.refresh()
  }

  clear(): boolean {
    this.children.clear()
    this.completedTurns.clear()
    return this.refresh()
  }

  private upsertChild(
    agentThreadId: string,
    label: string | null,
    state: NativeChatSubagentState,
    turnId: string | null
  ): void {
    const existing = this.children.get(agentThreadId)
    if (existing) {
      // A child's own verdict latches: `subAgentActivity` arrives twice for
      // every transition, so a settled child must not be resurrected by the
      // duplicate.
      this.children.set(agentThreadId, {
        label: existing.label ?? description(label),
        state: isTerminalSubagentState(existing.state) ? existing.state : state,
        turnId: existing.turnId ?? turnId
      })
      return
    }
    if (!this.makeRoom()) {
      return
    }
    this.children.set(agentThreadId, { label: description(label), state, turnId })
  }

  /** Frees a slot by dropping the oldest settled child. Refuses to evict a live
   *  one: forgetting a running child is how a strip stops reporting work that is
   *  demonstrably still in flight, so at the cap a new child is dropped instead
   *  — under-reporting, never a false claim about one already on screen. */
  private makeRoom(): boolean {
    if (this.children.size < MAX_TRACKED_CHILDREN) {
      return true
    }
    for (const [id, child] of this.children) {
      if (isTerminalSubagentState(child.state)) {
        this.children.delete(id)
        return true
      }
    }
    return false
  }

  private rememberCompletedTurn(turnId: string): void {
    this.completedTurns.delete(turnId)
    this.completedTurns.add(turnId)
    while (this.completedTurns.size > MAX_COMPLETED_TURNS) {
      const oldest = this.completedTurns.values().next()
      if (oldest.done) {
        break
      }
      this.completedTurns.delete(oldest.value)
    }
  }

  /** A child Codex placed in no turn cannot be inside one, so it is by
   *  definition not foreground work and reports immediately. */
  private outlivedItsTurn(turnId: string | null): boolean {
    return turnId === null || this.completedTurns.has(turnId)
  }

  private tasks(): AgentSessionBackgroundTask[] {
    const tasks: AgentSessionBackgroundTask[] = []
    for (const [agentThreadId, child] of this.children) {
      if (isTerminalSubagentState(child.state) || !this.outlivedItsTurn(child.turnId)) {
        continue
      }
      tasks.push({
        id: `${AGENT_TASK_PREFIX}${agentThreadId}`,
        kind: 'agent',
        ...(child.label === undefined ? {} : { description: child.label })
      })
    }
    return tasks
  }

  private refresh(): boolean {
    const fingerprint = JSON.stringify(this.tasks())
    if (fingerprint === this.publishedFingerprint) {
      return false
    }
    this.publishedFingerprint = fingerprint
    return true
  }
}
