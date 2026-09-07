import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  AgentSessionAcquisition,
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import { answerCodexPrompt } from './codex-structured-prompt-replies'
import { dispatchCodexTurn, isCodexTurnOptionKey } from './codex-structured-turn-start'
import { supportsCodexStructuredLocation } from './codex-structured-location-support'
import {
  closeAllCodexSessions,
  closeCodexPublishedSession,
  closeCodexSession
} from './codex-structured-session-close'
import {
  applyCodexStructuredSessionOption,
  readLiveCodexSessionOptions
} from './codex-structured-session-options'
import {
  CodexAcquisitionRegistry,
  requireLiveCodexSession,
  type CodexAcquisitionAttempt,
  type CodexSession,
  type CodexStructuredSessionAdapterDeps,
  type CodexStructuredSessionEvent
} from './codex-structured-session-state'
import {
  deliverCodexNotification,
  deliverCodexServerRequest,
  deliverCodexUnhandledFrame
} from './codex-structured-provider-events'
import { isCodexNamingFrame } from './codex-conversation-name-generation'
import {
  captureCodexConversationName,
  startCodexConversationNaming
} from './codex-conversation-name-turn'
import { readCodexThreadId } from './codex-structured-thread-facts'
import { CodexStructuredTurnCancellation } from './codex-structured-turn-cancellation'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import { acquireCodexStructuredSession } from './codex-structured-session-acquire'

export type {
  CodexStructuredLaunch,
  CodexStructuredSessionAdapterDeps,
  CodexStructuredSessionEvent
} from './codex-structured-session-state'

