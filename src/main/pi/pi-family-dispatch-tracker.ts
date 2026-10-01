// Pi-family admitted-dispatch correlation (PIF-4, #25).
//
// Ephemeral pending-submission tracking keyed by Orca session: armed before
// the RPC write (Codex ordering) so a boundary frame landing in the same
// stdout read as the ack is never missed, disarmed only on definite refusal.
// Never a durable outbox; Orca's journal remains authoritative.

import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'

/**
 * Pre-dispatch cursor proof. Only a positively proven fresh session may treat
 * all entries as new; a failed or unverifiable read fails closed (unknown)
 * so settlement can never adopt an unrelated provider entry id.
 */
export type PiFamilyDispatchCursor =
  | { readonly status: 'fresh' }
  | { readonly status: 'known'; readonly leafId: string }
  | { readonly status: 'unknown' }

/** Ephemeral correlation for one admitted submission (never a durable outbox). */
export type PiFamilyPendingDispatch = {
  readonly clientMessageId: string
  readonly provider: PiFamilyProvider
  readonly generation: string
  readonly cursor: PiFamilyDispatchCursor
}

/** Admitted submissions awaiting history-backed settlement, keyed by Orca session. */
export class PiFamilyDispatchTracker {
  private readonly pending = new Map<string, PiFamilyPendingDispatch[]>()

  arm(sessionId: string, entry: PiFamilyPendingDispatch): void {
    const list = this.pending.get(sessionId) ?? []
    if (list.some((item) => item.clientMessageId === entry.clientMessageId)) {
      return
    }
    list.push(entry)
    this.pending.set(sessionId, list)
  }

  pendingFor(sessionId: string): PiFamilyPendingDispatch[] {
    return [...(this.pending.get(sessionId) ?? [])]
  }

  retainOnly(sessionId: string, entries: readonly PiFamilyPendingDispatch[]): void {
    if (entries.length === 0) {
      this.pending.delete(sessionId)
    } else {
      this.pending.set(sessionId, [...entries])
    }
  }

  /** Drop correlation for a definitely declined write (mirrors the Codex disarm). */
  disarm(sessionId: string, clientMessageId: string, generation: string): boolean {
    return this.claim(sessionId, clientMessageId, generation) !== null
  }

  claim(
    sessionId: string,
    clientMessageId: string,
    generation: string
  ): PiFamilyPendingDispatch | null {
    const list = this.pending.get(sessionId)
    if (!list) {
      return null
    }
    const index = list.findIndex(
      (item) => item.clientMessageId === clientMessageId && item.generation === generation
    )
    if (index === -1) {
      return null
    }
    const [claimed] = list.splice(index, 1)
    if (list.length === 0) {
      this.pending.delete(sessionId)
    }
    return claimed ?? null
  }

  dropSession(sessionId: string): void {
    this.pending.delete(sessionId)
  }
}
