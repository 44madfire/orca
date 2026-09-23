// Native Pi structured-session adapter (SNC1.9 Orca-side).
//
// Owns capability gates, fence-checked dispatch, proven exit, exact Pi
// session/leaf identity, and explicit recoverable failures over the production
// Pi RPC backend (`pi-rpc-backend`: one `pi --mode rpc` child per session).
// Never fabricates a clean exit or auto-resends. Without a backend (tests
// that never install one) acquire fails closed with
// `PI_STRUCTURED_UNAVAILABLE` so callers fall back to ordinary Pi TUI.

import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import type { PiFamilySettledEvent } from './pi-family-flavor'
import {
  interpretOmpPromptResult,
  readPiFamilyDispatchCursor,
  sanitizePiFamilyPromptError,
  settlePiFamilySessionFromHistory,
  translatePiFamilyPromptBody,
  type PiFamilyHistorySnapshot,
  type PiFamilyLateSettlement
} from './pi-family-dispatch'
import { PiFamilyDispatchTracker } from './pi-family-dispatch-tracker'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionLifecycleEvent,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsPiStructuredLocation } from './pi-structured-location-support'
import { closePiStructuredSession } from './pi-structured-session-close'
import type {
  PiSession,
  PiStructuredBackend,
  PiStructuredDispatchResult,
  PiStructuredSessionAdapterDeps
} from './pi-structured-backend'
import { acquirePiStructuredSession } from './pi-structured-session-acquire'
import {
  compactPiSession,
  readPiHistoryFilePath,
  readPiOptionRestoreFailures,
  readPiResumeHistory,
  readPiSessionCommands,
  readPiSessionOptions,
  setPiSessionOption,
  type PiStructuredSessionInspectionState
} from './pi-structured-session-inspection'

export { PI_STRUCTURED_AGENT } from './pi-structured-agent'
export type { PiStructuredBackend, PiStructuredSessionAdapterDeps } from './pi-structured-backend'

