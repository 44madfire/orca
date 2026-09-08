import type {
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import {
  requeueStructuredAgentSessionSendRefusal,
  structuredAgentSessionSendRequest,
  type StructuredAgentSessionOutboxEntry
} from '../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import {
  claimOutboxDispatch,
  forgetOutboxDispatch,
  transitionOutboxEntry
} from '@/components/native-chat/structured-agent-session-outbox-transitions'
import {
  observeOutboxSettlement,
  settleOutboxObservation
} from '@/components/native-chat/structured-agent-session-outbox-settlement'
import {
  readOutbox,
  subscribeOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'

export type StructuredPromptDeliveryResult = {
  delivered: boolean
  failureNotified: boolean
}

export type StructuredLaunchPromptOptions = {
  prompt?: string
  onPromptDelivered?: () => void
}

type LaunchReceipt = { sessionId: string; fence: number }

async function dispatchStructuredLaunchPrompt(
  entry: StructuredAgentSessionOutboxEntry,
  receipt: LaunchReceipt
): Promise<void> {
  const reservation = claimOutboxDispatch(entry)
  if (!reservation.changed || !reservation.entry) {
    return
  }
  const claim = reservation.entry
  try {
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionSendResult>
    >(
      { kind: 'local' },
      'agentSession.send',
      structuredAgentSessionSendRequest(entry, receipt.fence)
    )
    if (!result.ok) {
      transitionOutboxEntry(claim, (current) => ({
        ...requeueStructuredAgentSessionSendRefusal(current, result.refusal.code, () =>
          createStructuredAgentSessionOperationId(() => crypto.randomUUID())
        ),
        dispatchBlocked: true
      }))
      return
    }
    const dispatchState = result.value.submission.dispatchState
    transitionOutboxEntry(
      claim,
      (current) =>
        dispatchState === 'accepted'
          ? null
          : {
              ...current,
              dispatchBlocked: dispatchState === 'rejected',
              state:
                dispatchState === 'unknown' || dispatchState === 'pending'
                  ? 'unconfirmed'
                  : 'queued'
            },
      dispatchState === 'accepted'
    )
  } catch {
    transitionOutboxEntry(claim, (current) => ({ ...current, state: 'unconfirmed' }))
  } finally {
    forgetOutboxDispatch(claim)
  }
}

export function settleStructuredAgentLaunchPrompt(args: {
  launchResult: Promise<LaunchReceipt>
  options: StructuredLaunchPromptOptions
  stagedEntry: StructuredAgentSessionOutboxEntry | null
}): Promise<StructuredPromptDeliveryResult> | undefined {
  if (!args.options.prompt?.trim()) {
    return undefined
  }
  return args.launchResult
    .then(async (receipt) => {
      if (!args.stagedEntry) {
        return { delivered: false, failureNotified: true }
      }
      const settlement = observeOutboxSettlement(args.stagedEntry)
      const staged = args.stagedEntry
      const dispatch = () => {
        const head = readOutbox(staged.sessionId, false)[0]
        if (
          head?.clientMessageId === staged.clientMessageId &&
          head.deliveryIncarnation === staged.deliveryIncarnation
        ) {
          void dispatchStructuredLaunchPrompt(head, receipt)
        }
      }
      const detach = subscribeOutbox(staged.sessionId, dispatch)
      dispatch()
      const outcome = await settlement
      detach()
      const delivered = outcome === 'accepted'
      if (delivered) {
        args.options.onPromptDelivered?.()
      }
      return { delivered, failureNotified: false }
    })
    .catch((error: unknown) => {
      if (args.stagedEntry) {
        settleOutboxObservation(args.stagedEntry, 'unavailable')
      }
      throw error
    })
}
