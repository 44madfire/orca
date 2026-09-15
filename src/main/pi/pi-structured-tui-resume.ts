// Pi structured→TUI resume planning (SNC1.9).
//
// Builds the host-owned `providerSession` for resuming the exact Pi session in
// an ordinary Pi TUI. `pi --session` requires the exact session FILE —
// `PI_STATE_DIR` is only the state directory — so the planner reads the
// authoritative file path off the durable provider-chain head, where the Pi
// adapter persisted the host-observed backend result at acquire time.
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
  if (!head || record.provider !== 'pi' || head.handle.provider !== 'pi') {
    throw new Error('agent_session_identity_required')
  }
  if (!head.handle.sessionId || head.handle.sessionId.trim() === '') {
    throw new Error('agent_session_identity_required')
  }
  const sessionFile = head.handle.sessionFile
  if (typeof sessionFile !== 'string' || sessionFile === '' || !isAbsolute(sessionFile)) {
    throw new Error('agent_session_identity_required')
  }
  return { key: 'session_id', id: head.handle.sessionId, transcriptPath: sessionFile }
}
