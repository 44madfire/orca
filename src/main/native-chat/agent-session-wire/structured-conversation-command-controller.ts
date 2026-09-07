import { sendStructuredAgentSessionTurn } from './structured-agent-session-host-mutations'
import {
  runStructuredConversationCommand,
  type ConversationCommandParams
} from './structured-conversation-command'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'

export class StructuredConversationCommandController {
  readonly pending = new Map<string, { key: string; count: number }>()
  constructor(
    private readonly context: () => StructuredAgentSessionMutationContext,
    private readonly host: Pick<StructuredAgentSessionHost, 'attach' | 'flushStreamedEvents'>
  ) {}
  send = (
    caller: StructuredAgentSessionCaller,
    params: Parameters<typeof sendStructuredAgentSessionTurn>[2]
  ): ReturnType<typeof sendStructuredAgentSessionTurn> =>
    this.pending.has(params.envelope.sessionId)
      ? Promise.resolve({
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            message: 'Wait for the conversation operation to finish.'
          }
        })
      : sendStructuredAgentSessionTurn(this.context(), caller, params)

  run = (caller: StructuredAgentSessionCaller, params: ConversationCommandParams) => {
    const key = JSON.stringify([caller.callerKey, params.envelope.clientOperationId])
    const pending = this.pending.get(params.envelope.sessionId)
    if (pending && pending.key !== key) {
      return Promise.resolve({
        ok: false as const,
        refusal: {
          code: 'agent_session_operation_invalid' as const,
          message: 'Wait for the conversation operation to finish.'
        }
      })
    }
    const entry = pending ?? { key, count: 0 }
    entry.count++
    this.pending.set(params.envelope.sessionId, entry)
    return runStructuredConversationCommand(this.context(), this.host, caller, params).finally(
      () => {
        if (--entry.count === 0 && this.pending.get(params.envelope.sessionId) === entry) {
          this.pending.delete(params.envelope.sessionId)
        }
      }
    )
  }

  replacements = () => {
    const store = this.context().deps.store
    const records = store.listRecords()
    const visible = new Set(store.listVisibleSessionIds())
    return records.flatMap((record) => {
      let command = record.conversationCommand
      let sessionId: string | undefined
      const visited = new Set([record.sessionId])
      while (
        command?.command === 'clear' &&
        command.phase === 'committed' &&
        command.replacementSessionId
      ) {
        sessionId = command.replacementSessionId
        if (visited.has(sessionId)) {
          return []
        }
        visited.add(sessionId)
        command = store.getRecord(sessionId)?.conversationCommand
      }
      // Explicit history reveals remain readable; closed replacements stay closed.
      return sessionId && visible.has(sessionId) && !visible.has(record.sessionId)
        ? [
            {
              sourceSessionId: record.sessionId,
              sessionId,
              workspaceId: record.location.workspaceId,
              agent: record.provider
            }
          ]
        : []
    })
  }
}
