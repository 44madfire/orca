import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'

const MAX_TRACKED_TASKS = 256
const MAX_TASK_ID_LENGTH = 512
const MAX_TASK_DESCRIPTION_LENGTH = 512
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'killed', 'stopped'])

export type ClaudeBackgroundTaskKind = AgentSessionBackgroundTask['kind']

type TrackedTask = {
  backgrounded: boolean
  /** Foreground work is turn-scoped: the provider's `result` is its outcome, so
   *  it stays visible only until that frame. Backgrounded work ignores this. */
  liveInTurn: boolean
  kind: ClaudeBackgroundTaskKind
  description?: string
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/** The bound every task id shares, wherever it enters. An id the roster stores
 *  becomes a durable entry key, so a provisional one takes the same bound the
 *  announced path applies — an over-long id is rejected, never truncated. */
export function isBoundedClaudeTaskId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TASK_ID_LENGTH
}

/** The task's canonical, resume-stable id. Shared with the subagent roster so
 *  both readers of this channel agree on what identifies a task. */
export function claudeTaskId(message: Record<string, unknown>): string | null {
  const value = message.task_id
  return typeof value === 'string' && isBoundedClaudeTaskId(value) ? value : null
}

/** A task's human label, collapsed and bounded. */
export function claudeTaskDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed.length > 0 ? trimmed.slice(0, MAX_TASK_DESCRIPTION_LENGTH) : undefined
}

