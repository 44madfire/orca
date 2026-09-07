import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import {
  createCodexNamingTurnCollector,
  isTerminalCodexTurnError,
  generateAndSetCodexConversationName,
  readCodexGeneratedTitle
} from './codex-conversation-name-generation'

const THREAD = 'thread-user'
const NAMING = 'thread-naming'

/** An app-server that answers the naming flow's four requests. */
function fakeConnection(
  options: {
    nameOnReRead?: string | null
    answer?: string | null
    /** The app-server ignored `ephemeral` and persisted the throwaway thread. */
    persistDespiteEphemeral?: boolean
    /** A `thread/read` reply shape this build may or may not understand. */
    threadReadReply?: unknown
  } = {}
) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const connection: Pick<CodexAppServerConnection, 'request'> = {
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params: params ?? {} })
      if (method === 'thread/start') {
        return {
          thread: {
            id: NAMING,
            ...(options.persistDespiteEphemeral ? {} : { ephemeral: params?.ephemeral === true })
          }
        }
      }
      if (method === 'thread/read') {
        return options.threadReadReply !== undefined
          ? options.threadReadReply
          : {
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
): Promise<{ name: string | null; settled: boolean }> {
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
    retainNamingThread: () => {},
    closeNamingTurn: () => {}
  })
  // Drive the turn the way the app-server would, once the flow has opened it.
  queueMicrotask(() => {
    queueMicrotask(() => {
      // `null` leaves the turn unanswered entirely; 'DECLINE' completes it with
      // no message, which is a different fact the collector must distinguish.
      if (answer !== null && answer !== 'DECLINE') {
        collector?.handle('item/completed', { item: { type: 'agentMessage', text: answer } })
      }
      if (answer !== null) {
        collector?.handle('turn/completed', {})
      }
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

describe('naming thread hardening', () => {
  it('opens the throwaway thread with no approvals and no write access', async () => {
    const { connection, calls } = fakeConnection()

    await run(connection, '{"title":"Fix lease probe"}')

    // The prompt embeds untrusted user text and this thread's frames never reach
    // the journal, so anything the host would auto-approve would run unseen.
    expect(calls.find((call) => call.method === 'thread/start')?.params).toEqual({
      cwd: '/work/repo',
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only'
    })
  })

  it('releases the throwaway thread with the protocol cleanup', async () => {
    const { connection, calls } = fakeConnection()

    await run(connection, '{"title":"Fix lease probe"}')

    expect(calls.find((call) => call.method === 'thread/unsubscribe')?.params).toEqual({
      threadId: NAMING
    })
  })

  it('never unsubscribes the user own thread when the reply named it', async () => {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    const connection: Pick<CodexAppServerConnection, 'request'> = {
      request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params: params ?? {} })
        // The reply names the SESSION's thread; unsubscribing it would cut the
        // user's chat off from every frame it depends on.
        return method === 'thread/start' ? { thread: { id: THREAD } } : {}
      })
    }

    await expect(run(connection, '{"title":"Fix lease probe"}')).resolves.toEqual({
      name: null,
      settled: false
    })
    expect(calls.map((call) => call.method)).not.toContain('thread/unsubscribe')
  })

  it('refuses to parse an answer far larger than any title', async () => {
    // The 36-character cap is a schema request to the model, not a bound the
    // host enforces on the reply.
    const huge = `{"title":"${'a'.repeat(9 * 1024)}"}`

    expect(readCodexGeneratedTitle(huge)).toBeNull()
  })

  it('flattens and bounds the name before it reaches the user Codex thread', async () => {
    const { connection, calls } = fakeConnection()
    const sprawling = `Fix\nthe lease probe ${'x'.repeat(400)}`

    await run(connection, JSON.stringify({ title: sprawling }))

    const set = calls.find((call) => call.method === 'thread/name/set')
    const name = String(set?.params.name)
    expect(name).not.toContain('\n')
    expect(name.length).toBeLessThanOrEqual(200)
    expect(name.startsWith('Fix the lease probe ')).toBe(true)
  })
})

describe('createCodexNamingTurnCollector', () => {
  it('reports a completed turn that said nothing as a DECLINE', async () => {
    const collector = createCodexNamingTurnCollector(60_000)

    collector.handle('turn/completed', {})

    // A model that completed and said nothing has answered. Classifying this as
    // a host failure would re-ask, and pay, on every future acquisition.
    await expect(collector.answer).resolves.toEqual({ outcome: 'declined' })
  })

  it('reports the message a completed turn produced', async () => {
    const collector = createCodexNamingTurnCollector(60_000)

    collector.handle('item/completed', {
      item: { type: 'agentMessage', text: '{"title":"Fix probe"}' }
    })
    collector.handle('turn/completed', {})

    await expect(collector.answer).resolves.toEqual({
      outcome: 'answered',
      text: '{"title":"Fix probe"}'
    })
  })

  it('reports a terminal error as a FAILURE, not a decline', async () => {
    const collector = createCodexNamingTurnCollector(60_000)

    // There is no `turn/failed` notification; a rate-limited or rejected turn
    // arrives as `error`. Without it this would hold for the whole timeout.
    collector.handle('error', { message: 'rate limit exceeded' })

    await expect(collector.answer).resolves.toEqual({ outcome: 'failed' })
  })

  it('reports a failure even when the turn had already said something', async () => {
    const collector = createCodexNamingTurnCollector(60_000)

    collector.handle('item/completed', {
      item: { type: 'agentMessage', text: '{"title":"Fix probe"}' }
    })
    collector.handle('error', { message: 'stream closed' })

    // The host is why there is no title; a partial answer does not make it a
    // decline the conversation should be marked for.
    await expect(collector.answer).resolves.toEqual({ outcome: 'failed' })
  })

  it('reports a turn that never answered as TIMED OUT', async () => {
    const collector = createCodexNamingTurnCollector(1)

    await expect(collector.answer).resolves.toEqual({ outcome: 'timed-out' })
  })
})