export class PiStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, PiSession>()
  private readonly optionRestoreFailures = new Map<string, Set<string>>()
  // Admitted submissions awaiting history-backed settlement (ephemeral; the journal stays authoritative).
  private readonly dispatches = new PiFamilyDispatchTracker()

  constructor(private readonly deps: PiStructuredSessionAdapterDeps) {}

  private inspectionState(): PiStructuredSessionInspectionState {
    return {
      sessions: this.sessions,
      failures: this.optionRestoreFailures,
      deps: this.deps,
      live: (sessionId) => this.requireLive(sessionId)
    }
  }

  supportsCreate = (location: AgentSessionExecutionLocation, agent: string): boolean => {
    // One Pi-family adapter owns both discriminants; capability stays adapter-driven so
    // neither provider is ever globally supported merely because the handle type exists.
    if (agent !== 'pi' && agent !== 'omp') {
      return false
    }
    return supportsPiStructuredLocation(location)
  }

  supportsLocation = (location: AgentSessionExecutionLocation): boolean =>
    supportsPiStructuredLocation(location)

  /**
   * Final-settle predicate for one live child (PIF-3, #24; consumed by later issues).
   * A generation that no longer owns the session cannot settle anything: stale
   * lifecycle events from a superseded child answer false instead of leaking
   * through the replacement's predicate.
   */
  isSettledEvent = (input: {
    sessionId: string
    event: PiFamilySettledEvent
    acquisitionGeneration?: string
  }): boolean => {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.closed) {
      return false
    }
    if (
      input.acquisitionGeneration !== undefined &&
      input.acquisitionGeneration !== session.generation
    ) {
      return false
    }
    return session.isSettledEvent(input.event)
  }

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

  async acquire(input: StructuredAgentSessionAcquireInput) {
    const acquired = await acquirePiStructuredSession({
      deps: this.deps,
      sessions: this.sessions,
      backend: this.requireBackend(),
      input,
      onProviderRecord: (record) => this.handleProviderRecord(input.identity.sessionId, record)
    })
    // Fresh correlation epoch: superseded pending belongs to the journal/#29 now, never to the new child.
    this.dispatches.dropSession(input.identity.sessionId)
    return acquired
  }

  /** Provider record observer bound at acquire; a superseded child cannot settle replacement state. */
  handleProviderRecord = (sessionId: string, record: Record<string, unknown>): void => {
    const session = this.sessions.get(sessionId)
    if (!session || session.closed) {
      return
    }
    if (record['type'] === 'prompt_result') {
      // OMP dialect, normalized adapter-local: a locally-completed prompt retires without an agent turn.
      if (interpretOmpPromptResult(record) !== 'local-only') {
        return
      }
      void this.settleSession(session).catch(() => undefined)
      return
    }
    // Records are untrusted wire payloads; the settle predicate reads only its narrow shape.
    const settledCandidate: PiFamilySettledEvent = {
      ...record,
      type: typeof record['type'] === 'string' ? record['type'] : ''
    }
    if (!session.isSettledEvent(settledCandidate)) {
      return
    }
    void this.settleSession(session).catch(() => undefined)
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
    // Translate before any RPC write: an unrepresentable body never reaches the provider.
    try {
      await translatePiFamilyPromptBody(input.body)
    } catch (error) {
      return { state: 'rejected', reason: sanitizePiFamilyPromptError(error) }
    }
    // Cursor before the write; a failed read degrades to unknown (fail closed, never blocks admission).
    const preDispatch = await readPiFamilyDispatchCursor(this.deps.backend, input.sessionId)
    // Settle provable older pendings before arming, reusing the pre-read history (no extra RPC).
    await this.settleSession(session, preDispatch.history).catch(() => undefined)
    // Armed before the write (Codex ordering): a boundary frame landing in the
    // same stdout read as the ack is observed with correlation already present.
    this.dispatches.arm(input.sessionId, {
      clientMessageId: input.clientMessageId,
      provider: session.provider,
      generation: session.generation,
      cursor: preDispatch.cursor
    })
    let result: PiStructuredDispatchResult
    try {
      result = await this.requireBackend().dispatch({
        orcaSessionId: input.sessionId,
        body: input.body
      })
    } catch (error) {
      // Transport failure keeps correlation armed (the write may have landed); reconcile via history, never resend.
      void this.settleSession(session).catch(() => undefined)
      return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
    }
    if (result.status === 'rejected') {
      // Definite refusal: the provider declined, so no boundary for this write can arrive.
      this.dispatches.disarm(input.sessionId, input.clientMessageId, session.generation)
      return { state: 'rejected', reason: result.reason }
    }
    // A boundary that already arrived settles now instead of being lost.
    void this.settleSession(session).catch(() => undefined)
    if (result.status === 'unknown') {
      return { state: 'unknown', reason: result.reason }
    }
    // Prompt acknowledged means admitted, never accepted: identity settles later from history.
    return { state: 'admitted' }
  }

  private settleSession(
    session: PiSession,
    preRead?: PiFamilyHistorySnapshot | null
  ): Promise<void> {
    return settlePiFamilySessionFromHistory({
      sessions: this.sessions,
      tracker: this.dispatches,
      backend: this.deps.backend,
      onSettled: this.settlementSink(),
      session,
      preRead
    })
  }

  private settlementSink(): PiFamilyLateSettlement | undefined {
    return this.deps.onDispatchSettledLate
      ? (settlement) => this.deps.onDispatchSettledLate?.(settlement)
      : undefined
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

  async setOption(input: StructuredAgentSessionSetOptionInput) {
    return setPiSessionOption(this.inspectionState(), input)
  }

  readOptions = (input: { sessionId: string; fence: number }) =>
    readPiSessionOptions(this.inspectionState(), input)

  readCommands = (sessionId: string) => readPiSessionCommands(this.inspectionState(), sessionId)

  compact = (input: {
    turnId: string
    sessionId: string
    fence: number
    onLateResult?: (result: { error?: string }) => Promise<void>
  }) => compactPiSession(this.inspectionState(), input)

  readOptionRestoreFailures = (sessionId: string): readonly string[] =>
    readPiOptionRestoreFailures(this.optionRestoreFailures, sessionId)

  readResumeHistory = (input: { sessionId: string; fence: number }) =>
    readPiResumeHistory(this.inspectionState(), input)

  historyFilePath = (input: { identity: AgentSessionJournalIdentity }): Promise<string | null> =>
    readPiHistoryFilePath(this.inspectionState(), input)

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

  private close(sessionId: string): Promise<boolean> {
    return closePiStructuredSession({
      sessions: this.sessions,
      backend: this.deps.backend,
      dispatches: this.dispatches,
      sessionId
    })
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
}
