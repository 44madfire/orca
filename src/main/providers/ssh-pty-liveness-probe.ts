type RelayRequest = (
  method: string,
  params?: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<unknown>

const PROBE_TIMEOUT_MS = 10_000

/**
 * Forwards the liveness question to the relay, which is the only party that can answer it.
 *
 * The client deliberately computes nothing here. A previous version inferred an exit from an id's
 * absence in `pty.listProcesses` plus a matching mint epoch, and that is unsound: the relay also
 * removes a record without observing the process end, so a shutdown that gave up waiting for an
 * uninterruptible child produced a false death certificate (docs/reference/ssh-execution-boundary.md).
 *
 * Never throws, and fails closed. A relay too old to know the method answers JSON-RPC -32601, which
 * arrives here as a rejection and maps to null, exactly like a timeout or a disposed multiplexer.
 * Any status other than the two the owner certifies is unverifiable.
 */
export async function probeSshPtyLiveness(args: {
  request: RelayRequest
  relayPtyId: string
}): Promise<boolean | null> {
  try {
    const answer = (await args.request(
      'pty.probeLiveness',
      { id: args.relayPtyId },
      { timeoutMs: PROBE_TIMEOUT_MS }
    )) as { status?: unknown } | null
    if (answer?.status === 'live') {
      return true
    }
    if (answer?.status === 'exited') {
      return false
    }
    return null
  } catch {
    return null
  }
}
