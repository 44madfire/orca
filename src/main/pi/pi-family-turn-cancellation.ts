// Pi-family turn cancellation guards (PIF-6, 44madfire/orca#27).
//
// One shared guard sequence for Pi and OMP turns. Both providers use the RPC
// `abort` primitive, but Orca decides whether it is valid to send it:
//   1. require a live session owned by the expected fence/generation;
//   2. confirm the requested `turnId` matches the current adapter-local live turn;
//   3. honor the current `dispatchStatus` / `resolveLiveTurnId()` guards;
//   4. send exactly ONE provider `abort` for the expected turn;
//   5. observe normal provider settlement via the flavor predicate (#26).
// A stale or mismatched turn returns `{ cancelled: false }` with NO abort
// sent. Session kill is never used as turn cancellation.

import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiFamilyPromptClaims } from './pi-family-prompt-answers'
import type { PiSession, PiStructuredBackend } from './pi-structured-backend'

type CancelTurnInput = Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]

export async function cancelPiFamilyTurn(args: {
  sessions: Map<string, PiSession>
  backend: PiStructuredBackend
  claims: PiFamilyPromptClaims
  input: CancelTurnInput
}): Promise<{ cancelled: boolean }> {
  const { sessions, backend, claims, input } = args
  // 1. Live session owned by the expected fence; pin the object + generation
  // so a replacement child landing mid-guard cannot inherit this decision.
  const session = sessions.get(input.sessionId)
  if (!session || session.closed || session.fence !== input.fence) {
    return { cancelled: false }
  }
  const generation = session.generation
  // 2. The requested turn must be the current adapter-local live turn. A
  // missing live-turn seam fails closed: without proof of ownership Orca
  // never sends an abort it cannot attribute.
  const liveTurnId = backend.liveTurnId?.({ orcaSessionId: input.sessionId }) ?? null
  if (liveTurnId === null || liveTurnId !== input.turnId) {
    return { cancelled: false }
  }
  // 3. The journal is what the client read to name a turn, so a published
  // journal turn different from the request means the request is stale. A
  // null read means the row has not landed yet, not that nothing is running.
  const journalTurnId = input.resolveLiveTurnId?.() ?? null
  if (journalTurnId !== null && journalTurnId !== input.turnId) {
    return { cancelled: false }
  }
  // The host's latest-submission observation never vetoes a proven-live turn:
  // `pending` (admitted, awaiting history settlement) is the normal live
  // state, and the single-turn `abort` is safe against an uncertain send —
  // outcome honesty comes from the abort response itself (step 4).
  void input.dispatchStatus
  // A prompt-bound cancel races the prompt answer for the same callback: the
  // claim decides the single winner before any provider write. Claiming after
  // the turn checks above keeps a stale cancel from stealing a live answer.
  const promptItemId = input.prompt?.itemId
  if (promptItemId !== undefined && !claims.claim(input.sessionId, promptItemId)) {
    return { cancelled: false }
  }
  try {
    // Re-verify ownership after the claim: nothing awaited above, but the
    // backend re-checks the expected turn synchronously at send time, so a
    // live-turn id changing during the guard still sends no abort.
    const current = sessions.get(input.sessionId)
    if (
      current !== session ||
      current.closed ||
      current.fence !== input.fence ||
      current.generation !== generation
    ) {
      return { cancelled: false }
    }
    // 4. Exactly ONE provider abort, scoped to the expected turn.
    // 5. Settlement is observed, never fabricated: the driver's abort path
    // sends nothing else, and the turn clears only through the flavor's
    // final-settle frames (#26). Rejection/transport failure stays
    // `{ cancelled: false }` and claims no other turn was cancelled.
    return await backend.cancel({ orcaSessionId: input.sessionId, expectedTurnId: input.turnId })
  } catch {
    return { cancelled: false }
  } finally {
    if (promptItemId !== undefined) {
      claims.release(input.sessionId, promptItemId)
    }
  }
}
