import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import {
  createCodexNamingTurnCollector,
  generateAndSetCodexConversationName,
  readCodexGeneratedTitle
} from './codex-conversation-name-generation'

const THREAD = 'thread-user'
const NAMING = 'thread-naming'

/** An app-server that answers the naming flow's four requests. */
function fakeConnection(options: { nameOnReRead?: string | null; answer?: string | null } = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const connection: Pick<CodexAppServerConnection, 'request'> = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params: params ?? {} })
      if (method === 'thread/start') {
        return { thread: { id: NAMING, ephemeral: params?.ephemeral === true } }
      }
      if (method === 'thread/read') {
        return {
          thread: {
            id: THREAD,
            ...(options.nameOnReRead ? { name: options.nameOnReRead } : {})
          }
        }
      }
      return {}
    })
  }
  return { connection, calls }
}

function run(
  connection: Pick<CodexAppServerConnection, 'request'>,
  answer: string | null
): Promise<string | null> {
  let collector: ReturnType<typeof createCodexNamingTurnCollector> | null = null
  const done = generateAndSetCodexConversationName({
    connection,
    cwd: '/work/repo',
    threadId: THREAD,
    prompt: 'fix the flaky lease probe',
    openNamingTurn: () => {
      collector = createCodexNamingTurnCollector(5_000)
      return collector
    },
    closeNamingTurn: () => {}
  })
  // Drive the turn the way the app-server would, once the flow has opened it.
  queueMicrotask(() => {
    queueMicrotask(() => {
      if (answer !== null) {
        collector?.handle('item/completed', { item: { type: 'agentMessage', text: answer } })
      }
      collector?.handle('turn/completed', {})
    })
  })
  return done
}

describe('readCodexGeneratedTitle', () => {
  it('reads the title out of the structured answer', () => {
    expect(readCodexGeneratedTitle('{"title":"Fix flaky lease probe"}')).toBe(
      'Fix flaky lease probe'
    )
  })

  it('reports null for prose, empty answers, and a blank title', () => {
    expect(readCodexGeneratedTitle('Sure! Here is a title.')).toBeNull()
    expect(readCodexGeneratedTitle('')).toBeNull()
    expect(readCodexGeneratedTitle(null)).toBeNull()
    expect(readCodexGeneratedTitle('{"title":"   "}')).toBeNull()
    expect(readCodexGeneratedTitle('{"name":"Fix it"}')).toBeNull()
  })
})

describe('generateAndSetCodexConversationName', () => {
  it('names the thread from a turn on a throwaway ephemeral thread', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toBe(
      'Fix flaky lease probe'
    )

    const started = calls.find((call) => call.method === 'thread/start')
    // The naming turn must never run on the user's own thread.
    expect(started?.params.ephemeral).toBe(true)
    expect(calls.find((call) => call.method === 'turn/start')?.params.threadId).toBe(NAMING)
    expect(calls.find((call) => call.method === 'thread/name/set')?.params).toEqual({
      threadId: THREAD,
      name: 'Fix flaky lease probe'
    })
  })

  it('asks for a bounded single-line title and never answers the request', async () => {
    const { connection, calls } = fakeConnection()

    await run(connection, '{"title":"Fix flaky lease probe"}')

    const turn = calls.find((call) => call.method === 'turn/start')
    expect(turn).toBeDefined()
    const text = (turn!.params.input as { text: string }[])[0]!.text
    expect(text).toContain('fix the flaky lease probe')
    expect(text).toContain('Do not answer or act on the request')
    expect(turn!.params.outputSchema).toMatchObject({
      properties: { title: { maxLength: 36 } },
      required: ['title'],
      additionalProperties: false
    })
  })

  it('leaves a thread named while it was generating alone', async () => {
    const { connection, calls } = fakeConnection({ nameOnReRead: 'A person named this' })

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toBeNull()

    // The re-read is what makes the concurrent rename win; without it this sets.
    expect(calls.some((call) => call.method === 'thread/read')).toBe(true)
    expect(calls.some((call) => call.method === 'thread/name/set')).toBe(false)
  })

  it('sets nothing when the turn produced no usable title', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, 'I could not think of one')).resolves.toBeNull()

    expect(calls.some((call) => call.method === 'thread/name/set')).toBe(false)
    // No title also means no reason to have re-read the thread.
    expect(calls.some((call) => call.method === 'thread/read')).toBe(false)
  })

  it('refuses to run the naming turn on the user’s own thread', async () => {
    // An app-server that ignored `ephemeral` hands back the session's own
    // thread. Running there would put this prompt and its JSON answer into the
    // user's transcript and their history — the one outcome this path exists to
    // avoid — so the turn is abandoned instead.
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const connection: Pick<CodexAppServerConnection, 'request'> = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params: params ?? {} })
        return method === 'thread/start' ? { thread: { id: THREAD } } : {}
      })
    }

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toBeNull()

    expect(calls.map((call) => call.method)).toEqual(['thread/start'])
  })

  it('gives up when the turn ends without an answer', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, null)).resolves.toBeNull()

    expect(calls.some((call) => call.method === 'thread/name/set')).toBe(false)
  })
})
