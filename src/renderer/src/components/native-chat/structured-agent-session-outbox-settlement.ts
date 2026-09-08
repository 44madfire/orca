import type { StructuredAgentSessionOutboxEntry as Entry } from '../../../../shared/structured-agent-session-outbox'

export type OutboxSettlement = 'accepted' | 'blocked' | 'discarded' | 'unavailable'
type Observation = {
  promise: Promise<OutboxSettlement>
  resolve: (result: OutboxSettlement) => void
}
const handles = new WeakMap<Entry, Observation>()
// Only unresolved staged operations are indexed; terminal outcomes remove their group.
const pending = new Map<string, Map<string, Set<Observation>>>()

function operationKey(entry: Entry): string {
  return JSON.stringify([entry.sessionId, entry.clientMessageId, entry.deliveryIncarnation ?? 0])
}

// Results live with producer handles, never in a growing receipt history.
export function retainOutboxSettlement(entry: Entry): void {
  const observation = Promise.withResolvers<OutboxSettlement>()
  handles.set(entry, observation)
  const key = operationKey(entry)
  const session = pending.get(entry.sessionId) ?? new Map<string, Set<Observation>>()
  const group = session.get(key) ?? new Set<Observation>()
  group.add(observation)
  session.set(key, group)
  pending.set(entry.sessionId, session)
}

export function bindOutboxSettlement(source: Entry, handle: Entry): void {
  const observation = handles.get(source)
  if (observation) {
    handles.set(handle, observation)
  }
}

export function observeOutboxSettlement(entry: Entry): Promise<OutboxSettlement> {
  // A reconstructed handle has no receipt; missing queue state cannot prove acceptance.
  return handles.get(entry)?.promise ?? Promise.resolve('unavailable')
}

export function settleOutboxObservation(entry: Entry, result: OutboxSettlement): void {
  const key = operationKey(entry)
  const session = pending.get(entry.sessionId)
  const group = session?.get(key)
  session?.delete(key)
  if (!session?.size) {
    pending.delete(entry.sessionId)
  }
  for (const observation of group ?? []) {
    observation.resolve(result)
  }
}

export function publishOutboxSettlements(
  previous: Entry[],
  next: Entry[],
  accepted: readonly Entry[]
): void {
  const acceptedKeys = new Set(accepted.map(operationKey))
  const current = new Map(next.map((entry) => [operationKey(entry), entry]))
  for (const entry of previous) {
    const successor = current.get(operationKey(entry))
    if (!successor && acceptedKeys.has(operationKey(entry))) {
      settleOutboxObservation(entry, 'accepted')
    } else if (!successor) {
      settleOutboxObservation(entry, 'discarded')
    } else if (successor.dispatchBlocked) {
      settleOutboxObservation(entry, 'blocked')
    }
  }
}

export function settleUnavailableOutboxSession(sessionId: string): void {
  const session = pending.get(sessionId)
  pending.delete(sessionId)
  for (const group of session?.values() ?? []) {
    for (const observation of group) {
      observation.resolve('unavailable')
    }
  }
}
