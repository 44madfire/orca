// SNC1.9 Pi handoff policy: pure, deterministic gates for structured-Chat ↔
// ordinary Pi TUI handoff. No I/O, no journal writes, no process probes — the
// flow runner owns effects, this module owns the invariants so tests can prove
// them without a live Pi binary.
//
// Invariants (from 44madfire/orca-pi#19):
// - At most one live mutating owner per Pi session/Orca structured lease.
// - Old owner is not released until exit/process identity is proven.
// - Handoff resumes the exact same Pi session/current branch (leaf may advance,
//   session id must not change).
// - Ambiguous teardown/startup fails closed into recoverable/manual state
//   rather than launching a competing owner.
// - Normal close cannot leak Pi descendants (proven by the adapter's close
//   ladder; this policy never claims a clean exit it did not observe).

import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'

export type PiHandoffQuiesceDecision =
  | { kind: 'proceed' }
  | { kind: 'queue-after-turn' }
  | { kind: 'refuse-busy'; reason: string }
  | { kind: 'refuse-prompt'; reason: string }

export function decidePiHandoffQuiesce(input: {
  hasActiveTurn: boolean
  hasPendingPrompt: boolean
  mode: 'now' | 'after-turn' | 'stop-turn'
  direction: 'to-tui' | 'to-native'
}): PiHandoffQuiesceDecision {
  if (input.hasPendingPrompt) {
    return {
      kind: 'refuse-prompt',
      reason: 'Resolve the pending question or approval before switching.'
    }
  }
  if (!input.hasActiveTurn) {
    return { kind: 'proceed' }
  }
  if (input.mode === 'after-turn') {
    return { kind: 'queue-after-turn' }
  }
  if (input.mode === 'now') {
    return { kind: 'refuse-busy', reason: 'The current turn must finish before switching.' }
  }
  // `stop-turn` on a Pi TUI owner would interrupt a turn the chat never
  // admitted; fail closed and ask the user to exit the terminal instead.
  return {
    kind: 'refuse-busy',
    reason: 'Exit the agent terminal after this turn to continue in chat.'
  }
}

export type PiHandoffIdentityVerdict =
  | { ok: true; resumed: boolean }
  | { ok: false; code: PiHandoffIdentityFailureCode; message: string }

export type PiHandoffIdentityFailureCode =
  | 'PI_HANDOFF_SESSION_MISMATCH'
  | 'PI_HANDOFF_LEAF_MISSING'
  | 'PI_HANDOFF_UNKNOWN_DISPATCH'
  | 'PI_HANDOFF_PROVIDER_MISMATCH'

function isNonEmptyHandleField(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
}

// The new owner must resume the exact same Pi-family session with the same provider
// discriminant (a Pi file is never opened by OMP and vice versa). The leaf is the
// current branch cursor: it may advance between handoff preparation and acquisition
// (the old owner settled one last turn), but it must never be missing and the
// session root must never change — a changed root is a fork, not a resume.
export function validatePiHandoffIdentity(input: {
  from: AgentSessionProviderHandle
  to: AgentSessionProviderHandle | null
}): PiHandoffIdentityVerdict {
  if (input.from.provider !== 'pi' && input.from.provider !== 'omp') {
    return {
      ok: false,
      code: 'PI_HANDOFF_PROVIDER_MISMATCH',
      message: 'Pi-family handoff requires a Pi or OMP provider handle (refusing to mis-attribute history).'
    }
  }
  if (!input.to) {
    return {
      ok: false,
      code: 'PI_HANDOFF_UNKNOWN_DISPATCH',
      message: 'Pi handoff acquired no provider handle (unknown dispatch; never auto-resend).'
    }
  }
  if (input.to.provider !== input.from.provider) {
    return {
      ok: false,
      code: 'PI_HANDOFF_PROVIDER_MISMATCH',
      message: 'Pi-family handoff changed provider (refusing to cross-open provider files).'
    }
  }
  if (input.to.sessionId !== input.from.sessionId) {
    return {
      ok: false,
      code: 'PI_HANDOFF_SESSION_MISMATCH',
      message:
        'Pi handoff changed Pi session (resume refused; reacquire without resume for a fresh session).'
    }
  }
  if (!isNonEmptyHandleField(input.to.sessionId)) {
    return {
      ok: false,
      code: 'PI_HANDOFF_LEAF_MISSING',
      message: 'Pi handoff has no Pi session id (missing history; reacquire the session).'
    }
  }
  // A null leaf is the empty-session cursor (fresh Pi session, no entries yet).
  // A present leaf must be a well-formed field; anything else fails closed.
  if (input.to.leafId !== null && !isNonEmptyHandleField(input.to.leafId)) {
    return {
      ok: false,
      code: 'PI_HANDOFF_LEAF_MISSING',
      message: 'Pi current leaf is missing or malformed (reacquire the session).'
    }
  }
  return { ok: true, resumed: input.to.leafId !== input.from.leafId || input.to.sessionId === input.from.sessionId }
}

export type PiHistoryReconciliationDecision =
  | { kind: 'provider-resume'; reason: string }
  | { kind: 'fail-closed'; code: 'PI_HISTORY_MISSING' | 'PI_HISTORY_INCOMPATIBLE'; message: string }

// Pi history after a TUI leg is authoritative in the Pi session file (root →
// current leaf). Structured chat reconciles by provider-resume (wholesale
// replace without duplication, per orca-pi pi-history semantics), never by
// row-by-row legacy import — the legacy decoders cannot parse Pi rows and a
// second parser would drift from the live view.
export function decidePiHistoryReconciliation(input: {
  historySource?: string
  transcriptPath?: string
  piSessionId?: string
  leafId?: string | null
}): PiHistoryReconciliationDecision {
  if (input.historySource === 'provider-resume') {
    return { kind: 'provider-resume', reason: 'Pi session file is authoritative; resume replaces wholesale.' }
  }
  if (!input.transcriptPath && !input.piSessionId) {
    return {
      kind: 'fail-closed',
      code: 'PI_HISTORY_MISSING',
      message: 'Pi handoff has no session file or Pi session id (missing history; reacquire).'
    }
  }
  return {
    kind: 'fail-closed',
    code: 'PI_HISTORY_INCOMPATIBLE',
    message:
      'Pi history requires provider-resume (legacy import cannot parse Pi rows; refusing to mis-attribute).'
  }
}

export type PiRecoverableFailure =
  | 'retry-native'
  | 'retry-tui'
  | 'manual-recovery'

export function classifyPiHandoffFailure(code: string): PiRecoverableFailure {
  if (
    code === 'PI_EXITED' ||
    code === 'PI_HISTORY_BUSY' ||
    code === 'agent_session_acquisition_exit_unproven' ||
    code === 'agent_session_owner_exit_unproven'
  ) {
    return 'manual-recovery'
  }
  if (code === 'PI_RESUME_FAILED' || code === 'PI_RESUME_CWD_MISMATCH' || code === 'PI_HISTORY_EMPTY') {
    return 'manual-recovery'
  }
  if (code === 'PI_STARTUP_FAILED' || code === 'PI_SPEC_FAILED' || code === 'PI_STATE_FAILED') {
    return 'retry-tui'
  }
  return 'manual-recovery'
}
