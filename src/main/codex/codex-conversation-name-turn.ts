import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionNamingPromptText } from '../native-chat/agent-session-wire/agent-session-naming-prompt-text'
import { CodexConversationNamingTask } from './codex-conversation-naming-task'
import type { openCodexAppServerConnection } from './codex-app-server-connection'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'
import type {
  CodexSession,
  CodexStructuredSessionAdapterDeps
} from './codex-structured-session-state'

export type CodexConversationNamingInput = {
  sessionId: string
  session: CodexSession
  body: AgentJournalMessageItem
  requestTimeoutMs?: number
  openConnection?: typeof openCodexAppServerConnection
  onConversationName?: (sessionId: string, conversationName: string) => void
  readNamingAttempted?: (sessionId: string) => boolean
  markNamingAttempted?: (sessionId: string) => void
  onError?: (scope: string, error: unknown) => void
}

export function startCodexConversationNamingForTurn(
  sessionId: string,
  session: CodexSession,
  body: AgentJournalMessageItem,
  deps: CodexStructuredSessionAdapterDeps
): void {
  startCodexConversationNaming({
    sessionId,
    session,
    body,
    ...(deps.openConnection ? { openConnection: deps.openConnection } : {}),
    ...(deps.requestTimeoutMs ? { requestTimeoutMs: deps.requestTimeoutMs } : {}),
    ...(deps.onConversationName ? { onConversationName: deps.onConversationName } : {}),
    ...(deps.readNamingAttempted ? { readNamingAttempted: deps.readNamingAttempted } : {}),
    ...(deps.markNamingAttempted ? { markNamingAttempted: deps.markNamingAttempted } : {}),
    ...(deps.onNamingError ? { onError: deps.onNamingError } : {})
  })
}

export function startCodexConversationNaming(input: CodexConversationNamingInput): void {
  const { session, sessionId } = input
  if (
    session.ended ||
    session.requestedClose ||
    session.namingAttempted ||
    session.conversationName ||
    !input.onConversationName
  ) {
    return
  }
  const prompt = agentSessionNamingPromptText(input.body)
  if (!prompt) {
    return
  }
  session.namingAttempted = true
  void Promise.resolve()
    .then(async () => {
      if (input.readNamingAttempted?.(sessionId)) {
        return
      }
      if (session.ended || session.requestedClose) {
        return
      }
      const launch = session.launch
      const model = session.options.get('model') ?? session.reportedOptions.model
      const task = new CodexConversationNamingTask({
        launch: {
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: { ...launch.env, ...(launch.codexHome ? { CODEX_HOME: launch.codexHome } : {}) }
        },
        ...(input.openConnection ? { openConnection: input.openConnection } : {}),
        ...(input.onError ? { onError: input.onError } : {}),
        generation: {
          userConnection: session.connection,
          cwd: session.cwd,
          threadId: session.threadId,
          prompt,
          ...(model ? { model } : {}),
          ...(input.requestTimeoutMs ? { timeoutMs: input.requestTimeoutMs } : {})
        }
      })
      session.naming = task
      let outcome
      try {
        outcome = await task.result
      } finally {
        if (await task.close()) {
          session.naming = null
        }
      }
      if (outcome.settled) {
        input.markNamingAttempted?.(sessionId)
      }
      if (outcome.name && session.conversationName !== outcome.name) {
        session.conversationName = outcome.name
        input.onConversationName?.(sessionId, outcome.name)
      }
    })
    .catch((error: unknown) => {
      input.onError?.('codex-conversation-naming', error)
    })
}

export function captureCodexConversationName(
  sessionId: string,
  session: CodexSession,
  method: string,
  params: unknown,
  deps: Pick<CodexStructuredSessionAdapterDeps, 'onConversationName' | 'onConversationNameCleared'>
): void {
  if (method !== 'thread/name/updated') {
    return
  }
  if ((readCodexThreadId(params) ?? session.threadId) !== session.threadId) {
    return
  }
  const conversationName = readCodexThreadName(params)
  if (!conversationName) {
    if (session.conversationName !== null) {
      session.conversationName = null
      deps.onConversationNameCleared?.(sessionId)
    }
    return
  }
  if (conversationName === session.conversationName) {
    return
  }
  session.conversationName = conversationName
  deps.onConversationName?.(sessionId, conversationName)
}
