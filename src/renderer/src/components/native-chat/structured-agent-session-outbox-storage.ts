import {
  parseStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'

const listeners = new Map<string, Set<(entries: StructuredAgentSessionOutboxEntry[]) => void>>()

export function subscribeOutbox(
  sessionId: string,
  listener: (entries: StructuredAgentSessionOutboxEntry[]) => void
): () => void {
  const group = listeners.get(sessionId) ?? new Set()
  listeners.set(sessionId, group)
  group.add(listener)
  return () => {
    group.delete(listener)
    if (!group.size) {
      listeners.delete(sessionId)
    }
  }
}

const OUTBOX_PREFIX = 'orca:desktopStructuredAgentSessionOutbox:v1:'

export function storageKey(sessionId: string): string {
  return `${OUTBOX_PREFIX}${encodeURIComponent(sessionId)}`
}

export type OutboxRead =
  | { status: 'readable'; entries: StructuredAgentSessionOutboxEntry[] }
  | { status: 'unavailable' | 'invalid' }

export function readOutboxEvidence(sessionId: string, recoverDispatching = true): OutboxRead {
  let raw: string | null
  try {
    raw = localStorage.getItem(storageKey(sessionId))
  } catch {
    return { status: 'unavailable' }
  }
  try {
    const value: unknown = JSON.parse(raw ?? '[]')
    if (!Array.isArray(value)) {
      return { status: 'invalid' }
    }
    const entries = value.map((entry) => parseStructuredAgentSessionOutboxEntry(entry, sessionId))
    if (entries.some((entry) => entry === null)) {
      return { status: 'invalid' }
    }
    return {
      status: 'readable',
      entries: (entries as StructuredAgentSessionOutboxEntry[])
        .map((entry) =>
          recoverDispatching && entry.state === 'dispatching'
            ? { ...entry, state: 'unconfirmed' as const }
            : entry
        )
        .sort((left, right) => left.queuedAt - right.queuedAt)
    }
  } catch {
    return { status: 'invalid' }
  }
}

// Presentation compatibility only; mutation and retirement require readable evidence.
export function readOutbox(
  sessionId: string,
  recoverDispatching = true
): StructuredAgentSessionOutboxEntry[] {
  const result = readOutboxEvidence(sessionId, recoverDispatching)
  return result.status === 'readable' ? result.entries : []
}

export function writeOutbox(
  sessionId: string,
  entries: readonly StructuredAgentSessionOutboxEntry[],
  onCommitted?: () => void
): boolean {
  try {
    if (entries.length === 0) {
      localStorage.removeItem(storageKey(sessionId))
    } else {
      localStorage.setItem(storageKey(sessionId), JSON.stringify(entries))
    }
    onCommitted?.()
    for (const listener of listeners.get(sessionId) ?? []) {
      listener(entries.slice())
    }
    return true
  } catch {
    return false
  }
}