export class CodexStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, CodexSession>()
  private readonly acquisitions = new CodexAcquisitionRegistry()
  private readonly turnCancellation: CodexStructuredTurnCancellation
  private readonly notificationRetries: ReturnType<typeof createCodexStructuredNotificationRetry>

  constructor(private readonly deps: CodexStructuredSessionAdapterDeps) {
    this.notificationRetries = createCodexStructuredNotificationRetry({
      sessionFor: (sessionId) => this.sessions.get(sessionId),
      translate: (sessionId, session, method, params) =>
        this.translateNotification(sessionId, session, method, params)
    })
    this.turnCancellation = new CodexStructuredTurnCancellation({
      captureTurnProcesses: deps.captureTurnProcesses,
      terminateTurnProcesses: deps.terminateTurnProcesses,
      requestTimeoutMs: deps.requestTimeoutMs,
      emit: (session, event) => {
        const admission = this.emit(session, event)
        if (!admission.accepted && event.type === 'notification') {
          this.notificationRetries.handle(event.sessionId, event.method, event.params)
        }
        return admission
      }
    })
  }

  supportsLocation = supportsCodexStructuredLocation

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    acquireCodexStructuredSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      turnCancellation: this.turnCancellation,
      notificationRetries: this.notificationRetries,
      deliver: (acquisition, sessionId, event, retainedBytes) =>
        this.deliver(acquisition, sessionId, event, retainedBytes),
      handleServerRequest: (sessionId, request) => this.handleServerRequest(sessionId, request),
      handleUnhandledFrame: (sessionId, kind, payload) =>
        this.handleUnhandledFrame(sessionId, kind, payload),
      forceCloseUnexpected: (sessionId, fence, acquisitionGeneration, reason) =>
        this.forceCloseUnexpected(sessionId, fence, acquisitionGeneration, reason)
    })

  /** Buffers pre-publication events and drops events from superseded children. */
  private deliver(
    acquisition: CodexAcquisitionAttempt['window'],
    sessionId: string,
    event: () => unknown,
    retainedBytes?: number
  ): void {
    if (acquisition.buffer(event, retainedBytes)) {
      return
    }
    if (this.sessions.get(sessionId)?.connection === acquisition.connection) {
      event()
    } else if (acquisition.isOverflowed) {
      // Pre-publication overflow is an acquisition failure, not a dropped
      // notification; tear down the child so callers retry explicitly.
      void acquisition.connection?.close()
    }
  }

  private translateNotification(
    sessionId: string,
    session: CodexSession,
    method: string,
    params: unknown
  ): CodexJournalTranslationAdmission {
    if (this.turnCancellation.handleNotification(sessionId, session, method, params)) {
      return { accepted: true }
    }
    // Before anything can journal it: a naming turn runs on a throwaway thread
    // over this same connection, and the item translator journals items from ANY
    // thread. Routed here, its prompt and its JSON answer never reach the chat.
    if (isCodexNamingFrame(session, readCodexThreadId(params))) {
      session.naming?.handle(method, params)
      return { accepted: true }
    }
    captureCodexConversationName(sessionId, session, method, params, this.deps)
    return deliverCodexNotification(sessionId, session, method, params, (current, event) =>
      this.emit(current, event)
    )
  }

  /** Journal first so observers never see an event ahead of its durable row. */
  private emit(
    session: CodexSession,
    event: CodexStructuredSessionEvent
  ): CodexJournalTranslationAdmission {
    const admission = session.translator?.handle(event) ?? { accepted: true }
    if (!admission.accepted) {
      return admission
    }
    this.deps.onEvent?.(event)
    return admission
  }

  private handleServerRequest(
    sessionId: string,
    request: Parameters<typeof deliverCodexServerRequest>[2]
  ): void {
    const session = this.sessions.get(sessionId)
    if (session && isCodexNamingFrame(session, readCodexThreadId(request.params))) {
      // An approval request from the naming turn would become a durable prompt in
      // the user's chat, for a command they never asked for, left pending forever
      // once the turn is abandoned. Refuse it so the turn settles instead.
      session.connection.respondWithError(
        request.id,
        -32001,
        'Orca does not run tools on a conversation-naming turn'
      )
      return
    }
    deliverCodexServerRequest(sessionId, session, request, (current, event) =>
      this.emit(current, event)
    )
  }

  private handleUnhandledFrame(sessionId: string, kind: string, params: unknown): void {
    const session = this.sessions.get(sessionId)
    if (session && isCodexNamingFrame(session, readCodexThreadId(params))) {
      session.naming?.handle(kind, params)
      return
    }
    deliverCodexUnhandledFrame(sessionId, session, kind, params, (current, event) =>
      this.emit(current, event)
    )
  }

  bindPromptItemId = (sessionId: string, journalItemId: string, promptKey: string): void =>
    this.sessions
      .get(sessionId)
      ?.prompts.bindJournalItemId(journalItemId, this.session(sessionId).threadId, promptKey)

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    const session = this.session(input.sessionId)
    await this.turnCancellation.captureBaseline(session)
    const outcome = await dispatchCodexTurn(session, input, this.deps.requestTimeoutMs)
    if (outcome.state === 'accepted') {
      // The accepted user message is the first thing worth naming the thread
      // after, and the only text this session is sure Codex received.
      startCodexConversationNaming({
        sessionId: input.sessionId,
        session,
        body: input.body,
        ...(this.deps.requestTimeoutMs ? { requestTimeoutMs: this.deps.requestTimeoutMs } : {}),
        ...(this.deps.onConversationName
          ? { onConversationName: this.deps.onConversationName }
          : {}),
        ...(this.deps.readNamingAttempted
          ? { readNamingAttempted: this.deps.readNamingAttempted }
          : {}),
        ...(this.deps.markNamingAttempted
          ? { markNamingAttempted: this.deps.markNamingAttempted }
          : {}),
        ...(this.deps.onNamingError ? { onError: this.deps.onNamingError } : {})
      })
    }
    return outcome
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const session = this.session(input.sessionId)
    return this.turnCancellation.cancel(session, input.turnId)
  }

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> {
    const session = this.session(input.sessionId)
    answerCodexPrompt(session.prompts, session.connection, input.itemId, input.optionId)
    session.translator?.resolvePrompt(input.itemId)
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<Readonly<Record<string, string>>> {
    if (!isCodexTurnOptionKey(input.key)) {
      throw new Error(`codex app-server has no thread option named ${input.key}`)
    }
    return applyCodexStructuredSessionOption(
      this.session(input.sessionId),
      input.key,
      input.value,
      this.deps.requestTimeoutMs
    )
  }

  readOptions = (input: { sessionId: string; fence: number }) =>
    readLiveCodexSessionOptions(this.session(input.sessionId), this.deps.requestTimeoutMs)

  historyFilePath = async (input: {
    identity: AgentSessionJournalIdentity
  }): Promise<string | null> => this.sessions.get(input.identity.sessionId)?.historyPath ?? null

  closeSession = async (sessionId: string): Promise<boolean> => {
    const closed = await closeCodexSession(
      sessionId,
      this.sessions,
      this.acquisitions,
      this.deps.onEvent
    )
    if (closed) {
      this.notificationRetries.clear(sessionId, null)
    }
    return closed
  }
  forceCloseSession = async (sessionId: string): Promise<boolean> => {
    const closed = await closeCodexPublishedSession(this.sessions, sessionId, this.deps.onEvent, {
      allowFailedSettlement: true,
      requestedClose: false
    })
    if (closed) {
      this.notificationRetries.clear(sessionId, null)
    }
    return closed
  }

  private forceCloseUnexpected(
    sessionId: string,
    fence: number,
    acquisitionGeneration: string,
    reason: Error
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (
      !session ||
      session.ended ||
      session.fence !== fence ||
      session.acquisitionGeneration !== acquisitionGeneration
    ) {
      return Promise.resolve(false)
    }
    return closeCodexPublishedSession(this.sessions, sessionId, this.deps.onEvent, {
      allowFailedSettlement: true,
      requestedClose: false,
      expectedFence: fence,
      expectedAcquisitionGeneration: acquisitionGeneration,
      unexpectedReason: reason
    })
  }
  disposeSession = (sessionId: string): Promise<boolean> => this.closeSession(sessionId)
  closeAll = (): Promise<void> =>
    closeAllCodexSessions(this.sessions, this.acquisitions, (sessionId) =>
      this.disposeSession(sessionId)
    )
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.closeSession(input.sessionId)

  private session(sessionId: string): CodexSession {
    return requireLiveCodexSession(this.sessions, sessionId)
  }
}
