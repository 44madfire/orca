import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState,
  AgentSessionBackgroundTaskState
} from '../../shared/agent-session-wire'
import {
  classifyClaudeBackgroundTaskKind,
  liveClaudeTaskRunState,
  record,
  taskDescription,
  taskId,
  taskName,
  terminalClaudeTaskRunState,
  type ClaudeBackgroundTaskKind
} from './claude-background-task-frames'

export { classifyClaudeBackgroundTaskKind } from './claude-background-task-frames'
export type { ClaudeBackgroundTaskKind } from './claude-background-task-frames'

const MAX_TRACKED_TASKS = 256

type TrackedTask = {
  backgrounded: boolean
  kind: ClaudeBackgroundTaskKind
  description?: string
  name?: string
  state?: AgentSessionBackgroundTaskRunState
  /** First-observed epoch ms; preserved across updates and roster replacement
   *  so clients can render elapsed and keep a stable first-seen sort. */
  startedAt: number
}

export class ClaudeBackgroundTaskTracker {
  private readonly tasks = new Map<string, TrackedTask>()
  /** Terminal-state tasks retained while live siblings remain, so a finished
   *  child of a fan-out renders settled instead of vanishing. Flushed the
   *  moment the live set empties — the strip exits exactly when it does today. */
  private readonly settled = new Map<string, AgentSessionBackgroundTask>()
  private readonly terminalTaskIds = new Set<string>()
  private aggregateRosterObserved = false
  private monitoring = false
  private publishedTasksFingerprint = ''

  constructor(private readonly now: () => number = () => Date.now()) {}

