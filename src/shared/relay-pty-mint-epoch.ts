/**
 * A relay PTY id carries the mint epoch of the relay process that allocated it, so ids from
 * different generations of the same relay cannot collide. The shape lives here so the relay that
 * mints it and anything that reads it back cannot drift.
 *
 * The epoch certifies nothing on its own, and this relay no longer publishes it. Pairing it with
 * `pty.listProcesses` used to read an id's absence from a same-epoch listing as an exit, which is
 * unsound: the relay also removes a record it never watched end, so a shutdown that gave up waiting
 * for an uninterruptible child produced that same absence. Only the owner's exact-id
 * `pty.probeLiveness` answers whether a process ended (docs/reference/ssh-execution-boundary.md).
 */
const MINT_EPOCH_PTY_ID_PREFIX = 'pty2:'

export function toRelayPtyIdWithMintEpoch(mintEpoch: string, sequence: number): string {
  return `${MINT_EPOCH_PTY_ID_PREFIX}${encodeURIComponent(mintEpoch)}:${sequence}`
}

/** Null for a legacy `pty-N` id, which names no generation. */
export function parseRelayPtyMintEpoch(relayPtyId: string): string | null {
  if (!relayPtyId.startsWith(MINT_EPOCH_PTY_ID_PREFIX)) {
    return null
  }
  const remainder = relayPtyId.slice(MINT_EPOCH_PTY_ID_PREFIX.length)
  const sequenceSeparator = remainder.lastIndexOf(':')
  if (sequenceSeparator <= 0) {
    return null
  }
  try {
    return decodeURIComponent(remainder.slice(0, sequenceSeparator)) || null
  } catch {
    return null
  }
}
