import { useCallback, useEffect, useState, type MutableRefObject } from 'react'
import type { StructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import {
  advanceStructuredAgentSessionRecovery,
  resumeStructuredAgentSessionRecovery
} from '../../../../shared/structured-agent-session-recovery'
import { writeOutbox } from './structured-agent-session-outbox-storage'

export function useStructuredAgentSessionRecovery(args: {
  sessionId: string
  fence: number | null
  targetKey: string
  head: StructuredAgentSessionOutboxEntry | undefined
  hostObserved: boolean
  outboxRef: MutableRefObject<StructuredAgentSessionOutboxEntry[]>
  setOutbox: (entries: StructuredAgentSessionOutboxEntry[]) => void
  setError: (error: string | null) => void
}) {
  const { sessionId, fence, targetKey, head, hostObserved, outboxRef, setOutbox, setError } = args
  const [storageBlockedId, setStorageBlockedId] = useState<string | null>(null)
  const commit = useCallback(
    (entry: StructuredAgentSessionOutboxEntry): boolean => {
      const next = outboxRef.current.map((current) =>
        current.clientMessageId === entry.clientMessageId ? entry : current
      )
      if (!writeOutbox(sessionId, next)) {
        setStorageBlockedId(entry.clientMessageId)
        setError('Message could not be saved to the outbox')
        return false
      }
      outboxRef.current = next
      setOutbox(next)
      return true
    },
    [outboxRef, sessionId, setError, setOutbox]
  )

  useEffect(() => {
    if (
      !head ||
      head.sessionId !== sessionId ||
      hostObserved ||
      fence === null ||
      head.clientMessageId === storageBlockedId
    ) {
      return
    }
    const next = advanceStructuredAgentSessionRecovery(head, Date.now())
    // Reserve the budget and deadline durably before any timer can dispatch it.
    if (next !== head && !commit(next)) {
      return
    }
    if (
      next.state !== 'unconfirmed' ||
      next.retryAfterUnknownSubmittedAt !== null ||
      next.recovery?.nextProbeAt == null ||
      next.recovery.parkedReason
    ) {
      return
    }
    const timer = setTimeout(
      () => {
        if (outboxRef.current[0] !== next) {
          return
        }
        commit(advanceStructuredAgentSessionRecovery(next, Date.now()))
      },
      Math.max(0, next.recovery.nextProbeAt - Date.now())
    )
    return () => clearTimeout(timer)
  }, [commit, fence, head, hostObserved, outboxRef, sessionId, storageBlockedId, targetKey])

  const resumeChecking = (clientMessageId: string): void => {
    const current = outboxRef.current[0]
    if (
      !current ||
      current.sessionId !== sessionId ||
      current.clientMessageId !== clientMessageId ||
      hostObserved
    ) {
      return
    }
    const next = resumeStructuredAgentSessionRecovery(current)
    if (next !== current && commit(next)) {
      setStorageBlockedId(null)
      setError(null)
    }
  }
  const recoveryPaused =
    head?.state === 'unconfirmed' &&
    head.retryAfterUnknownSubmittedAt === null &&
    !hostObserved &&
    (head.recovery?.parkedReason === 'budget-exhausted' ||
      storageBlockedId === head.clientMessageId)
  return { resumeChecking, recoveryPaused }
}
