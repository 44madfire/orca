import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionCreateParams
} from '../../../../shared/structured-agent-session-create'
import type { AgentSessionForkSource } from '../../../../shared/agent-session-fork'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../../shared/agent-session-wire'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { translate } from '@/i18n/i18n'

const attempts = new Map<
  string,
  { params: StructuredAgentSessionCreateParams; running?: Promise<void> }
>()

export function forkStructuredSessionFromTurn(input: {
  target: RuntimeClientTarget
  worktree: string
  agent: 'claude' | 'codex'
  source: AgentSessionForkSource
}): Promise<void> {
  const key = JSON.stringify([
    input.target.kind === 'local' ? 'local' : input.target.environmentId,
    input.worktree,
    input.agent,
    input.source.sessionId,
    input.source.itemId,
    input.source.expectedEpoch,
    input.source.expectedRuntimeFence
  ])
  let attempt = attempts.get(key)
  if (attempt?.running) {
    return attempt.running
  }
  if (!attempt) {
    if (attempts.size >= 128) {
      return Promise.reject(
        new Error(
          translate(
            'components.native-chat.forkUnconfirmed',
            'A fork could not be confirmed. Retry the same turn to check its outcome.'
          )
        )
      )
    }
    attempt = {
      params: structuredAgentSessionCreateParams({
        sessionId: createStructuredAgentSessionId(input.agent, () => crypto.randomUUID()),
        worktree: input.worktree,
        agent: input.agent,
        forkFrom: input.source,
        randomUuid: () => crypto.randomUUID()
      })
    }
    attempts.set(key, attempt)
  }
  const current = attempt
  current.running = callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionAttachResult>
  >(input.target, 'agentSession.create', current.params)
    .then(
      (result) => {
        if (!result.ok) {
          if (
            result.refusal.forkReason &&
            result.refusal.forkReason !== 'outcome-unknown' &&
            result.refusal.forkReason !== 'proof-mismatch'
          ) {
            attempts.delete(key)
            throw new Error(
              translate(
                'components.native-chat.forkFailed',
                'Could not fork this turn. Wait for the conversation to finish and try again.'
              )
            )
          }
          throw new Error(
            translate(
              'components.native-chat.forkUnconfirmed',
              'A fork could not be confirmed. Retry the same turn to check its outcome.'
            )
          )
        }
        attempts.delete(key)
      },
      () => {
        throw new Error(
          translate(
            'components.native-chat.forkUnconfirmed',
            'A fork could not be confirmed. Retry the same turn to check its outcome.'
          )
        )
      }
    )
    .finally(() => {
      current.running = undefined
    })
  return current.running
}
