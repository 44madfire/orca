// The background-tasks strip's view of one session's wire state.
//
// The strip reports work that is IN FLIGHT, whether or not a turn is open and
// whether or not it was backgrounded: a fan-out of subagents is running work
// and the strip says so while it runs. Turn state is not a filter here — the
// producers publish only tasks they still have live evidence for.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../../../shared/agent-session-wire'

export type StructuredSessionBackgroundTasksView = {
  isMonitoringBackgroundTasks: boolean
  backgroundTasks: readonly AgentSessionBackgroundTask[]
  supportsBackgroundTaskStop: boolean
  supportsBackgroundTaskStopAll: boolean
}

export function structuredSessionBackgroundTasksView(
  state: AgentSessionBackgroundTaskState | null | undefined
): StructuredSessionBackgroundTasksView {
  return {
    isMonitoringBackgroundTasks: state?.state === 'monitoring',
    backgroundTasks: state?.tasks ?? [],
    supportsBackgroundTaskStop: state?.supportsTaskStop === true,
    // Absent means the host predates the field and does accept an untargeted
    // stop; only a host that says `false` has none to offer.
    supportsBackgroundTaskStopAll: state?.supportsStopAll !== false
  }
}
