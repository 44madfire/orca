import type { StructuredAgentSessionOutboxEntry as Entry } from '../../../../shared/structured-agent-session-outbox'
import {
  publishOutboxSettlements,
  settleOutboxObservation
} from './structured-agent-session-outbox-settlement'
import { readOutbox, writeOutbox } from './structured-agent-session-outbox-storage'

// The desktop main renderer owns this storage partition; popouts use a separate partition.
// Synchronous read/transition/write serializes all pane and launch writers without holding an RPC lock.
export function transitionOutbox(
  sessionId: string,
  update: (entries: Entry[]) => Entry[],
  accepted: readonly Entry[] = []
): { ok: boolean; entries: Entry[] } {
  const current = readOutbox(sessionId, false)
  const next = update(current)
  if (next.length === current.length && next.every((entry, index) => entry === current[index])) {
    return { ok: true, entries: current }
  }
  const previousById = new Map(current.map((entry) => [entry.clientMessageId, entry]))
  const stamped = next.map((entry) => {
    const previous = previousById.get(entry.clientMessageId)
    return entry === previous
      ? entry
      : {
          ...entry,
          transitionRevision: (previous?.transitionRevision ?? 0) + 1
        }
  })
  const ok = writeOutbox(sessionId, stamped, () => {
    const retained = new Set(stamped.map(claimKey))
    for (const entry of current) {
      if (!retained.has(claimKey(entry))) {
        activeClaims.delete(claimKey(entry))
      }
    }
    publishOutboxSettlements(current, stamped, accepted)
  })
  if (!ok) {
    const successors = new Map(next.map((entry) => [claimKey(entry), entry]))
    for (const entry of current) {
      if (successors.get(claimKey(entry)) !== entry) {
        settleOutboxObservation(entry, 'unavailable')
      }
    }
  }
  return { ok, entries: ok ? stamped : current }
}

export function transitionOutboxEntry(
  expected: Entry,
  update: (entry: Entry) => Entry | null,
  accepted = false
): { ok: boolean; changed: boolean; entry: Entry | undefined } {
  let changed = false
  const result = transitionOutbox(
    expected.sessionId,
    (entries) =>
      entries.flatMap((current) => {
        if (
          current.clientMessageId !== expected.clientMessageId ||
          current.deliveryIncarnation !== expected.deliveryIncarnation ||
          (!accepted && current.transitionRevision !== expected.transitionRevision)
        ) {
          return [current]
        }
        const next = update(current)
        changed = next !== current
        return next ? [next] : []
      }),
    accepted ? [expected] : []
  )
  return {
    ok: result.ok,
    changed: changed && result.ok,
    entry: result.entries.find((entry) => entry.clientMessageId === expected.clientMessageId)
  }
}

const activeClaims = new Map<string, Set<number | undefined>>()
function claimKey(entry: Entry): string {
  return JSON.stringify([entry.sessionId, entry.clientMessageId, entry.deliveryIncarnation ?? 0])
}
export function hasOutboxDispatch(entry: Entry): boolean {
  return activeClaims.get(claimKey(entry))?.has(entry.transitionRevision) ?? false
}
export function forgetOutboxDispatch(entry: Entry): void {
  const key = claimKey(entry)
  const group = activeClaims.get(key)
  group?.delete(entry.transitionRevision)
  if (!group?.size) {
    activeClaims.delete(key)
  }
}
export function claimOutboxDispatch(entry: Entry) {
  if (readOutbox(entry.sessionId, false)[0]?.clientMessageId !== entry.clientMessageId) {
    return { ok: true, changed: false, entry: undefined }
  }
  let pendingClaim: Entry | undefined
  const result = transitionOutboxEntry(entry, (current) => {
    if (current.state !== 'queued' || current.dispatchBlocked) {
      return current
    }
    const claim: Entry = {
      ...current,
      state: 'dispatching',
      lastAttemptAt: Date.now(),
      transitionRevision: (current.transitionRevision ?? 0) + 1
    }
    // Publish live ownership before storage subscribers can attempt orphan recovery.
    const key = claimKey(claim)
    const group = activeClaims.get(key) ?? new Set<number | undefined>()
    group.add(claim.transitionRevision)
    activeClaims.set(key, group)
    pendingClaim = claim
    return claim
  })
  if (!result.changed && pendingClaim) {
    forgetOutboxDispatch(pendingClaim)
  }
  return result
}

function uncertainDispatch(entry: Entry): Entry {
  return {
    ...entry,
    state: 'unconfirmed',
    recovery: entry.recovery ?? { attempts: 0, nextProbeAt: null, parkedReason: null }
  }
}

export function releaseOutboxDispatch(entry: Entry): void {
  forgetOutboxDispatch(entry)
  transitionOutboxEntry(entry, uncertainDispatch)
}

export function recoverOutboxDispatches(sessionId: string) {
  return transitionOutbox(sessionId, (entries) =>
    entries.map((entry) =>
      entry.state === 'dispatching' && !hasOutboxDispatch(entry) ? uncertainDispatch(entry) : entry
    )
  )
}
