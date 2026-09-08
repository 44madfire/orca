/**
 * A relay PTY id carries the mint epoch of the relay process that allocated it, so a client can
 * tell the two halves of "this relay does not list that id" apart: the relay minted it and no
 * longer has it, which is an exit the host observed, versus the relay never had it, which is every
 * id minted before a restart and is evidence of nothing (docs/reference/ssh-execution-boundary.md).
 *
 * The id shape lives here so the relay that mints and the client that reads it cannot drift.
 */
const MINT_EPOCH_PTY_ID_PREFIX = 'pty2:'

export function toRelayPtyIdWithMintEpoch(mintEpoch: string, sequence: number): string {
  return `${MINT_EPOCH_PTY_ID_PREFIX}${encodeURIComponent(mintEpoch)}:${sequence}`
}

/** Null for a legacy `pty-N` id, which names no epoch and so can never certify an exit. */
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
