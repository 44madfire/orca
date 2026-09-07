// Grouping, naming, and header derivation for the background-tasks strip.
// Pure functions over the wire roster so every header variant is unit-testable
// without mounting the strip.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../../../shared/agent-session-wire'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import { translate } from '@/i18n/i18n'

type TaskKind = AgentSessionBackgroundTask['kind']
type RunState = AgentSessionBackgroundTaskRunState

export type BackgroundRosterTask = {
  task: AgentSessionBackgroundTask
  settled: boolean
  state: RunState
  name: string
}

export type BackgroundTaskGroup = { kind: TaskKind; tasks: BackgroundRosterTask[] }

/** Fixed presentation order; groups render only when non-empty. */
const KIND_ORDER: readonly TaskKind[] = ['agent', 'command', 'monitor', 'workflow', 'unknown']

/** Provider strings that carry no identity; a row falls through to its kind label. */
const PLACEHOLDER_NAMES = new Set(['unknown', 'untitled', 'task', 'subagent'])

function usableTaskText(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) {
    return null
  }
  return trimmed
}

export function backgroundTaskKindLabel(kind: TaskKind): string {
  switch (kind) {
    case 'agent':
      return translate('components.native-chat.backgroundTasks.agent', 'Background agent')
    case 'workflow':
      return translate('components.native-chat.backgroundTasks.workflow', 'Background workflow')
    case 'command':
      return translate('components.native-chat.backgroundTasks.command', 'Background command')
    case 'monitor':
      return translate('components.native-chat.backgroundTasks.monitor', 'Background monitor')
    case 'unknown':
      return translate('components.native-chat.backgroundTasks.task', 'Background task')
  }
}

/** Display name: description → name → kind label. Empty-after-trim and
 *  placeholder values fall through, so a row always renders something. */
export function resolveBackgroundTaskName(task: AgentSessionBackgroundTask): string {
  return (
    usableTaskText(task.description) ??
    usableTaskText(task.name) ??
    backgroundTaskKindLabel(task.kind)
  )
}

function effectiveState(task: AgentSessionBackgroundTask, settled: boolean): RunState {
  if (task.state) {
    return task.state
  }
  if (settled) {
    return 'done'
  }
  return task.kind === 'monitor' ? 'monitoring' : 'working'
}

/** Merge live and settled tasks into kind groups, stable-sorted first-seen
 *  (startedAt) then id, so a live update never reshuffles surviving rows. */
export function buildBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[]
): BackgroundTaskGroup[] {
  const entries: BackgroundRosterTask[] = [
    ...tasks.map((task) => ({
      task,
      settled: false,
      state: effectiveState(task, false),
      name: resolveBackgroundTaskName(task)
    })),
    ...settledTasks.map((task) => ({
      task,
      settled: true,
      state: effectiveState(task, true),
      name: resolveBackgroundTaskName(task)
    }))
  ]
  entries.sort((left, right) => {
    const startDelta = (left.task.startedAt ?? 0) - (right.task.startedAt ?? 0)
    return startDelta !== 0 ? startDelta : left.task.id < right.task.id ? -1 : 1
  })
  return KIND_ORDER.map((kind) => ({
    kind,
    tasks: entries.filter((entry) => entry.task.kind === kind)
  })).filter((group) => group.tasks.length > 0)
}

function kindCountLabel(kind: TaskKind, count: number): string {
  const value = { value0: count }
  switch (kind) {
    case 'agent':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countAgentsOne', '1 agent')
        : translate(
            'components.native-chat.backgroundTasks.countAgentsMany',
            '{{value0}} agents',
            value
          )
    case 'command':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countShellOne', '1 shell')
        : translate(
            'components.native-chat.backgroundTasks.countShellMany',
            '{{value0}} shells',
            value
          )
    case 'monitor':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countMonitorsOne', '1 monitor')
        : translate(
            'components.native-chat.backgroundTasks.countMonitorsMany',
            '{{value0}} monitors',
            value
          )
    case 'workflow':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countWorkflowsOne', '1 workflow')
        : translate(
            'components.native-chat.backgroundTasks.countWorkflowsMany',
            '{{value0}} workflows',
            value
          )
    case 'unknown':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countTasksOne', '1 task')
        : translate(
            'components.native-chat.backgroundTasks.countTasksMany',
            '{{value0}} tasks',
            value
          )
  }
}

export function backgroundTaskStateWord(state: RunState): string {
  switch (state) {
    case 'working':
      return translate('components.native-chat.backgroundTasks.stateWorking', 'working')
    case 'monitoring':
      return translate('components.native-chat.backgroundTasks.stateMonitoring', 'monitoring')
    case 'waiting':
      return translate('components.native-chat.backgroundTasks.stateWaiting', 'waiting')
    case 'blocked':
      return translate('components.native-chat.backgroundTasks.stateBlocked', 'blocked')
    case 'done':
      return translate('components.native-chat.backgroundTasks.stateDone', 'done')
    case 'idle':
      return translate('components.native-chat.backgroundTasks.stateIdle', 'stopped')
    case 'unverifiable':
      return translate('components.native-chat.backgroundTasks.stateUnverifiable', 'unverifiable')
  }
}

/** The reason line for an attention state, per the signed-off mock. */
export function backgroundTaskStateReason(state: RunState): string | null {
  switch (state) {
    case 'waiting':
      return translate('components.native-chat.backgroundTasks.reasonWaiting', 'needs approval')
    case 'unverifiable':
      return translate('components.native-chat.backgroundTasks.reasonUnverifiable', 'no contact')
    case 'blocked':
      return translate('components.native-chat.backgroundTasks.reasonBlocked', 'failed')
    case 'working':
    case 'monitoring':
    case 'done':
    case 'idle':
      return null
  }
}

