// The Codex producer for the native-chat background-tasks strip.
//
// WHAT THE STRIP MEANS HERE. It is the surface for work that OUTLIVES its turn:
// the header renders a `monitoring` dot, the Claude producer blanks itself while
// a foreground turn runs, and `conversationCommandBlocked` refuses conversation
// commands while it is populated. Work still inside a turn already has its own
// surfaces — the working status, the turn activity line, and the durable
// `subagent-group` row. So a Codex task becomes strip-visible only once the
// primary turn it belongs to has completed and it is still unsettled.
//
// Codex has no `is_backgrounded` flag, so "backgrounded" is derived from that
// turn boundary rather than read off the wire. Measured on `codex app-server`
// 0.153.4: a `spawn_agent` child reported `subAgentActivity kind=completed`
// 95.8s AFTER the parent turn completed, and a child's shell survived its own
// turn's interrupt by 76s. `turn/completed` therefore REVEALS a task here and
// never settles one.
//
// Nothing in this file may write a terminal state a frame did not report. A
// child interrupted out of band never sends a terminal `subAgentActivity` at
// all (measured: `turn/interrupt` on a child thread ends its turn and emits no
// activity item), so it stays `working` until the session ends. An overdue
// working row is a smaller lie than claiming an outcome the provider never gave.

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
const MAX_TRACKED_COMMANDS = 128
const MAX_COMPLETED_TURNS = 256
const MAX_TASK_DESCRIPTION_CHARS = 512

/** Ids are namespaced because both kinds share one task list, and a child thread
 *  id and an exec item id are unrelated provider strings. */
const EMPTY_ROSTER_FINGERPRINT = '[]'

const AGENT_TASK_PREFIX = 'codex-agent:'
const COMMAND_TASK_PREFIX = 'codex-command:'

type TrackedChild = {
  label: string | null
  state: NativeChatSubagentState
  /** Parent turn the child was spawned in; null when Codex named none. */
  turnId: string | null
}

type TrackedCommand = {
  label: string | null
  running: boolean
  turnId: string | null
}

function description(value: string | null): string | undefined {
  if (value === null) {
    return undefined
  }
  const collapsed = value.trim().replace(/\s+/g, ' ')
  return collapsed.length > 0 ? collapsed.slice(0, MAX_TASK_DESCRIPTION_CHARS) : undefined
}

export class CodexBackgroundTaskTracker {
  private readonly children = new Map<string, TrackedChild>()
  private readonly commands = new Map<string, TrackedCommand>()
  /** Primary-thread turns Codex has reported finished. Membership is what makes
   *  a task reportable; it is never used to change a task's own state. */
  private readonly completedTurns = new Set<string>()
  /** Seeded with the empty roster, not `''`: a session that has never reported
   *  anything is already publishing nothing, so the first frame that changes no
   *  output must not be mistaken for a transition. */
  private publishedFingerprint = EMPTY_ROSTER_FINGERPRINT

  constructor(private readonly primaryThreadId: string) {}

  get state(): AgentSessionBackgroundTaskState | null {
    const tasks = this.tasks()
    return tasks.length === 0
      ? null
      : {
          state: 'monitoring',
          tasks,
          // Codex exposes no honest stop for either kind: `turn/interrupt` on a
          // child ends its turn without emitting a terminal activity item and
          // leaves its shell running, so the row it left behind would claim an
          // outcome nothing verified.
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
    } else if (frame.kind === 'subagent') {
      this.upsertChild(frame.agentThreadId, frame.label, frame.state, frame.turnId)
    } else {
      this.upsertCommand(frame.itemId, frame.label, frame.running, frame.turnId)
    }
    return this.refresh()
  }

  clear(): boolean {
    this.children.clear()
    this.commands.clear()
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
      // A child's own verdict latches: `subAgentActivity` arrives twice for every
      // transition (`item/started` and `item/completed`), so a settled child must
      // not be resurrected by the duplicate.
      this.children.set(agentThreadId, {
        label: existing.label ?? label,
        state: isTerminalSubagentState(existing.state) ? existing.state : state,
        turnId: existing.turnId ?? turnId
      })
      return
    }
    if (
      !this.makeRoom(this.children, MAX_TRACKED_CHILDREN, (child) =>
        isTerminalSubagentState(child.state)
      )
    ) {
      return
    }
    this.children.set(agentThreadId, { label, state, turnId })
  }

  private upsertCommand(
    itemId: string,
    label: string | null,
    running: boolean,
    turnId: string | null
  ): void {
    const existing = this.commands.get(itemId)
    if (existing) {
      this.commands.set(itemId, {
        label: label ?? existing.label,
        running,
        turnId: existing.turnId ?? turnId
      })
      return
    }
    if (!this.makeRoom(this.commands, MAX_TRACKED_COMMANDS, (command) => !command.running)) {
      return
    }
    this.commands.set(itemId, { label, running, turnId })
  }

  /** Frees a slot by dropping the oldest settled entry. Refuses to evict a live
   *  one: forgetting a running task is how a strip stops reporting work that is
   *  demonstrably still in flight. */
  private makeRoom<T>(
    entries: Map<string, T>,
    cap: number,
    settled: (entry: T) => boolean
  ): boolean {
    if (entries.size < cap) {
      return true
    }
    for (const [id, entry] of entries) {
      if (settled(entry)) {
        entries.delete(id)
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

  /** A task whose turn Codex never named cannot be placed inside one, so it is
   *  by definition not foreground work and reports immediately. */
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
        ...(description(child.label) ? { description: description(child.label) } : {})
      })
    }
    for (const [itemId, command] of this.commands) {
      if (!command.running || !this.outlivedItsTurn(command.turnId)) {
        continue
      }
      tasks.push({
        id: `${COMMAND_TASK_PREFIX}${itemId}`,
        kind: 'command',
        ...(description(command.label) ? { description: description(command.label) } : {})
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
