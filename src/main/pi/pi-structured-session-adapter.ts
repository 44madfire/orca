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
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionLifecycleEvent,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { supportsPiStructuredLocation } from './pi-structured-location-support'
import { PiRootExitObservedError } from './pi-process-teardown'
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
    return acquirePiStructuredSession({
      deps: this.deps,
      sessions: this.sessions,
      backend: this.requireBackend(),
      input
    })
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
          // The discriminant of the session that owns this turn; Pi and OMP never share one.
          agent: session.provider,
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
}
