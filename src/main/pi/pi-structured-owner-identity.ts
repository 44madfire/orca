// Owner identity for native Pi structured sessions (SNC1.9).
//
// Mirrors `claude-structured-owner-identity` / `codex-structured-owner-identity`:
// mints the durable provider-handle link the lease proves. The Pi session id is
// provider-named (Orca never mints it); `leafId` always names the Pi current
// leaf (never the page end), even when the leaf itself carries no message rows.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'

/** Child echoes its spawn token so the owner probe tells a live child from a same-pid stranger. */
export const PI_SPAWN_TOKEN_ENV = 'ORCA_AGENT_SESSION_SPAWN_TOKEN'

const START_TIME_READ_ATTEMPTS = 3

export async function piProcessIdentity(
  input: {
    identity: AgentSessionJournalIdentity
    spawnToken: string
    pid: number | undefined
  },
  readStartTime: (pid: number) => Promise<number | null> = readProcessStartTimeMs
): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error('pi rpc child started without a pid')
  }
  let processStartTimeMs: number | null = null
  for (let attempt = 0; attempt < START_TIME_READ_ATTEMPTS && processStartTimeMs === null; attempt += 1) {
    processStartTimeMs = await readStartTime(input.pid)
  }
  if (processStartTimeMs === null) {
    // Recording null latches every later owner probe indeterminate; reap the
    // child and leave a retryable refusal instead.
    throw new Error(`pi rpc child start time for pid ${input.pid} could not be read`)
  }
  return {
    hostId: input.identity.hostId,
    pid: input.pid,
    processStartTimeMs,
    spawnToken: input.spawnToken
  }
}

export function piProviderHandleLink(input: {
  /** Durable Pi-family discriminant; defaults to Pi for the pre-OMP call sites. */
  provider?: 'pi' | 'omp'
  sessionId: string
  leafId: string | null
  resumed: boolean
  origin?: 'adopted'
  fence: number
  linkId?: string
  observedAt: number
  /** Exact host-observed session file; required — a Pi-family handle without one is unresumable. */
  sessionFile: string
}): AgentSessionProviderHandleLink {
  const provider = input.provider ?? 'pi'
  return {
    linkId:
      input.linkId ??
      `${provider}-${input.fence}-${input.sessionId}-${input.leafId ?? 'empty'}`.slice(0, 128),
    handle: {
      provider,
      sessionId: input.sessionId,
      leafId: input.leafId,
      sessionFile: input.sessionFile
    },
    origin: input.origin ?? (input.resumed ? 'resumed' : 'created'),
    mintedAtFence: input.fence,
    observedAt: input.observedAt
  }
}
