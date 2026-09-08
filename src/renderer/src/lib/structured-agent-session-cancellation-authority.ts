import type { StructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
import {
  readOutboxEvidence,
  subscribeOutbox
} from '@/components/native-chat/structured-agent-session-outbox-storage'
import {
  persistStructuredLaunchCancellation,
  structuredLaunchCancellationKey
} from './structured-agent-session-launch-cancellation'

type Identity = Pick<StructuredAgentSessionLaunchIntent, 'sessionId' | 'worktreeId' | 'agent'>
type Authority = {
  identity: Identity
  incarnations: Set<string> | null
  detach: () => void
}
const authorities = new Map<string, Authority>()

function dispose(authority: Authority): void {
  if (authorities.get(authority.identity.sessionId) !== authority) {
    return
  }
  authorities.delete(authority.identity.sessionId)
  authority.detach()
  authority.incarnations?.clear()
}

// Session identity outlives callers; only readable durable retirement releases it.
export function establishStructuredLaunchCancellationAuthority(identity: Identity): void {
  if (authorities.has(identity.sessionId)) {
    return
  }
  const read = readOutboxEvidence(identity.sessionId, false)
  const authority: Authority = {
    identity: {
      sessionId: identity.sessionId,
      worktreeId: identity.worktreeId,
      agent: identity.agent
    },
    incarnations:
      read.status === 'readable'
        ? new Set(read.entries.map(structuredLaunchCancellationKey))
        : null,
    detach: () => {}
  }
  authorities.set(identity.sessionId, authority)
  authority.detach = subscribeOutbox(identity.sessionId, (entries) => {
    if (entries.length === 0 && authority.incarnations?.size) {
      dispose(authority)
    } else {
      authority.incarnations = new Set(entries.map(structuredLaunchCancellationKey))
    }
  })
}

export function reconcileStructuredLaunchCancellationAuthority(sessionId: string): void {
  const authority = authorities.get(sessionId)
  if (!authority) {
    return
  }
  const read = readOutboxEvidence(sessionId, false)
  if (read.status === 'readable' && read.entries.length === 0) {
    dispose(authority)
  }
}

export function requestStructuredLaunchCancellation(
  worktreeId: string,
  sessionId: string
): boolean | undefined {
  const authority = authorities.get(sessionId)
  if (!authority || authority.identity.worktreeId !== worktreeId) {
    return undefined
  }
  const captured = authority.incarnations === null ? null : new Set(authority.incarnations)
  // Transfer before publication; later commits must never expand the requested target set.
  dispose(authority)
  return persistStructuredLaunchCancellation(authority.identity, captured)
}
