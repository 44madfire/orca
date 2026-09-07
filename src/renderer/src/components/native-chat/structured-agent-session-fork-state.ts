import type { StructuredAgentSessionState } from '../../../../shared/structured-agent-session-reducer'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'

export type StructuredSessionConversationSupport = {
  sessionId: string
  commands: readonly AgentSessionConversationCommand[]
  forkSupported?: boolean
}

export function structuredSessionForkState(
  state: StructuredAgentSessionState,
  sessionId: string,
  support: StructuredSessionConversationSupport | null
) {
  return {
    forkSupported: support?.sessionId === sessionId && support.forkSupported === true,
    journalItems: state.items,
    forkSource:
      state.fence !== null && state.cursor
        ? { sessionId, expectedRuntimeFence: state.fence, expectedEpoch: state.cursor.epoch }
        : null
  }
}