export function classifyClaudeBackgroundTaskKind(taskType: unknown): ClaudeBackgroundTaskKind {
  switch (taskType) {
    case 'local_agent':
      return 'agent'
    case 'local_workflow':
      return 'workflow'
    case 'local_bash':
      return 'command'
    case 'monitor':
      return 'monitor'
    default:
      return 'unknown'
  }
}

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  private readonly terminalTaskIds = new Set<string>()
  private aggregateRosterObserved = false
  private monitoring = false
  private publishedTasksFingerprint = ''

  get state(): AgentSessionBackgroundTaskState | null {
    if (!this.monitoring) {
      return null
    }
    return {
      state: 'monitoring',
      tasks: this.backgroundTaskDetails()
    }
  }

  get stoppableTaskIds(): string[] {
    const ids: string[] = []
    for (const [id, task] of this.tasks) {
      if (task.backgrounded) {
        ids.push(id)
      }
    }
    return ids
  }

  observe(message: Record<string, unknown>, startsTurn = false): boolean {
    if (message.type === 'result') {
      this.settleForegroundTasks()
    } else if (message.type === 'system') {
      if (!this.observeSystemFrame(message) && !startsTurn) {
        return false
      }
    } else if (!startsTurn) {
      return false
    }
    return this.refreshMonitoring()
  }

  clear(): boolean {
    this.tasks.clear()
    this.terminalTaskIds.clear()
    this.aggregateRosterObserved = false
    return this.refreshMonitoring()
  }

  /** `result` is the outcome of every task the provider marked foreground, so
   *  they stop being live work. Backgrounded tasks outlive the turn and are
   *  never swept here — only their own terminal frame retires them. */
  private settleForegroundTasks(): void {
    for (const task of this.tasks.values()) {
      if (!task.backgrounded) {
        task.liveInTurn = false
      }
    }
  }

  private observeSystemFrame(message: Record<string, unknown>): boolean {
    if (message.subtype === 'background_tasks_changed') {
      this.replaceAggregateRoster(message.tasks)
      return true
    }
    const id = claudeTaskId(message)
    if (!id) {
      return false
    }
    if (message.subtype === 'task_notification') {
      this.finish(id)
      return true
    }
    if (message.subtype === 'task_updated') {
      const patch = record(message.patch)
      if (!patch) {
        return false
      }
      if (TERMINAL_TASK_STATES.has(String(patch.status))) {
        this.finish(id)
        return true
      }
      const existing = this.tasks.get(id)
      if (
        (patch.is_backgrounded === true || claudeTaskDescription(patch.description)) &&
        (!this.aggregateRosterObserved || existing)
      ) {
        this.upsert(id, {
          backgrounded: patch.is_backgrounded === true || existing?.backgrounded === true,
          kind: existing?.kind ?? 'unknown',
          description: claudeTaskDescription(patch.description) ?? existing?.description
        })
        return true
      }
      return false
    }
    if (message.subtype !== 'task_started' || this.terminalTaskIds.has(id)) {
      return false
    }
    if (message.ambient === true || message.skip_transcript === true) {
      this.finish(id)
      return true
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    const backgrounded =
      message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor'
    // The roster enumerates backgrounded work only, so it can only convict a
    // backgrounded start of being stale. Foreground work it never lists is new.
    if (backgrounded && this.aggregateRosterObserved && !this.tasks.has(id)) {
      return false
    }
    this.upsert(id, {
      backgrounded,
      kind,
      description: claudeTaskDescription(message.description)
    })
    return true
  }

  private replaceAggregateRoster(value: unknown): void {
    if (!Array.isArray(value)) {
      return
    }
    this.aggregateRosterObserved = true
    const roster = new Map<string, TrackedTask>()
    for (const valueTask of value) {
      if (roster.size >= MAX_TRACKED_TASKS) {
        break
      }
      const task = record(valueTask)
      if (!task || task.ambient === true) {
        continue
      }
      const id = claudeTaskId(task)
      if (!id) {
        continue
      }
      // Current evidence overrules an earlier terminal edge, but only for the
      // ids the roster actually lists. Wiping the whole set would leave a
      // finished FOREGROUND id undefended: the admission guard no longer
      // rejects it, so a replayed start would revive it for the rest of the turn.
      this.terminalTaskIds.delete(id)
      roster.set(id, {
        backgrounded: true,
        liveInTurn: true,
        kind: classifyClaudeBackgroundTaskKind(task.task_type),
        description: claudeTaskDescription(task.description)
      })
    }
    this.replaceTracked(roster)
  }

  /** The roster says nothing about foreground work, so it cannot retire it:
   *  live foreground rows survive replacement and only their own turn's
   *  `result` ends them. They keep the place the user is already reading them
   *  in, and they count against the cap — when it bites, the STALEST retained
   *  row goes, never the newest, and roster entries are never starved. */
  private replaceTracked(roster: Map<string, TrackedTask>): void {
    let retained = 0
    for (const [id, task] of this.tasks) {
      if (!roster.has(id) && !task.backgrounded && task.liveInTurn) {
        retained += 1
      }
    }
    let evict = Math.max(0, roster.size + retained - MAX_TRACKED_TASKS)
    const merged = new Map<string, TrackedTask>()
    for (const [id, task] of this.tasks) {
      const listed = roster.get(id)
      if (listed) {
        merged.set(id, listed)
        continue
      }
      if (task.backgrounded || !task.liveInTurn) {
        continue
      }
      if (evict > 0) {
        evict -= 1
        continue
      }
      merged.set(id, task)
    }
    for (const [id, task] of roster) {
      if (!merged.has(id)) {
        merged.set(id, task)
      }
    }
    this.tasks.clear()
    for (const [id, task] of merged) {
      this.tasks.set(id, task)
    }
  }

  private upsert(id: string, task: Omit<TrackedTask, 'liveInTurn'>): void {
    const existing = this.tasks.get(id)
    if (existing) {
      this.tasks.set(id, {
        backgrounded: existing.backgrounded || task.backgrounded,
        // A settled foreground task is not revived by a late edge frame.
        liveInTurn: existing.liveInTurn,
        kind: existing.kind === 'unknown' ? task.kind : existing.kind,
        description: task.description ?? existing.description
      })
      return
    }
    if (this.tasks.size >= MAX_TRACKED_TASKS) {
      let foregroundId: string | undefined
      for (const [candidateId, candidate] of this.tasks) {
        if (!candidate.backgrounded) {
          foregroundId = candidateId
          break
        }
      }
      if (!foregroundId) {
        return
      }
      this.tasks.delete(foregroundId)
    }
    this.tasks.set(id, { ...task, liveInTurn: true })
  }

  private finish(id: string): void {
    this.tasks.delete(id)
    this.terminalTaskIds.delete(id)
    this.terminalTaskIds.add(id)
    if (this.terminalTaskIds.size > MAX_TRACKED_TASKS) {
      const oldest = this.terminalTaskIds.values().next()
      if (!oldest.done) {
        this.terminalTaskIds.delete(oldest.value)
      }
    }
  }

  private refreshMonitoring(): boolean {
    const details = this.backgroundTaskDetails()
    const next = details.length > 0
    const fingerprint = next ? JSON.stringify(details) : ''
    if (next === this.monitoring && fingerprint === this.publishedTasksFingerprint) {
      return false
    }
    this.monitoring = next
    this.publishedTasksFingerprint = fingerprint
    return true
  }

  /** Every task in flight, foreground included, so the strip reports the work
   *  that is actually running rather than only what outlived a turn. */
  private backgroundTaskDetails(): AgentSessionBackgroundTask[] {
    const details: AgentSessionBackgroundTask[] = []
    for (const [id, task] of this.tasks) {
      if (!task.backgrounded && !task.liveInTurn) {
        continue
      }
      details.push({
        id,
        kind: task.kind,
        // Foreground work is not a target `stopTask` accepts, so the row says so
        // rather than drawing a Stop that would silently do nothing.
        ...(task.backgrounded ? {} : { stoppable: false }),
        ...(task.description ? { description: task.description } : {})
      })
    }
    return details
  }
}
