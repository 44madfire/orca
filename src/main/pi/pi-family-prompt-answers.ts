// Pi-family interactive prompt ownership (PIF-6, 44madfire/orca#27).
//
// Provider blocking UI requests (Pi/OMP `extension_ui_request`) are already
// journaled as EXISTING Orca prompt types by `pi-event-journal`
// (confirm -> approval, select -> question/options, input/editor -> the
// free-text question shape); OMP-only extras that match no Orca capability
// stay bounded ignores and never create UI types. This module owns the other
// half: exactly-once answers over the ephemeral callback mapping
// (Orca prompt item identity <-> provider extension request id), which the
// driver holds in `promptTracker`/`pendingPrompts` and retires on
// flavor-predicate final settle (#26), cancel, close, or exit.
//
// Answer order per request: validate provider/fence/generation, CLAIM the
// pending request BEFORE commit, run the host commit/CAS, re-validate
// ownership, then send exactly ONE matching `extension_ui_response`.
// Duplicate/stale/late answers send no second provider response. The same
// claim serializes prompt-bound cancels, so an answer-vs-cancel race has
// exactly one winner. No durable Pi/OMP prompt state is created.

import {
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiSession, PiStructuredBackend } from './pi-structured-backend'

type AnswerPromptInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

/**
 * Ephemeral in-flight prompt operations keyed by Orca prompt item identity.
 * Held only for the duration of one answer or prompt-bound cancel; the
 * driver remains the authority on whether a callback is still live.
 */
export class PiFamilyPromptClaims {
  private readonly claimed = new Map<string, string>()

  /** Claim `itemId` for `sessionId`; false when another operation owns it. */
  claim(sessionId: string, itemId: string): boolean {
    if (this.claimed.has(itemId)) {
      return false
    }
    this.claimed.set(itemId, sessionId)
    return true
  }

  /** Release `itemId` when held by `sessionId`; never releases a stranger's claim. */
  release(sessionId: string, itemId: string): void {
    if (this.claimed.get(itemId) === sessionId) {
      this.claimed.delete(itemId)
    }
  }

  /** Drop every claim for a session on proven close. */
  dropSession(sessionId: string): void {
    for (const [itemId, owner] of Array.from(this.claimed)) {
      if (owner === sessionId) {
        this.claimed.delete(itemId)
      }
    }
  }
}

export async function answerPiFamilyPrompt(args: {
  sessions: Map<string, PiSession>
  backend: PiStructuredBackend
  claims: PiFamilyPromptClaims
  input: AnswerPromptInput
}): Promise<void> {
  const { sessions, backend, claims, input } = args
  // Validate provider/fence against the live session; pin the object +
  // generation so a replacement child landing mid-answer is never written
  // through. The session entry is provider-bound at acquire, so scoping the
  // driver lookup to it also scopes the answer to the owning provider.
  const session = sessions.get(input.sessionId)
  if (!session || session.closed || session.fence !== input.fence) {
    throw new AgentSessionPromptUnavailableError(input.itemId)
  }
  const generation = session.generation
  const answer = backend.answerPrompt
  if (!answer) {
    throw new Error('Pi prompts are unavailable in this build.')
  }
  // Refuse stale requests BEFORE commit: no journal write for a callback the
  // provider already retired. A backend without the ownership seam cannot
  // prove liveness, so it fails closed too.
  const owner = backend.promptOwner?.({ orcaSessionId: input.sessionId, itemKey: input.itemId })
  if (!owner) {
    throw new AgentSessionPromptUnavailableError(input.itemId)
  }
  // Claim before commit: the single winner between racing answers and a
  // prompt-bound cancel. Losers throw before touching the journal.
  if (!claims.claim(input.sessionId, input.itemId)) {
    throw new AgentSessionPromptUnavailableError(input.itemId)
  }
  try {
    // Host commit/CAS at the required point: held claim, before provider send.
    await input.commit()
    // Re-validate after the commit gap: a settle/close/exit or a replacement
    // child during commit must not receive this answer.
    const current = sessions.get(input.sessionId)
    if (
      current !== session ||
      current.closed ||
      current.fence !== input.fence ||
      current.generation !== generation ||
      !backend.promptOwner?.({ orcaSessionId: input.sessionId, itemKey: input.itemId })
    ) {
      throw new AgentSessionPromptUnavailableError(input.itemId)
    }
    // Exactly ONE matching extension UI response; the driver consumes the
    // callback synchronously, so duplicates find nothing to send.
    await answer({
      orcaSessionId: input.sessionId,
      itemKey: input.itemId,
      kind: input.kind,
      optionId: input.optionId
    })
  } finally {
    claims.release(input.sessionId, input.itemId)
  }
}
