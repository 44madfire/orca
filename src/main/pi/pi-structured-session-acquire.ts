// Pi structured-session acquisition phase.
//
// Split from `pi-structured-session-adapter` (line budget): workspace resolution, resume
// validation, backend acquire, mandatory start-time proof, session indexing, and durable
// link minting. Steady-state turns/options/history stay on the adapter.

import { randomUUID } from 'node:crypto'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import {
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { piProviderHandleLink } from './pi-structured-owner-identity'
import {
  opaquePiResumeSessionId,
  resolvePiProcessIdentity,
  type PiSession,
  type PiStructuredAcquireResult,
  type PiStructuredBackend,
  type PiStructuredSessionAdapterDeps
} from './pi-structured-backend'

export async function acquirePiStructuredSession(args: {
  deps: PiStructuredSessionAdapterDeps
  sessions: Map<string, PiSession>
  backend: PiStructuredBackend
  input: StructuredAgentSessionAcquireInput
}): Promise<{
  process: AgentSessionProcessIdentity
  link: AgentSessionProviderHandleLink
  acquisitionGeneration?: string
}> {
  const { deps, sessions, backend, input } = args
  if (input.identity.agent !== 'pi') {
    throw new AgentSessionAcquisitionRefusal(`pi adapter does not own agent ${input.identity.agent}`)
  }
  const workspaceRoot = await deps.resolveWorkspacePath(input.identity.workspaceId)
  if (!workspaceRoot || workspaceRoot.trim() === '') {
    throw new AgentSessionPreSpawnError('BAD_WORKSPACE: acquire requires a non-empty workspaceRoot')
  }
  // Resume comes from the durable chain via opaque `pi:<sessionId>` plus the
  // host-owned session file on the chain head (see `resumeSessionFile`);
  // a fresh create mints a new Pi session.
  const resumePiSessionId = opaquePiResumeSessionId(input.identity)
  if (resumePiSessionId && !input.resumeSessionFile) {
    throw new AgentSessionPreSpawnError(
      'PI_RESUME_FAILED: Pi resume needs the exact session file (reacquire without resume for a fresh session)'
    )
  }
  let acquired: PiStructuredAcquireResult
  try {
    acquired = await backend.acquire({
      orcaSessionId: input.identity.sessionId,
      workspaceRoot,
      ...(resumePiSessionId ? { resumePiSessionId } : {}),
      ...(input.resumeSessionFile ? { resumeSessionFile: input.resumeSessionFile } : {}),
      ...(input.options ? { options: input.options } : {}),
      spawnToken: input.spawnToken,
      ...(input.events ? { sink: input.events } : {})
    })
  } catch (error) {
    throw new AgentSessionPreSpawnError(error)
  }
  if (!acquired.piSessionId || acquired.piSessionId.trim() === '') {
    throw new AgentSessionPreSpawnError('PI_STATE_FAILED: Pi started but reported no session id')
  }
  // Start-time proof is mandatory; a child without it is reaped before retry.
  const exactProcess = await resolvePiProcessIdentity({
    identity: input.identity,
    spawnToken: input.spawnToken,
    pid: acquired.pid,
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {})
  }).catch(async (error: unknown) => {
    await backend.close({ orcaSessionId: input.identity.sessionId }).catch(() => undefined)
    throw new AgentSessionPreSpawnError(error)
  })
  const now = deps.now?.() ?? Date.now()
  const generation = randomUUID()
  sessions.set(input.identity.sessionId, {
    orcaSessionId: input.identity.sessionId,
    piSessionId: acquired.piSessionId,
    leafId: acquired.leafId,
    fence: input.fence,
    generation,
    process: exactProcess,
    sessionFilePath: acquired.sessionFilePath ?? null,
    sink: input.events ?? null,
    closed: false
  })
  // The exact session file is host-observed backend output, persisted on the
  // durable link so structured→TUI can build `pi --session <file>` after restart.
  const sessionFile =
    typeof acquired.sessionFilePath === 'string' && acquired.sessionFilePath !== ''
      ? acquired.sessionFilePath
      : undefined
  const link = piProviderHandleLink({
    sessionId: acquired.piSessionId,
    leafId: acquired.leafId,
    resumed: resumePiSessionId !== null,
    fence: input.fence,
    observedAt: now,
    ...(sessionFile ? { sessionFile } : {})
  })
  return { process: exactProcess, link, acquisitionGeneration: generation }
}
