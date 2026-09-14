// Native Pi structured-session adapter (SNC1.9 Orca-side).
//
// Owns capability gates, fence-checked dispatch, proven exit, exact Pi
// session/leaf identity, and explicit recoverable failures over the production
// Pi RPC backend (`pi-rpc-backend`: one `pi --mode rpc` child per session).
// Never fabricates a clean exit or auto-resends. Without a backend (tests
// that never install one) acquire fails closed with
// `PI_STRUCTURED_UNAVAILABLE` so callers fall back to ordinary Pi TUI.

import { randomUUID } from 'node:crypto'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity
} from '../../shared/agent-session-record'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRefusal,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionPreSpawnError,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionLifecycleEvent,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsPiStructuredLocation } from './pi-structured-location-support'
import { piProviderHandleLink } from './pi-structured-owner-identity'
import { PiRootExitObservedError } from './pi-process-teardown'
import { assertPiAdapterCompat, buildPiAdapterCompat } from './pi-adapter-compat'
import {
  opaquePiResumeSessionId,
  resolvePiProcessIdentity,
  type PiStructuredAcquireResult,
  type PiStructuredBackend,
  type PiStructuredDispatchResult
} from './pi-structured-backend'

export { PI_STRUCTURED_AGENT } from './pi-structured-agent'
export type { PiStructuredBackend, PiStructuredSessionAdapterDeps } from './pi-structured-backend'
import type { PiSession, PiStructuredSessionAdapterDeps } from './pi-structured-backend'

const PI_OPTION_KEYS = new Set(['model', 'thinkingLevel', 'queueMode', 'autoCompaction'])

