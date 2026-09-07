import { parseRelayPtyMintEpoch } from '../../shared/relay-pty-mint-epoch'

type RelayRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<unknown>

const PROBE_TIMEOUT_MS = 10_000

/**
 * Whether the relay still owns this PTY, as an answer a caller may retire durable state on.
 *
 * `pty.listProcesses` is the relay's own live set: it reaps a torn-down record and re-probes a pid
 * before reporting, so a listed id is live. An unlisted id is only an exit when this relay is also
 * the one that minted it — after a restart the relay disowns every id the previous one allocated
 * without having checked anything, which is why absence alone was never evidence
 * (docs/reference/ssh-execution-boundary.md).
 *
 * Deliberately not `pty.attach`, the only refusal that carries the proven-exited marker: a
 * successful attach opens a delivery, retires the previous one, and restores retired pane surfaces,
 * so probing with it would disturb a live consumer in exactly the case where the answer is "live".
 *
 * Never throws. A transport failure, a disposed multiplexer, a timeout, a legacy `pty-N` id, and a
 * relay that names no mint epoch all answer null, because none of them observed the process.
 */
export async function probeSshPtyLiveness(args: {
  request: RelayRequest
  relayPtyId: string
}): Promise<boolean | null> {
  try {
    const listed = (await args.request(
      'pty.listProcesses',
      { includeForegroundProcessEvidence: false },
      { timeoutMs: PROBE_TIMEOUT_MS }
    )) as { id?: unknown }[] | null
    if (!Array.isArray(listed)) {
      return null
    }
    if (listed.some((session) => session.id === args.relayPtyId)) {
      return true
    }
    const mintEpoch = parseRelayPtyMintEpoch(args.relayPtyId)
    if (!mintEpoch) {
      return null
    }
    // Read after the listing on purpose: both answers come from one relay process, and a restart
    // between them breaks the multiplexer rather than pairing a new epoch with an old listing.
    const capabilities = (await args.request('pty.getCapabilities', undefined, {
      timeoutMs: PROBE_TIMEOUT_MS
    })) as { ptyIdMintEpoch?: unknown } | null
    const currentEpoch = capabilities?.ptyIdMintEpoch
    if (typeof currentEpoch !== 'string' || currentEpoch !== mintEpoch) {
      return null
    }
    return false
  } catch {
    return null
  }
}
