// Pi structured-session proven close phase.
//
// Split from `pi-structured-session-adapter` (line budget): session teardown
// with proven child exit plus ephemeral dispatch-correlation cleanup. The
// journal stays authoritative, so pending dispatch state dies with the session.

import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiFamilyDispatchTracker } from './pi-family-dispatch'
import { PiRootExitObservedError } from './pi-process-teardown'
import type { PiSession, PiStructuredBackend } from './pi-structured-backend'

export async function closePiStructuredSession(args: {
  sessions: Map<string, PiSession>
  backend: PiStructuredBackend | undefined
  dispatches: PiFamilyDispatchTracker
  sessionId: string
}): Promise<boolean> {
  const { sessions, backend, dispatches, sessionId } = args
  // Ephemeral correlation dies with the session; the journal stays authoritative.
  dispatches.dropSession(sessionId)
  const session = sessions.get(sessionId)
  if (!session) {
    return true
  }
  if (session.closed) {
    sessions.delete(sessionId)
    return true
  }
  if (!backend) {
    // No transport means no child exists; drop without claiming proven exit.
    sessions.delete(sessionId)
    return true
  }
  let proven = false
  try {
    proven = (await backend.close({ orcaSessionId: sessionId })) === true
  } catch (error) {
    if (error instanceof PiRootExitObservedError) {
      throw new AgentSessionAcquisitionRootExitObservedError(error)
    }
    throw new AgentSessionAcquisitionExitUnprovenError(error)
  }
  if (proven !== true) {
    return false
  }
  session.closed = true
  sessions.delete(sessionId)
  return true
}
