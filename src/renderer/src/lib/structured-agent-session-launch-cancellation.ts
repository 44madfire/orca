import type { AgentSessionHandleProvider } from '../../../shared/agent-session-provider-handle'
import {
  abandonStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import {
  readOutboxEvidence,
  subscribeOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import { transitionOutbox } from '@/components/native-chat/structured-agent-session-outbox-transitions'
import type { StructuredAgentSessionOutboxEntry } from '../../../shared/structured-agent-session-outbox'

type CancellationObligation = {
  intent: Pick<StructuredAgentSessionLaunchIntent, 'sessionId' | 'worktreeId' | 'agent'>
  incarnations: Set<string> | null
  detach: () => void
  retryQueued: boolean
  retrying: boolean
}

// Cancellation owns persistence independently of terminal delivery receipts and launch callers.
const cancellations = new Map<string, CancellationObligation>()
const listeners = new Set<() => void>()

export function structuredLaunchCancellationKey(entry: StructuredAgentSessionOutboxEntry): string {
  return JSON.stringify([entry.clientMessageId, entry.deliveryIncarnation ?? 0])
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeStructuredLaunchCancellation(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function hasStructuredLaunchCancellation(
  worktreeId: string,
  agent: AgentSessionHandleProvider
): boolean {
  return [...cancellations.values()].some(
    ({ intent }) => intent.worktreeId === worktreeId && intent.agent === agent
  )
}

function retryCancellation(obligation: CancellationObligation): boolean {
  const { intent, incarnations } = obligation
  if (cancellations.get(intent.sessionId) !== obligation || obligation.retrying) {
    return false
  }
  obligation.retrying = true
  const result = transitionOutbox(intent.sessionId, (entries) =>
    incarnations === null
      ? entries
      : entries.filter((entry) => !incarnations.has(structuredLaunchCancellationKey(entry)))
  )
  obligation.retrying = false
  if (!result.ok || (incarnations === null && result.entries.length > 0)) {
    return false
  }
  cancellations.delete(intent.sessionId)
  obligation.detach()
  incarnations?.clear()
  abandonStructuredAgentSessionLaunchIntent(intent)
  notify()
  return true
}

export function retryStructuredLaunchCancellation(
  worktreeId: string,
  sessionId: string
): boolean | undefined {
  const obligation = cancellations.get(sessionId)
  return obligation?.intent.worktreeId === worktreeId ? retryCancellation(obligation) : undefined
}

export function persistStructuredLaunchCancellation(
  intent: Pick<StructuredAgentSessionLaunchIntent, 'sessionId' | 'worktreeId' | 'agent'>,
  captured: Set<string> | null = null
): boolean {
  const existing = cancellations.get(intent.sessionId)
  if (existing) {
    return retryCancellation(existing)
  }
  const read = readOutboxEvidence(intent.sessionId, false)
  const obligation: CancellationObligation = {
    intent: { sessionId: intent.sessionId, worktreeId: intent.worktreeId, agent: intent.agent },
    incarnations:
      captured ??
      (read.status === 'readable'
        ? new Set(read.entries.map(structuredLaunchCancellationKey))
        : null),
    detach: () => {},
    retryQueued: false,
    retrying: false
  }
  cancellations.set(intent.sessionId, obligation)
  obligation.detach = subscribeOutbox(intent.sessionId, () => {
    if (obligation.retryQueued) {
      return
    }
    obligation.retryQueued = true
    // Retry after publication, never recursively inside another owner's storage commit.
    queueMicrotask(() => {
      obligation.retryQueued = false
      retryCancellation(obligation)
    })
  })
  const persisted = retryCancellation(obligation)
  if (!persisted) {
    notify()
  }
  return persisted
}