export class PiStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, PiSession>()
  private readonly optionRestoreFailures = new Map<string, Set<string>>()

  constructor(private readonly deps: PiStructuredSessionAdapterDeps) {}

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    if (agent !== 'pi') {
      return false
    }
    return supportsPiStructuredLocation(location)
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsPiStructuredLocation(location)

  /** Backend exit callback: publish the lifecycle event the host recovers from. */
  publishUnexpectedExit = (orcaSessionId: string): void => {
    const session = this.sessions.get(orcaSessionId)
    if (!session || session.closed) {
      return
    }
    const event: StructuredAgentSessionLifecycleEvent = {
      type: 'ended',
      sessionId: orcaSessionId,
      reason: 'pi session exited unexpectedly',
      cause: 'unexpected-exit',
      fence: session.fence,
      acquisitionGeneration: session.generation
    }
    try {
      this.deps.onEvent?.(event)
    } catch {
      // Listener errors never break connection teardown; close() settles state.
    }
  }

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<{
    process: AgentSessionProcessIdentity
    link: AgentSessionProviderHandleLink
    acquisitionGeneration?: string
  }> {
    if (input.identity.agent !== 'pi') {
      throw new AgentSessionAcquisitionRefusal(
        `pi adapter does not own agent ${input.identity.agent}`
      )
    }
    const backend = this.requireBackend()
    const compat = await buildPiAdapterCompat(input, this.deps)
    assertPiAdapterCompat(compat)
    const workspaceRoot = await this.deps.resolveWorkspacePath(input.identity.workspaceId)
    if (!workspaceRoot || workspaceRoot.trim() === '') {
      throw new AgentSessionPreSpawnError(
        'BAD_WORKSPACE: acquire requires a non-empty workspaceRoot'
      )
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
        ...(compat !== null ? { compat } : {}),
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
      ...(this.deps.readProcessStartTime
        ? { readProcessStartTime: this.deps.readProcessStartTime }
        : {})
    }).catch(async (error: unknown) => {
      await backend.close({ orcaSessionId: input.identity.sessionId }).catch(() => undefined)
      throw new AgentSessionPreSpawnError(error)
    })
    const now = this.deps.now?.() ?? Date.now()
    const generation = randomUUID()
    this.sessions.set(input.identity.sessionId, {
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

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.close(input.sessionId)
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.requireLive(input.sessionId)
    if (session.fence !== input.fence) {
      return { state: 'rejected', reason: 'agent_session_checkpoint_stale' }
    }
    let result: PiStructuredDispatchResult
    try {
      result = await this.requireBackend().dispatch({
        orcaSessionId: input.sessionId,
        body: input.body
      })
    } catch (error) {
      // Unsettled dispatch stays `unknown`; the caller reconciles via history.
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
    if (result.status === 'accepted') {
      return {
        state: 'accepted',
        providerIdentity: {
          provider: 'legacy',
          agent: 'pi',
          sessionId: session.piSessionId,
          recordId: input.clientMessageId
        }
      }
    }
    if (result.status === 'rejected') {
      return { state: 'rejected', reason: result.reason }
    }
    return { state: 'unknown', reason: result.reason }
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.closed || session.fence !== input.fence) {
      return { cancelled: false }
    }
    try {
      return await this.requireBackend().cancel({ orcaSessionId: input.sessionId })
    } catch {
      return { cancelled: false }
    }
  }

  rewindSupport: NonNullable<StructuredAgentSessionAdapter['rewindSupport']> = () => ({
    supported: false,
    reason: 'unsupported'
  })

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> {
    const session = this.requireLive(input.sessionId)
    if (session.fence !== input.fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    // `itemId` is the journal item key the driver journaled the dialog under;
    // the backend routes it to the owning driver exactly once.
    const answer = this.requireBackend().answerPrompt
    if (!answer) {
      throw new Error('Pi prompts are unavailable in this build.')
    }
    await answer({
      itemKey: input.itemId,
      kind: input.kind,
      optionId: input.optionId
    })
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>> {
    const session = this.requireLive(input.sessionId)
    if (session.fence !== input.fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    if (!PI_OPTION_KEYS.has(input.key)) {
      this.trackRestoreFailure(input.sessionId, input.key)
      throw new Error(`pi has no session option named ${input.key}`)
    }
    const set = this.requireBackend().setOption
    if (!set) {
      this.trackRestoreFailure(input.sessionId, input.key)
      throw new Error('Pi options are unavailable in this build.')
    }
    try {
      return await set({
        orcaSessionId: input.sessionId,
        key: input.key,
        value: input.value
      })
    } catch (error) {
      this.trackRestoreFailure(input.sessionId, input.key)
      throw error
    }
  }

  readOptions = async (input: { sessionId: string; fence: number }) => {
    const session = this.requireLive(input.sessionId)
    if (session.fence !== input.fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    const backend = this.requireBackend()
    const current = await backend.readOptions?.({ orcaSessionId: input.sessionId })
    const model = current?.model ?? 'pi'
    const effort = current?.thinkingLevel
    let models: {
      id: string
      label: string
      isDefault: boolean
      defaultEffort?: string
      efforts: { value: string; label: string }[]
    }[] = []
    try {
      const [catalog, levels] = await Promise.all([
        backend.listModels?.({ orcaSessionId: input.sessionId }) ?? Promise.resolve([]),
        backend.listThinkingLevels?.({ orcaSessionId: input.sessionId }) ?? Promise.resolve([])
      ])
      models = catalog.map((entry) => {
        const qualified = `${entry.provider}/${entry.id}`
        return {
          id: qualified,
          label: entry.id,
          isDefault: qualified === model || entry.id === model,
          ...(effort ? { defaultEffort: effort } : {}),
          efforts: levels.map((level) => ({ value: level, label: level }))
        }
      })
    } catch {
      models = []
    }
    return { models, current: { model, ...(effort ? { effort } : {}) } }
  }

  readOptionRestoreFailures = (sessionId: string): readonly string[] => [
    ...(this.optionRestoreFailures.get(sessionId) ?? [])
  ]

  readResumeHistory = async (input: {
    sessionId: string
    fence: number
  }): Promise<{
    rows: { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string }[]
    leafId: string | null
  }> => {
    const session = this.requireLive(input.sessionId)
    if (session.fence !== input.fence) {
      throw new Error('agent_session_checkpoint_stale')
    }
    const read = this.requireBackend().readResumeHistory
    if (!read) {
      throw new Error('Pi history resume is unavailable in this build.')
    }
    const rebuilt = await read({ orcaSessionId: input.sessionId })
    const rows: { id: string; role: 'user' | 'assistant' | 'tool' | 'system'; text: string }[] = []
    for (const row of rebuilt.rows) {
      const role = row.role
      if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') {
        rows.push({ id: row.id, role, text: row.text })
      }
    }
    return { rows, leafId: rebuilt.leafId }
  }

  historyFilePath = async (input: {
    identity: AgentSessionJournalIdentity
  }): Promise<string | null> => {
    const session = this.sessions.get(input.identity.sessionId)
    if (session?.sessionFilePath) {
      return session.sessionFilePath
    }
    const backend = this.deps.backend
    if (!backend?.sessionFilePath || !session) {
      return null
    }
    return (await backend.sessionFilePath({ orcaSessionId: input.identity.sessionId })) ?? null
  }

  closeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)

  forceCloseSession = (sessionId: string): Promise<boolean> => this.close(sessionId)

  disposeSession = (sessionId: string): Promise<boolean> => this.close(sessionId)

  closeAll = async (): Promise<void> => {
    await closeProcessRegistry({
      attempts: 3,
      hasEntries: () => [...this.sessions.values()].some((session) => !session.closed),
      entryIds: () =>
        new Set([...this.sessions.entries()].filter(([, s]) => !s.closed).map(([id]) => id)),
      closeEntry: (id) => this.close(id),
      failureMessage: 'pi structured session shutdown could not prove every child stopped'
    })
  }

  private async close(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    if (session.closed) {
      this.sessions.delete(sessionId)
      return true
    }
    const backend = this.deps.backend
    if (!backend) {
      // No transport means no child exists; drop without claiming proven exit.
      this.sessions.delete(sessionId)
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
    this.sessions.delete(sessionId)
    return true
  }

  private requireLive(sessionId: string): PiSession {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) {
      throw new Error(`no live pi structured session for ${sessionId}`)
    }
    return session
  }

  private requireBackend(): PiStructuredBackend {
    const backend = this.deps.backend
    if (!backend) {
      throw new Error('PI_STRUCTURED_UNAVAILABLE: native Pi backend is not configured')
    }
    return backend
  }

  private trackRestoreFailure(sessionId: string, key: string): void {
    const failures = this.optionRestoreFailures.get(sessionId) ?? new Set<string>()
    failures.add(key)
    this.optionRestoreFailures.set(sessionId, failures)
  }
}
