// Owner identity for external-bridge sessions (SNC1.3 dev seam).
//
// Mirrors `claude-structured-owner-identity` / `codex-structured-owner-identity`:
// mints the durable provider-handle link the lease proves. The bridge session id
// is provider-named (Orca never mints it); the link only records it.

import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session-provider-handle'

export function externalProviderHandleLink(input: {
  /** Bridge-side session id from `acquired` (provider-named, treated opaquely). */
  sessionId: string
  fence: number
  observedAt: number
  linkId?: string
}): AgentSessionProviderHandleLink {
  const sanitized = input.sessionId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64)
  const linkId = (input.linkId ?? `external-${input.fence}-${sanitized}`).slice(0, 128)
  return {
    linkId: linkId.length > 0 ? linkId : 'external-link',
    handle: { provider: 'external', sessionId: input.sessionId },
    origin: 'created',
    mintedAtFence: input.fence,
    observedAt: input.observedAt,
  }
}
