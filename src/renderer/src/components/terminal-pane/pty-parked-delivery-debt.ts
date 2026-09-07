/**
 * Ledger for the pty:data delivery credit held while bytes sit in the pre-handler buffer.
 *
 * Why hold it at all: ACKing bytes that no handler will ever consume made main's in-flight
 * window read empty for a pane rendering nothing. The delivery watchdog needs debt > 0 to
 * call a wedge, so it was blind by construction, and the producer was never paused — main
 * kept flooding a pane nobody could see. Holding the credit turns parked bytes into real
 * debt, which is what makes main's existing per-PTY window pause the shell, the watchdog
 * see the pane, and the write-off lane able to forgive it.

 *
 * Unit is delivery-credit CHARS (`rawLength ?? data.length`), never the buffer's UTF-8 byte
 * count: the two diverge on multi-byte output and main's accounting is in chars.
 */

export type ParkedPtyDeliveryDebt = {
  /** Idempotent — a second settle ACKs once and decrements the ledger once. */
  settle: () => void
}

type OpenParkedDebt = { settle: () => void }

const parkedCharsByPty = new Map<string, number>()
const openDebtsByPty = new Map<string, Set<OpenParkedDebt>>()

/** Park `chars` of credit for `ptyId`. `settleAck` is the open delivery credit claimed by the
 *  dispatcher; a null one means this surface keeps today's ACK-at-return behaviour. */
export function openParkedPtyDeliveryDebt(
  ptyId: string,
  chars: number,
  settleAck: (() => void) | null
): ParkedPtyDeliveryDebt | null {
  if (!settleAck) {
    return null
  }
  if (!Number.isFinite(chars) || chars <= 0) {
    settleAck()
    return null
  }
  parkedCharsByPty.set(ptyId, (parkedCharsByPty.get(ptyId) ?? 0) + chars)
  let settled = false
  const open: OpenParkedDebt = {
    settle: () => {
      if (settled) {
        return
      }
      settled = true
      const debts = openDebtsByPty.get(ptyId)
      if (debts) {
        debts.delete(open)
        if (debts.size === 0) {
          openDebtsByPty.delete(ptyId)
        }
      }
      const remaining = (parkedCharsByPty.get(ptyId) ?? 0) - chars
      if (remaining > 0) {
        parkedCharsByPty.set(ptyId, remaining)
      } else {
        parkedCharsByPty.delete(ptyId)
      }
      settleAck()
    }
  }
  let debts = openDebtsByPty.get(ptyId)
  if (!debts) {
    debts = new Set()
    openDebtsByPty.set(ptyId, debts)
  }
  debts.add(open)
  return { settle: open.settle }
}

/** Repay every credit a buffer state still holds. Safe to call twice, and on nothing. */
export function settleParkedPtyDeliveryDebts(
  state: { chunks: { debt?: ParkedPtyDeliveryDebt }[]; head: number } | undefined
): void {
  if (!state) {
    return
  }
  for (let index = state.head; index < state.chunks.length; index += 1) {
    state.chunks[index].debt?.settle()
  }
}

/** Repay every credit still held for one PTY while leaving its bytes buffered for a late
 *  bind. Main deletes a PTY's accounting on exit, so debt still held past that point can be
 *  repaid by no drain and forgiven by no write-off — it would pin the session's in-flight
 *  total until the window reloaded. */
export function settleParkedPtyDeliveryDebtsForPty(ptyId: string): void {
  const debts = openDebtsByPty.get(ptyId)
  if (!debts) {
    return
  }
  for (const debt of Array.from(debts)) {
    debt.settle()
  }
}

/** Chars parked per PTY — the discriminator main's write-off skip was missing: bytes with a
 *  consumer repay themselves, these have none. */
export function getParkedPreHandlerCharsByPty(): Record<string, number> {
  return Object.fromEntries(parkedCharsByPty)
}