  get state(): AgentSessionBackgroundTaskState | null {
    if (!this.monitoring) {
      return null
    }
    return {
      state: 'monitoring',
      tasks: this.backgroundTaskDetails(),
      ...(this.settled.size > 0 ? { settledTasks: [...this.settled.values()] } : {})
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
    // Background work publishes through a foreground turn: the strip stays
    // honest mid-fan-out and the client alone decides when the idle-only
    // monitoring label may speak.
    if (message.type === 'system') {
      if (!this.observeSystemFrame(message) && !startsTurn) {
        return false
      }
    } else if (!startsTurn && message.type !== 'result') {
      return false
    }
    return this.refreshMonitoring()
  }

  clear(): boolean {
    this.tasks.clear()
    this.settled.clear()
    this.terminalTaskIds.clear()
    this.aggregateRosterObserved = false
    return this.refreshMonitoring()
  }

  private observeSystemFrame(message: Record<string, unknown>): boolean {
    if (message.subtype === 'background_tasks_changed') {
      this.replaceAggregateRoster(message.tasks)
      return true
    }
    const id = taskId(message)
    if (!id) {
      return false
    }
    if (message.subtype === 'task_notification') {
      // The notification is affirmative terminal evidence even when its status
      // field is unreadable — matching the liveness semantics this edge always had.
      this.settle(id, terminalClaudeTaskRunState(message.status) ?? 'done')
      return true
    }
    if (message.subtype === 'task_updated') {
      return this.observeTaskUpdated(id, message)
    }
    if (message.subtype !== 'task_started' || this.terminalTaskIds.has(id)) {
      return false
    }
    if (message.ambient === true || message.skip_transcript === true) {
      this.finish(id)
      return true
    }
    if (this.aggregateRosterObserved && !this.tasks.has(id)) {
      return false
    }
    const kind = classifyClaudeBackgroundTaskKind(message.task_type)
    this.upsert(id, {
      backgrounded: message.is_backgrounded === true || kind === 'workflow' || kind === 'monitor',
      kind,
      description: taskDescription(message.description),
      name: taskName(message),
      state: liveClaudeTaskRunState(message.status) ?? undefined,
      startedAt: this.now()
    })
    return true
  }

  private observeTaskUpdated(id: string, message: Record<string, unknown>): boolean {
    const patch = record(message.patch)
    if (!patch) {
      return false
    }
    const settledState = terminalClaudeTaskRunState(patch.status)
    if (settledState) {
      this.settle(id, settledState)
      return true
    }
    const existing = this.tasks.get(id)
    // Classification is re-derived per transition: a later frame that reveals a
    // real type moves the task between buckets instead of pinning first-seen.
    const patchKind =
      'task_type' in patch ? classifyClaudeBackgroundTaskKind(patch.task_type) : undefined
    const liveState = liveClaudeTaskRunState(patch.status)
    const hasContent =
      patch.is_backgrounded === true ||
      taskDescription(patch.description) !== undefined ||
      taskName(patch) !== undefined ||
      liveState !== null ||
      (patchKind !== undefined && patchKind !== 'unknown')
    if (hasContent && (!this.aggregateRosterObserved || existing)) {
      this.upsert(id, {
        backgrounded: patch.is_backgrounded === true || existing?.backgrounded === true,
        kind: patchKind ?? existing?.kind ?? 'unknown',
        description: taskDescription(patch.description),
        name: taskName(patch),
        state: liveState ?? undefined,
        startedAt: this.now()
      })
      return true
    }
    return false
  }

  private replaceAggregateRoster(value: unknown): void {
    if (!Array.isArray(value)) {
      return
    }
    const prior = new Map(this.tasks)
    this.aggregateRosterObserved = true
    this.tasks.clear()
    this.terminalTaskIds.clear()
    for (const valueTask of value) {
      if (this.tasks.size >= MAX_TRACKED_TASKS) {
        break
      }
      const task = record(valueTask)
      if (!task || task.ambient === true) {
        continue
      }
      const id = taskId(task)
      if (!id) {
        continue
      }
      const existing = prior.get(id)
      const kind = classifyClaudeBackgroundTaskKind(task.task_type)
      this.tasks.set(id, {
        backgrounded: true,
        kind: kind !== 'unknown' ? kind : (existing?.kind ?? 'unknown'),
        description: taskDescription(task.description) ?? existing?.description,
        name: taskName(task) ?? existing?.name,
        state: liveClaudeTaskRunState(task.status) ?? existing?.state,
        startedAt: existing?.startedAt ?? this.now()
      })
    }
  }

  private upsert(id: string, task: TrackedTask): void {
    const existing = this.tasks.get(id)
    if (existing) {
      this.tasks.set(id, {
        backgrounded: existing.backgrounded || task.backgrounded,
        kind: task.kind !== 'unknown' ? task.kind : existing.kind,
        description: task.description ?? existing.description,
        name: task.name ?? existing.name,
        state: task.state ?? existing.state,
        startedAt: existing.startedAt
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
    this.tasks.set(id, task)
  }

  private settle(id: string, state: AgentSessionBackgroundTaskRunState): void {
    const existing = this.tasks.get(id)
    if (existing?.backgrounded) {
      this.settled.delete(id)
      this.settled.set(id, { ...this.taskDetail(id, existing), state })
      if (this.settled.size > MAX_TRACKED_TASKS) {
        const oldest = this.settled.keys().next()
        if (!oldest.done) {
          this.settled.delete(oldest.value)
        }
      }
    }
    this.finish(id)
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
    if (details.length === 0 && this.settled.size > 0) {
      // Settled context only makes sense beside live work; the strip exits at
      // the same instant it always has — when the last live task ends.
      this.settled.clear()
    }
    const next = details.length > 0
    const fingerprint = next ? JSON.stringify([details, [...this.settled.values()]]) : ''
    if (next === this.monitoring && fingerprint === this.publishedTasksFingerprint) {
      return false
    }
    this.monitoring = next
    this.publishedTasksFingerprint = fingerprint
    return true
  }

  private taskDetail(id: string, task: TrackedTask): AgentSessionBackgroundTask {
    return {
      id,
      kind: task.kind,
      ...(task.description ? { description: task.description } : {}),
      ...(task.name ? { name: task.name } : {}),
      state: task.state ?? (task.kind === 'monitor' ? 'monitoring' : 'working'),
      startedAt: task.startedAt
    }
  }

  private backgroundTaskDetails(): AgentSessionBackgroundTask[] {
    const details: AgentSessionBackgroundTask[] = []
    for (const [id, task] of this.tasks) {
      if (!task.backgrounded) {
        continue
      }
      details.push(this.taskDetail(id, task))
    }
    return details
  }
}
