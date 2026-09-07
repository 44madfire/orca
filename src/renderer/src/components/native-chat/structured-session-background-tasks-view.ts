import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskState
} from '../../../../shared/agent-session-wire'

export type StructuredSessionBackgroundTasksView = {
  /** The strip renders whenever the host reports monitoring — mid-turn included. */
  show: boolean
  /** Idle-only: gates the animated monitoring indicator and conversation
   *  commands, never the strip itself. A running turn owns the voice. */
  isMonitoring: boolean
  tasks: AgentSessionBackgroundTask[]
  settledTasks: AgentSessionBackgroundTask[]
  supportsStop: boolean
}

export function structuredSessionBackgroundTasksView(
  backgroundTasks: AgentSessionBackgroundTaskState | null | undefined,
  turnId: string | null
): StructuredSessionBackgroundTasksView {
  const monitoring = backgroundTasks?.state === 'monitoring'
  return {
    show: monitoring,
    isMonitoring: turnId === null && monitoring,
    tasks: backgroundTasks?.tasks ?? [],
    settledTasks: backgroundTasks?.settledTasks ?? [],
    supportsStop: backgroundTasks?.supportsTaskStop === true
  }
}
