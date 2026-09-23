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
import { resolvePiFamilyFlavor } from './pi-family-flavor'
import { piProviderHandleLink } from './pi-structured-owner-identity'
import {
  opaquePiFamilyResume,
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
  /** Provider-record observer bound to this acquisition's session (PIF-4 dispatch settlement). */
  onProviderRecord?: (record: Record<string, unknown>) => void
}): Promise<{
  process: AgentSessionProcessIdentity
  link: AgentSessionProviderHandleLink
  acquisitionGeneration?: string
}> {
  const { deps, sessions, backend, input } = args
  if (input.identity.agent !== 'pi' && input.identity.agent !== 'omp') {
    throw new AgentSessionAcquisitionRefusal(
      `pi-family adapter does not own agent ${input.identity.agent}`
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the guard above leaves only the two Pi-family discriminants.
  const provider = input.identity.agent as 'pi' | 'omp'
  const workspaceRoot = await deps.resolveWorkspacePath(input.identity.workspaceId)
  if (!workspaceRoot || workspaceRoot.trim() === '') {
    throw new AgentSessionPreSpawnError('BAD_WORKSPACE: acquire requires a non-empty workspaceRoot')
  }
  // Resume comes from the durable chain via opaque `pi:<sessionId>`/`omp:<sessionId>`
  // plus the host-owned session file on the chain head (see `resumeSessionFile`);
  // a fresh create mints a new Pi-family session. The resume provider must match the
  // acquisition discriminant: a Pi file is never opened by OMP and vice versa.
  const resume = opaquePiFamilyResume(input.identity)
  if (resume && resume.provider !== provider) {
    throw new AgentSessionAcquisitionRefusal(
      `pi-family resume mixes ${resume.provider} session with ${provider} acquisition`
    )
  }
  if (resume && !input.resumeSessionFile) {
    throw new AgentSessionPreSpawnError(
      'PI_RESUME_FAILED: Pi-family resume needs the exact session file (reacquire without resume for a fresh session)'
    )
  }
  let acquired: PiStructuredAcquireResult
  try {
    acquired = await backend.acquire({
      orcaSessionId: input.identity.sessionId,
      workspaceRoot,
      ...(args.onProviderRecord ? { onRecord: args.onProviderRecord } : {}),
      provider,
      ...(resume ? { resumePiSessionId: resume.sessionId } : {}),
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
  const flavor = resolvePiFamilyFlavor(provider)
  sessions.set(input.identity.sessionId, {
    orcaSessionId: input.identity.sessionId,
    provider,
    piSessionId: acquired.piSessionId,
    leafId: acquired.leafId,
    fence: input.fence,
    generation,
    process: exactProcess,
    sessionFilePath: acquired.sessionFilePath ?? null,
    sink: input.events ?? null,
    closed: false,
    // The live child exposes its own final-settle predicate; the shared
    // transport never owns settlement (#23 removed the Pi-only settle API).
    isSettledEvent: flavor.isSettled
  })
  // The exact session file is host-observed backend output, persisted on the
  // durable link so resume and structured→TUI address the same file after restart.
  // A backend that reports no file fails closed: the session is reaped, never minted
  // file-less, because an unresumable handle would strand the durable chain.
  const sessionFile =
    typeof acquired.sessionFilePath === 'string' && acquired.sessionFilePath !== ''
      ? acquired.sessionFilePath
      : undefined
  if (!sessionFile) {
    await backend.close({ orcaSessionId: input.identity.sessionId }).catch(() => undefined)
    throw new AgentSessionPreSpawnError(
      'PI_STATE_FAILED: Pi-family backend reported no session file'
    )
  }
  const link = piProviderHandleLink({
    provider,
    sessionId: acquired.piSessionId,
    leafId: acquired.leafId,
    resumed: resume !== null,
    fence: input.fence,
    observedAt: now,
    sessionFile
  })
  return { process: exactProcess, link, acquisitionGeneration: generation }
}
