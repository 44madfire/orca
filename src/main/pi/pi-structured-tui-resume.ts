// Pi-family structured→TUI resume planning (SNC1.9, PIF-8 #29).
//
// Builds the host-owned `providerSession` for resuming the exact Pi-family
// session in its ordinary provider TUI. `pi --session` requires the exact
// session FILE (`PI_STATE_DIR` is only the state directory); OMP resumes by
// exact file the same way (`omp --resume <file>`). The planner reads the
// authoritative file path off the durable provider-chain head, where the
// Pi-family adapter persisted the host-observed backend result at acquire
// time, and only ever hands it back to the SAME provider that minted it.
//
// Takes only the durable record: there is deliberately no client-input
// parameter, so a caller cannot aim the resume at a client-authored path. Any
// missing or non-absolute locator fails closed with a generic identity error
// that names no path (paths never enter untrusted logs or refusals).

import { isAbsolute } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'

export function buildPiTuiResumeProviderSession(
  record: AgentSessionRecord
): AgentProviderSessionMetadata {
  const head = record.providerHandleChain.at(-1)
  const handle = head?.handle
  // Same-provider resume only: a Pi file is never opened by OMP and vice versa.
  if (!head || !handle || (handle.provider !== 'pi' && handle.provider !== 'omp')) {
    throw new Error('agent_session_identity_required')
  }
  if (record.provider !== handle.provider) {
    throw new Error('agent_session_identity_required')
  }
  if (!handle.sessionId || handle.sessionId.trim() === '') {
    throw new Error('agent_session_identity_required')
  }
  // A null leaf is the empty-session cursor; a present leaf must be well-formed.
  if (handle.leafId !== null && (typeof handle.leafId !== 'string' || handle.leafId.trim() === '')) {
    throw new Error('agent_session_identity_required')
  }
  const sessionFile = handle.sessionFile
  if (typeof sessionFile !== 'string' || sessionFile === '' || !isAbsolute(sessionFile)) {
    throw new Error('agent_session_identity_required')
  }
  return { key: 'session_id', id: handle.sessionId, transcriptPath: sessionFile }
}
