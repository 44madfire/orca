import { translate } from '@/i18n/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentSessionMutationResult,
  AgentSessionWireRefusal
} from '../../../../shared/agent-session-wire'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { agentSessionRefusalOperationState } from '../../../../shared/agent-session-refusal-retry'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { structuredSessionOperationId } from './use-structured-agent-session-outbox'
import * as conversationCommands from './structured-conversation-command-send'

export function useStructuredAgentSessionMutation(
  sessionId: string,
  target: RuntimeClientTarget,
  fence: number | null
) {
  const stateRef = useRef({ fence })
  const [writeError, setWriteError] = useState<string | null>(null)
  const operationIds = useRef(new Map<string, string>())
  useEffect(() => {
    stateRef.current = { fence }
  }, [fence])
  const mutate = useCallback(
    async <T>(
      method: string,
      fingerprintMethod: string,
      fields: Record<string, unknown>,
      operationIdOverride?: string | null,
      onFailure?: (refusal?: AgentSessionWireRefusal) => void
    ): Promise<T | null> => {
      if (stateRef.current.fence === null) {
        return null
      }
      const targetFence = stateRef.current.fence
      const key = `${sessionId}:${fingerprintMethod}:${JSON.stringify(fields)}`
      const clientOperationId =
        operationIdOverride ?? operationIds.current.get(key) ?? structuredSessionOperationId()
      operationIds.current.set(key, clientOperationId)
      let result: AgentSessionMutationResult<T>
      try {
        result = await callStructuredAgentSession<AgentSessionMutationResult<T>>(target, method, {
          envelope: {
            sessionId,
            clientOperationId,
            expectedRuntimeFence: targetFence,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: fingerprintMethod,
              sessionId,
              fields
            })
          },
          ...fields
        })
      } catch (error) {
        if (onFailure) {
          onFailure(
            hasRuntimeRpcErrorCode(error, 'method_not_found')
              ? {
                  code: 'structured_agent_session_unsupported',
                  message: '',
                  rewindReason: 'unsupported'
                }
              : undefined
          )
        } else if (stateRef.current.fence === targetFence) {
          setWriteError(
            error instanceof Error
              ? error.message
              : translate('components.native-chat.requestNotSent', 'Request was not sent')
          )
        }
        return null
      }
      if (!result.ok) {
        if (
          agentSessionRefusalOperationState(fingerprintMethod, result.refusal.code) ===
          'settled-rejected'
        ) {
          operationIds.current.delete(key)
        }
        if (onFailure) {
          onFailure(result.refusal)
        } else if (stateRef.current.fence === targetFence) {
          setWriteError(result.refusal.message)
        }
        return null
      }
      if (stateRef.current.fence !== targetFence && fingerprintMethod !== 'agentSession.rewind') {
        return null
      }
      if (!conversationCommands.isUnconfirmedConversationCommand(fingerprintMethod, result.value)) {
        operationIds.current.delete(key)
      }
      setWriteError(null)
      return result.value
    },
    [sessionId, target]
  )

  return { mutate, writeError }
}