describe('generateAndSetCodexConversationName', () => {
  it('names the thread from a turn on a throwaway ephemeral thread', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toMatchObject({
      name: 'Fix flaky lease probe'
    })

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

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toMatchObject({
      name: null
    })

    // The re-read is what makes the concurrent rename win; without it this sets.
    expect(calls.some((call) => call.method === 'thread/read')).toBe(true)
    expect(calls.some((call) => call.method === 'thread/name/set')).toBe(false)
  })

  it('sets nothing when the turn produced no usable title', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, 'I could not think of one')).resolves.toMatchObject({ name: null })

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

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toMatchObject({
      name: null
    })

    expect(calls.map((call) => call.method)).toEqual(['thread/start'])
  })

  it('gives up when the turn ends without an answer', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, null)).resolves.toMatchObject({ name: null })

    expect(calls.some((call) => call.method === 'thread/name/set')).toBe(false)
  })
})

describe('naming-turn cleanup and fail-closed re-read', () => {
  it('deletes a throwaway thread the app-server persisted despite ephemeral', async () => {
    const { connection, calls } = fakeConnection({ persistDespiteEphemeral: true })

    await run(connection, '{"title":"Fix flaky lease probe"}')

    // Otherwise every named chat leaves a junk thread and rollout file behind.
    expect(calls.find((call) => call.method === 'thread/delete')?.params).toEqual({
      threadId: NAMING
    })
  })

  it('does not try to delete a genuinely ephemeral thread', async () => {
    const { connection, calls } = fakeConnection()

    await run(connection, '{"title":"Fix flaky lease probe"}')

    // The app-server refuses to delete one, so attempting it would log a failure
    // on every successful naming.
    expect(calls.some((call) => call.method === 'thread/delete')).toBe(false)
  })

  // NOTE: a name under an unrecognised KEY on an otherwise-readable reply is not
  // detectable — by construction this build does not know the key. What fails
  // closed is an unrecognised reply SHAPE, which is the case it can decide.
  it.each([
    ['a reply with no thread object', { threadId: 'thread-user' }],
    ['a reply that is not an object', 'thread-user']
  ])(
    'refuses to overwrite a name it cannot positively read as absent: %s',
    async (_label, reply) => {
      const { connection, calls } = fakeConnection({ threadReadReply: reply })

      await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toMatchObject({
        name: null
      })

      // Fails CLOSED. Skipping a name is a non-event; clobbering a rename is not.
      expect(calls.some((call) => call.method === 'thread/name/set')).toBe(false)
    }
  )

  it('still names a thread a readable reply shows as unnamed', async () => {
    const { connection, calls } = fakeConnection()

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toMatchObject({
      name: 'Fix flaky lease probe'
    })

    expect(calls.find((call) => call.method === 'thread/name/set')?.params).toEqual({
      threadId: THREAD,
      name: 'Fix flaky lease probe'
    })
  })
})

describe('isTerminalCodexTurnError', () => {
  it('ends the turn on a non-retryable error', () => {
    expect(isTerminalCodexTurnError('error', { threadId: 't', willRetry: false })).toBe(true)
  })

  it('does NOT end the turn on a retryable one', () => {
    // A retryable error explicitly does not interrupt the turn; settling here
    // would abandon a naming turn that was about to succeed.
    expect(isTerminalCodexTurnError('error', { threadId: 't', willRetry: true })).toBe(false)
    expect(isTerminalCodexTurnError('error', { threadId: 't', will_retry: true })).toBe(false)
  })

  it('ignores anything that is not an error frame', () => {
    expect(isTerminalCodexTurnError('turn/started', { willRetry: false })).toBe(false)
    expect(isTerminalCodexTurnError('error', null)).toBe(false)
  })
})

describe('settled vs unsettled outcomes', () => {
  it('is UNSETTLED when no throwaway thread could be opened', async () => {
    const connection: Pick<CodexAppServerConnection, 'request'> = {
      request: vi.fn(async () => ({}))
    }

    // A host that cannot be asked must stay askable; marking it would forfeit
    // naming for this conversation permanently.
    await expect(run(connection, '{"title":"x"}')).resolves.toEqual({
      name: null,
      settled: false
    })
  })

  it('is UNSETTLED when the turn never answered', async () => {
    const { connection } = fakeConnection()

    await expect(run(connection, null)).resolves.toEqual({ name: null, settled: false })
  })

  it('is SETTLED when the model completed and said nothing', async () => {
    const { connection } = fakeConnection()

    // A real decline. Left unsettled, this is re-asked — and paid for — on every
    // future acquisition of the conversation.
    await expect(run(connection, 'DECLINE')).resolves.toEqual({ name: null, settled: true })
  })

  it('is UNSETTLED when the model ignored the schema and answered in prose', async () => {
    const { connection } = fakeConnection()

    // Marking this would make the conversation permanently unnameable, even
    // after switching to a model that honours the schema.
    await expect(run(connection, 'Sure! A good title would be "Fix probe".')).resolves.toEqual({
      name: null,
      settled: false
    })
  })

  it('is SETTLED when it named the thread', async () => {
    const { connection } = fakeConnection()

    await expect(run(connection, '{"title":"Fix flaky lease probe"}')).resolves.toEqual({
      name: 'Fix flaky lease probe',
      settled: true
    })
  })
})