/** Compact token meta per the mock ("18.2k"). Locale-neutral on purpose:
 *  it sits in a mono meta slot beside elapsed, like other technical literals. */
export function formatBackgroundTaskTokens(totalTokens: number): string {
  if (totalTokens < 1_000) {
    return String(totalTokens)
  }
  const scaled = totalTokens < 1_000_000 ? totalTokens / 1_000 : totalTokens / 1_000_000
  const unit = totalTokens < 1_000_000 ? 'k' : 'm'
  const rounded = Math.round(scaled * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${unit}`
}

export function backgroundTaskElapsedLabel(
  task: AgentSessionBackgroundTask,
  now: number
): string | null {
  if (task.startedAt === undefined || task.startedAt <= 0) {
    return null
  }
  return formatNativeChatDuration((now - task.startedAt) / 1000)
}

/** Header dot: lost contact outranks running work; a mixed-kind strip keeps
 *  the aggregate monitoring identity; a single kind reports its liveliest state. */
export function backgroundTasksDotState(groups: readonly BackgroundTaskGroup[]): RunState {
  const states = groups.flatMap((group) => group.tasks.map((entry) => entry.state))
  if (states.some((state) => state === 'unverifiable')) {
    return 'unverifiable'
  }
  if (groups.length !== 1) {
    return 'monitoring'
  }
  for (const state of ['working', 'waiting', 'blocked', 'monitoring', 'idle'] as const) {
    if (states.includes(state)) {
      return state
    }
  }
  return 'done'
}

/** How many kind segments the header may enumerate before an honest total
 *  replaces the breakdown entirely — never a partial enumeration. */
const HEADER_SEGMENT_CAP = 3

const HEADER_STATE_ORDER: readonly RunState[] = [
  'working',
  'monitoring',
  'waiting',
  'blocked',
  'unverifiable',
  'idle'
]

const ATTENTION_STATES: ReadonlySet<RunState> = new Set(['waiting', 'unverifiable', 'blocked'])

export type BackgroundTasksHeaderContent = {
  /** Emphasised segments, joined with a muted separator by the renderer. */
  segments: string[]
  /** Muted " — …" tail; null when the segments say everything. */
  detail: string | null
}

/** Every variant in the signed-off mock, plus the overflow and narrow forms.
 *  Any lossy form (fallback or total) leaves the detail reachable — the strip
 *  stays expandable regardless of task count. */
export function backgroundTasksHeaderContent(
  groups: readonly BackgroundTaskGroup[],
  options: { narrow: boolean; now: number }
): BackgroundTasksHeaderContent {
  const all = groups.flatMap((group) => group.tasks)
  if (all.length === 0) {
    return {
      segments: [],
      detail: translate(
        'components.native-chat.backgroundTasks.monitoring',
        'Monitoring background tasks'
      )
    }
  }
  if (groups.length > HEADER_SEGMENT_CAP || (options.narrow && all.length > 1)) {
    return {
      segments: [
        translate(
          'components.native-chat.backgroundTasks.headerTotal',
          '{{value0}} background tasks',
          {
            value0: all.length
          }
        )
      ],
      detail: null
    }
  }
  if (groups.length > 1) {
    return {
      segments: groups.map((group) => kindCountLabel(group.kind, group.tasks.length)),
      detail: null
    }
  }
  const group = groups[0]
  const count = group.tasks.length
  const uniformState = group.tasks.every((entry) => entry.state === group.tasks[0].state)
    ? group.tasks[0].state
    : null
  if (uniformState && ATTENTION_STATES.has(uniformState)) {
    return {
      segments: [`${kindCountLabel(group.kind, count)} ${backgroundTaskStateWord(uniformState)}`],
      detail: backgroundTaskStateReason(uniformState)
    }
  }
  if (count === 1) {
    const entry = group.tasks[0]
    const subject =
      group.kind === 'command'
        ? translate(
            'components.native-chat.backgroundTasks.countShellCommandOne',
            '1 shell command'
          )
        : kindCountLabel(group.kind, 1)
    const elapsed =
      group.kind === 'command' ? backgroundTaskElapsedLabel(entry.task, options.now) : null
    return { segments: [subject], detail: elapsed ?? backgroundTaskStateWord(entry.state) }
  }
  const stateCounts = HEADER_STATE_ORDER.map((state) => ({
    state,
    count: group.tasks.filter((entry) => entry.state === state).length
  })).filter((entry) => entry.count > 0)
  return {
    segments: [kindCountLabel(group.kind, count)],
    // Done produces no segment: a finished sibling earns no colour above the composer.
    detail:
      stateCounts.length > 0
        ? stateCounts
            .map((entry) => `${entry.count} ${backgroundTaskStateWord(entry.state)}`)
            .join(', ')
        : null
  }
}

export function backgroundTaskGroupLabel(kind: TaskKind): string {
  switch (kind) {
    case 'agent':
      return translate('components.native-chat.backgroundTasks.groupAgents', 'Agents')
    case 'command':
      return translate('components.native-chat.backgroundTasks.groupShell', 'Shell')
    case 'monitor':
      return translate('components.native-chat.backgroundTasks.groupMonitors', 'Monitors')
    case 'workflow':
      return translate('components.native-chat.backgroundTasks.groupWorkflows', 'Workflows')
    case 'unknown':
      return translate('components.native-chat.backgroundTasks.groupTasks', 'Tasks')
  }
}
