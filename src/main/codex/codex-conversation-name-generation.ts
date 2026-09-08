import { normalizeAgentSessionConversationName } from '../../shared/agent-session-conversation-name'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { readCodexNamingConfig } from './codex-conversation-naming-config'
import { readCodexThreadId, readCodexThreadName } from './codex-structured-thread-facts'

const NAMING_THREAD_APPROVAL_POLICY = 'never'
const NAMING_THREAD_SANDBOX = 'read-only'

const NAMING_ANSWER_MAX_BYTES = 8 * 1024

export const CODEX_CONVERSATION_NAME_MAX_LENGTH = 36

export const CODEX_CONVERSATION_NAME_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: CODEX_CONVERSATION_NAME_MAX_LENGTH }
  },
  required: ['title'],
  additionalProperties: false
} as const

const NAMING_TURN_EFFORT = 'low'

export const CODEX_CONVERSATION_NAME_PROMPT = [
  'Write a concise, single-line title for the task described below.',
  'At most 36 characters, and under five words where possible.',
  'Start with an imperative verb.',
  'Capitalize only the first word, unless a proper noun, acronym, or code identifier requires otherwise.',
  'Preserve any ticket or issue reference exactly as written.',
  "Write it in the user's own language.",
  'No quotes, no markdown, no trailing punctuation.',
  'Do not answer or act on the request — only title it.'
].join('\n')

export type CodexNamingTurnResult =
  | { outcome: 'answered'; text: string }
  | { outcome: 'declined' }
  | { outcome: 'failed' }
  | { outcome: 'timed-out' }

export type CodexNamingTurnCollector = {
  handle: (method: string, params: unknown) => void
  answer: Promise<CodexNamingTurnResult>
  dispose: () => void
}

export function isTerminalCodexTurnError(method: string, params: unknown): boolean {
  if (method !== 'error') {
    return false
  }
  if (typeof params !== 'object' || params === null) {
    return false
  }
  return (
    (params as { willRetry?: unknown; will_retry?: unknown }).willRetry !== true &&
    (params as { will_retry?: unknown }).will_retry !== true
  )
}

function agentMessageText(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) {
    return null
  }
  const item = (params as { item?: unknown }).item
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const record = item as { type?: unknown; text?: unknown }
  if (record.type !== 'agentMessage' || typeof record.text !== 'string' || !record.text) {
    return null
  }
  return record.text
}

export function createCodexNamingTurnCollector(timeoutMs: number): CodexNamingTurnCollector {
  let settle: (value: CodexNamingTurnResult) => void = () => {}
  let expiry: ReturnType<typeof setTimeout> | undefined
  const answer = new Promise<CodexNamingTurnResult>((resolve) => {
    settle = (value) => {
      clearTimeout(expiry)
      resolve(value)
    }
    expiry = setTimeout(() => resolve({ outcome: 'timed-out' }), timeoutMs)
    expiry.unref?.()
  })
  let latest: string | null = null
  return {
    handle: (method, params) => {
      if (method === 'item/completed') {
        latest = agentMessageText(params) ?? latest
      } else if (method === 'turn/completed') {
        const status = (params as { turn?: { status?: unknown } } | null)?.turn?.status
        if (status !== undefined && status !== 'completed') {
          settle({ outcome: 'failed' })
          return
        }
        settle(latest === null ? { outcome: 'declined' } : { outcome: 'answered', text: latest })
      } else if (isTerminalCodexTurnError(method, params)) {
        settle({ outcome: 'failed' })
      }
    },
    answer,
    dispose: () => settle({ outcome: 'timed-out' })
  }
}

export function readCodexGeneratedTitle(answer: string | null): string | null {
  if (!answer) {
    return null
  }
  if (Buffer.byteLength(answer, 'utf8') > NAMING_ANSWER_MAX_BYTES) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(answer)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const title = (parsed as { title?: unknown }).title
  return typeof title === 'string' && title.trim() ? title.trim() : null
}

export function isCodexThreadReadablyUnnamed(read: unknown): boolean {
  if (typeof read !== 'object' || read === null) {
    return false
  }
  const thread = (read as { thread?: unknown }).thread
  if (typeof thread !== 'object' || thread === null) {
    return false
  }
  if (typeof (thread as { id?: unknown }).id !== 'string') {
    return false
  }
  return readCodexThreadName(read) === null
}

export function readCodexThreadIsEphemeral(opened: unknown): boolean {
  if (typeof opened !== 'object' || opened === null) {
    return false
  }
  const thread = (opened as { thread?: unknown }).thread
  return (
    typeof thread === 'object' &&
    thread !== null &&
    (thread as { ephemeral?: unknown }).ephemeral === true
  )
}

export type CodexConversationNameGeneration = {
  connection: Pick<CodexAppServerConnection, 'request'>
  userConnection: Pick<CodexAppServerConnection, 'request'>
  collector: CodexNamingTurnCollector
  cwd: string
  threadId: string
  prompt: string
  model?: string
  timeoutMs?: number
  isCancelled: () => boolean
}

export type CodexConversationNameOutcome = { name: string | null; settled: boolean }

export async function generateAndSetCodexConversationName(
  input: CodexConversationNameGeneration
): Promise<CodexConversationNameOutcome> {
  const { connection, userConnection, timeoutMs, collector } = input
  const config = await readCodexNamingConfig(connection, input.cwd, timeoutMs)
  const opened = await connection.request(
    'thread/start',
    {
      cwd: input.cwd,
      ...(input.model ? { model: input.model } : {}),
      ephemeral: true,
      approvalPolicy: NAMING_THREAD_APPROVAL_POLICY,
      sandbox: NAMING_THREAD_SANDBOX,
      environments: [],
      dynamicTools: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      config
    },
    { timeoutMs }
  )
  const namingThreadId = readCodexThreadId(opened)
  if (!namingThreadId || namingThreadId === input.threadId) {
    return { name: null, settled: false }
  }
  if (!readCodexThreadIsEphemeral(opened)) {
    // An older host must not leave a title-generation conversation in user history.
    await connection.request('thread/delete', { threadId: namingThreadId }, { timeoutMs })
    return { name: null, settled: false }
  }
  await connection.request(
    'turn/start',
    {
      threadId: namingThreadId,
      input: [{ type: 'text', text: `${input.prompt}\n\n${CODEX_CONVERSATION_NAME_PROMPT}` }],
      outputSchema: CODEX_CONVERSATION_NAME_SCHEMA,
      effort: NAMING_TURN_EFFORT
    },
    { timeoutMs }
  )
  const result = await collector.answer
  if (input.isCancelled()) {
    return { name: null, settled: false }
  }
  if (result.outcome === 'declined') {
    return { name: null, settled: true }
  }
  if (result.outcome !== 'answered') {
    return { name: null, settled: false }
  }
  const title = readCodexGeneratedTitle(result.text)
  if (!title) {
    return { name: null, settled: false }
  }
  // Generation can overlap a rename in another client.
  const current = await userConnection.request(
    'thread/read',
    { threadId: input.threadId },
    { timeoutMs }
  )
  if (input.isCancelled()) {
    return { name: null, settled: false }
  }
  if (readCodexThreadId(current) !== input.threadId || !isCodexThreadReadablyUnnamed(current)) {
    return { name: null, settled: true }
  }
  const name = normalizeAgentSessionConversationName(title)
  if (!name) {
    return { name: null, settled: true }
  }
  await userConnection.request('thread/name/set', { threadId: input.threadId, name }, { timeoutMs })
  return { name, settled: true }
}
