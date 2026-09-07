import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerLaunch,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

const THREAD_ID = 'thread-abc'
const SESSION = 'session-1'

const identity: AgentSessionJournalIdentity = {
  sessionId: SESSION,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: THREAD_ID }
}

type FakeConnection = Omit<CodexAppServerConnection, 'closed'> & {
  closed: boolean
  handlers: CodexAppServerConnectionHandlers
}

/** A `codex app-server` that answers `thread/start` and `thread/resume` and lets
 *  a test push the notifications Codex would broadcast. */
function fakeCodex(threadName?: string): {
  connections: FakeConnection[]
  openConnection: typeof openCodexAppServerConnection
} {
  const connections: FakeConnection[] = []
  const openConnection = (async (
    _launch: CodexAppServerLaunch,
    handlers: CodexAppServerConnectionHandlers = {}
  ) => {
    const connection: FakeConnection = {
      handlers,
      pid: 4321,
      closed: false,
      request: async () => ({
        thread: { id: THREAD_ID, ...(threadName ? { name: threadName } : {}) }
      }),
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => {
        connection.closed = true
        return true
      }
    } as FakeConnection
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection }
}

async function acquired(codex: ReturnType<typeof fakeCodex>, resumeThreadId: string | null = null) {
  const onConversationName = vi.fn()
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    onConversationName
  })
  await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-9' })
  return { adapter, onConversationName }
}

describe('Codex structured conversation name', () => {
  it('reports the name a resumed thread already carried', async () => {
    const { onConversationName } = await acquired(fakeCodex('Fix the lease probe'), THREAD_ID)

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the lease probe')
  })

  it('reports nothing for a thread the app-server has never named', async () => {
    const { onConversationName } = await acquired(fakeCodex())

    expect(onConversationName).not.toHaveBeenCalled()
  })

  it("reports a rename of this session's own thread", async () => {
    const codex = fakeCodex()
    const { onConversationName } = await acquired(codex)

    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', {
      threadId: THREAD_ID,
      threadName: 'Fix the lease probe'
    })

    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix the lease probe')
  })

  it('reports a rename only once while the name is unchanged', async () => {
    const codex = fakeCodex()
    const { onConversationName } = await acquired(codex)
    const rename = { threadId: THREAD_ID, threadName: 'Fix the lease probe' }

    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', rename)
    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', rename)

    expect(onConversationName).toHaveBeenCalledOnce()
  })

  it('ignores a name-updated broadcast for another stored thread', async () => {
    const codex = fakeCodex()
    const { onConversationName } = await acquired(codex)

    codex.connections[0]!.handlers.onNotification?.('thread/name/updated', {
      threadId: 'some-other-thread',
      threadName: 'Someone else’s chat'
    })

    expect(onConversationName).not.toHaveBeenCalled()
  })
})

/** A fake app-server that also serves the naming flow's requests. */
function namingCodex(
  options: {
    answer?: string
    existingName?: string
    hangNamingTurn?: boolean
    /** Never answers the ephemeral `thread/start`, so naming is in flight with
     *  NO naming thread id known: the window the broad frame rule covers. */
    hangNamingThreadStart?: boolean
    /** Completes the naming turn having said nothing: a genuine model decline,
     *  which is a different fact from prose that ignored the schema. */
    declineNamingTurn?: boolean
  } = {}
) {
  const connections: FakeConnection[] = []
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const replies: { id: number | string; result?: unknown; code?: number; message?: string }[] = []
  const openConnection = (async (
    _launch: CodexAppServerLaunch,
    handlers: CodexAppServerConnectionHandlers = {}
  ) => {
    const connection: FakeConnection = {
      handlers,
      pid: 4321,
      closed: false,
      request: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params: params ?? {} })
        if (method === 'thread/start' && params?.ephemeral === true) {
          if (options.hangNamingThreadStart) {
            return await new Promise<never>(() => {})
          }
          // Leaves the naming turn in flight: the thread id is known, but nothing
          // ever settles the collector, which is the window sub-agents run in.
          if (options.hangNamingTurn) {
            return { thread: { id: NAMING_THREAD, ephemeral: true } }
          }
          // The naming turn's frames arrive on this same connection.
          queueMicrotask(() => {
            if (!options.declineNamingTurn) {
              handlers.onNotification?.('item/completed', {
                threadId: NAMING_THREAD,
                item: {
                  type: 'agentMessage',
                  text: options.answer ?? '{"title":"Fix lease probe"}'
                }
              })
            }
            handlers.onNotification?.('turn/completed', { threadId: NAMING_THREAD })
          })
          return { thread: { id: NAMING_THREAD } }
        }
        if (method === 'thread/start') {
          return { thread: { id: THREAD_ID } }
        }
        if (method === 'thread/read') {
          return {
            thread: {
              id: THREAD_ID,
              ...(options.existingName ? { name: options.existingName } : {})
            }
          }
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn-1' } }
        }
        return {}
      },
      notify: () => {},
      respond: (id: number | string, result: unknown) => replies.push({ id, result }),
      respondWithError: (id: number | string, code: number, message: string) =>
        replies.push({ id, code, message }),
      close: async () => {
        connection.closed = true
        return true
      }
    } as FakeConnection
    connections.push(connection)
    return connection
  }) as typeof openCodexAppServerConnection
  return { connections, openConnection, calls, replies }
}

const NAMING_THREAD = 'thread-naming'

const USER_TURN = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'fix the flaky lease probe' }]
} as const

const IMAGE_ONLY_TURN = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'image', path: '/tmp/shot.png' }]
} as const

async function dispatchedAdapter(
  codex: ReturnType<typeof namingCodex>,
  naming: {
    readNamingAttempted?: () => boolean
    markNamingAttempted?: () => void
    body?: unknown
  } = {}
) {
  const { body = USER_TURN, ...namingDeps } = naming
  const onConversationName = vi.fn()
  const events: unknown[] = []
  const adapter = new CodexStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: null,
      resumeThreadId: null
    }),
    openConnection: codex.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    onEvent: (event) => events.push(event),
    onConversationName,
    ...namingDeps
  })
  await adapter.acquire({ identity, fence: 7, spawnToken: 'spawn-9' })
  await adapter.dispatch({
    sessionId: SESSION,
    clientMessageId: 'client-1',
    body: body as never,
    fence: 7
  })
  return { adapter, onConversationName, events }
}

/** Lets the naming flow's microtask chain and awaited requests settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

describe('Codex conversation-name generation', () => {
  it('names the thread after the first accepted turn', async () => {
    const codex = namingCodex()
    const { onConversationName } = await dispatchedAdapter(codex)
    await settle()

    expect(codex.calls.find((call) => call.method === 'thread/name/set')?.params).toEqual({
      threadId: THREAD_ID,
      name: 'Fix lease probe'
    })
    expect(onConversationName).toHaveBeenCalledWith(SESSION, 'Fix lease probe')
  })

  it('keeps the naming turn out of the user transcript', async () => {
    const codex = namingCodex()
    const { events } = await dispatchedAdapter(codex)
    await settle()

    // The item translator journals items from ANY thread, so the only thing
    // keeping the naming prompt and its JSON answer out of the chat is the
    // adapter's thread gate. Nothing carrying the naming thread may be emitted.
    const leaked = events.filter(
      (event) => (event as { threadId?: string }).threadId === NAMING_THREAD
    )
    expect(leaked).toEqual([])
    expect(JSON.stringify(events)).not.toContain('Fix lease probe')
  })

  it('asks only once across a re-acquisition, which builds a NEW session', async () => {
    // A second acquisition rebuilds the session object, so the in-memory flag
    // resets. Only the durable marker stops the user's next message paying for
    // a second naming turn — and re-imposing a name they may have cleared.
    let attempted = false
    const naming = {
      readNamingAttempted: () => attempted,
      markNamingAttempted: () => {
        attempted = true
      }
    }
    const first = namingCodex({ declineNamingTurn: true })
    await dispatchedAdapter(first, naming)
    await settle()
    const second = namingCodex({ declineNamingTurn: true })
    await dispatchedAdapter(second, naming)
    await settle()

    const ephemeralStarts = (codex: ReturnType<typeof namingCodex>) =>
      codex.calls.filter((call) => call.method === 'thread/start' && call.params.ephemeral === true)
    expect(ephemeralStarts(first)).toHaveLength(1)
    expect(ephemeralStarts(second)).toHaveLength(0)
  })

  it('asks only once per session, even when the first attempt produced no name', async () => {
    // A model that declines to answer leaves `conversationName` null, so the
    // one-shot flag is the ONLY thing stopping a second attempt. With a name set
    // this test would pass on the name check and prove nothing.
    const codex = namingCodex({ declineNamingTurn: true })
    const { adapter } = await dispatchedAdapter(codex)
    await settle()
    const namingThreads = () =>
      codex.calls.filter((call) => call.method === 'thread/start' && call.params.ephemeral === true)
    expect(namingThreads()).toHaveLength(1)

    await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: USER_TURN as never,
      fence: 7
    })
    await settle()

    expect(namingThreads()).toHaveLength(1)
    expect(codex.calls.some((call) => call.method === 'thread/name/set')).toBe(false)
  })

  // NOTE: this holds under the old fail-open predicate too — the thread has a
  // name either way. The it.each in codex-conversation-name-generation.test.ts
  // is what binds the fail-closed change; this covers the end-to-end wiring.
  it('reports no name when the thread was named while it was generating', async () => {
    const codex = namingCodex({ existingName: 'A person named this' })
    const { onConversationName } = await dispatchedAdapter(codex)
    await settle()

    expect(codex.calls.some((call) => call.method === 'thread/name/set')).toBe(false)
    expect(onConversationName).not.toHaveBeenCalled()
  })
})

describe('Codex naming attempt accounting', () => {
  it('leaves the attempt unspent when the first message carries no text', async () => {
    const codex = namingCodex()
    const markNamingAttempted = vi.fn()
    const { adapter, onConversationName } = await dispatchedAdapter(codex, {
      body: IMAGE_ONLY_TURN,
      markNamingAttempted
    })
    await settle()

    const ephemeralStarts = () =>
      codex.calls.filter((call) => call.method === 'thread/start' && call.params.ephemeral === true)
    expect(ephemeralStarts()).toHaveLength(0)
    expect(markNamingAttempted).not.toHaveBeenCalled()

    // The conversation must stay nameable: a caption-free screenshot is not an
    // answer, so the next message with text still gets to ask.
    await adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'client-2',
      body: USER_TURN as never,
      fence: 7
    })
    await settle()

    expect(ephemeralStarts()).toHaveLength(1)
    expect(onConversationName).toHaveBeenCalledExactlyOnceWith(SESSION, 'Fix lease probe')
  })
})

describe('Codex naming-turn isolation', () => {
  /** Every event the adapter emitted for the user's session, by thread. */
  function emittedThreads(events: unknown[]): string[] {
    return events.map((event) => String((event as { threadId?: string }).threadId))
  }

  it('refuses an approval request from the naming turn instead of prompting the user', async () => {
    const codex = namingCodex()
    const { events } = await dispatchedAdapter(codex)
    await settle()

    codex.connections[0]!.handlers.onServerRequest?.({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: NAMING_THREAD, command: 'rm -rf /' }
    })
    await settle()

    // A prompt here would be durable, would name a command the user never asked
    // for, and would stay pending forever once the naming turn is abandoned.
    expect(codex.replies).toContainEqual(expect.objectContaining({ id: 77, code: -32001 }))
    expect(emittedThreads(events)).not.toContain(NAMING_THREAD)
    expect(JSON.stringify(events)).not.toContain('rm -rf /')
  })

  it('drops an unhandled frame from the naming turn', async () => {
    const codex = namingCodex()
    const { events } = await dispatchedAdapter(codex)
    await settle()
    const before = events.length

    codex.connections[0]!.handlers.onUnhandledFrame?.('notification:mysteryOpcode', {
      threadId: NAMING_THREAD,
      message: 'naming turn noise'
    })
    await settle()

    expect(events).toHaveLength(before)
    expect(JSON.stringify(events)).not.toContain('naming turn noise')
  })

  it('still journals the user own thread frames while a naming turn runs', async () => {
    const codex = namingCodex()
    const { events } = await dispatchedAdapter(codex)
    await settle()

    codex.connections[0]!.handlers.onNotification?.('item/completed', {
      threadId: THREAD_ID,
      item: { type: 'agentMessage', text: 'the real answer' }
    })
    await settle()

    // The gate must not be a blanket drop: the user's own frames still arrive.
    expect(emittedThreads(events)).toContain(THREAD_ID)
    expect(JSON.stringify(events)).toContain('the real answer')
  })

  it('keeps dropping naming-thread frames after the turn is abandoned', async () => {
    const codex = namingCodex()
    const { events } = await dispatchedAdapter(codex)
    await settle()
    const settled = events.length

    // A turn that timed out is never cancelled, so it can still emit long after
    // the flow gave up. The thread is retained for the session's life.
    codex.connections[0]!.handlers.onNotification?.('item/completed', {
      threadId: NAMING_THREAD,
      item: { type: 'agentMessage', text: '{"title":"Late leak"}' }
    })
    await settle()

    expect(events).toHaveLength(settled)
    expect(JSON.stringify(events)).not.toContain('Late leak')
  })
})

const SUBAGENT_THREAD = 'thread-subagent'

describe('Codex marks attempted only on a settled answer', () => {
  it('does NOT mark when the host could not open a throwaway thread', async () => {
    const markNamingAttempted = vi.fn()
    // `thread/start {ephemeral}` never yields a usable thread: a host that could
    // not be asked must stay askable, or upgrading it rescues nothing.
    const codex = namingCodex()
    const openConnection = codex.openConnection
    const stalled = {
      ...codex,
      openConnection: (async (...args: Parameters<typeof openCodexAppServerConnection>) => {
        const connection = (await openConnection(...args)) as FakeConnection
        const inner = connection.request
        connection.request = (async (method: string, params?: Record<string, unknown>) =>
          method === 'thread/start' && params?.ephemeral === true
            ? {}
            : inner(method, params)) as FakeConnection['request']
        return connection
      }) as typeof openCodexAppServerConnection
    }

    await dispatchedAdapter(stalled, { markNamingAttempted })
    await settle()

    expect(markNamingAttempted).not.toHaveBeenCalled()
  })

  it('DOES mark when the model completed and said nothing', async () => {
    const markNamingAttempted = vi.fn()

    // A genuine decline settles. Prose that ignored the schema does NOT — that
    // is a model that could not be asked properly, and it stays askable.
    await dispatchedAdapter(namingCodex({ declineNamingTurn: true }), {
      markNamingAttempted
    })
    await settle()

    expect(markNamingAttempted).toHaveBeenCalledWith(SESSION)
  })
})

describe('Codex sub-agent threads survive the naming window', () => {
  /** Every thread id the adapter emitted for the user's session. */
  function emittedThreads(events: unknown[]): string[] {
    return events.map((event) => String((event as { threadId?: string }).threadId))
  }

  it('journals a sub-agent turn that runs while naming is in flight', async () => {
    const codex = namingCodex({ hangNamingTurn: true })
    const { events } = await dispatchedAdapter(codex)
    await settle()

    codex.connections[0]!.handlers.onNotification?.('item/completed', {
      threadId: SUBAGENT_THREAD,
      item: { type: 'agentMessage', text: 'subagent finished its work' }
    })
    await settle()

    // A sub-agent runs its own thread over this same connection. Treating it as
    // a naming frame would drop its rows from the transcript entirely.
    expect(emittedThreads(events)).toContain(SUBAGENT_THREAD)
    expect(JSON.stringify(events)).toContain('subagent finished its work')
  })

  it('prompts the user for a sub-agent approval sent during the thread/start window', async () => {
    // No naming thread id exists yet, so only the broad rule could match — and
    // on the request path it can only ever match a genuine sub-agent, because
    // the naming thread has no turn running to ask with.
    const codex = namingCodex({ hangNamingThreadStart: true })
    const { events } = await dispatchedAdapter(codex)
    await settle()

    codex.connections[0]!.handlers.onServerRequest?.({
      id: 92,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: SUBAGENT_THREAD, itemId: 'item-subagent-2', command: 'pnpm test' }
    })
    await settle()

    expect(codex.replies).toEqual([])
    const prompts = events.filter((event) => (event as { type?: string }).type === 'prompt')
    expect(prompts).toEqual([
      expect.objectContaining({ threadId: SUBAGENT_THREAD, codexItemId: 'item-subagent-2' })
    ])
  })

  it('prompts the user for a sub-agent approval instead of auto-refusing it', async () => {
    const codex = namingCodex({ hangNamingTurn: true })
    const { events } = await dispatchedAdapter(codex)
    await settle()

    codex.connections[0]!.handlers.onServerRequest?.({
      id: 91,
      method: 'item/commandExecution/requestApproval',
      // `itemId` is what makes this a durable PROMPT rather than a request the
      // registry declines; without it the assertion below would pass on a
      // different refusal and prove nothing about reaching the user.
      params: { threadId: SUBAGENT_THREAD, itemId: 'item-subagent-1', command: 'pnpm test' }
    })
    await settle()

    expect(codex.replies).toEqual([])
    // It reaches the user as a prompt, which is the behaviour the narrowed gate
    // restored — not merely "some event was emitted".
    const prompts = events.filter((event) => (event as { type?: string }).type === 'prompt')
    expect(prompts).toEqual([
      expect.objectContaining({ threadId: SUBAGENT_THREAD, codexItemId: 'item-subagent-1' })
    ])
  })

  it('still keeps the naming thread out once its id is known', async () => {
    const codex = namingCodex({ hangNamingTurn: true })
    const { events } = await dispatchedAdapter(codex)
    await settle()
    const before = events.length

    codex.connections[0]!.handlers.onNotification?.('item/completed', {
      threadId: NAMING_THREAD,
      item: { type: 'agentMessage', text: '{"title":"Still hidden"}' }
    })
    await settle()

    expect(events).toHaveLength(before)
    expect(JSON.stringify(events)).not.toContain('Still hidden')
  })
})

describe('Codex leaves a schema-ignoring model askable', () => {
  it('does NOT mark when the naming turn answered in prose', async () => {
    const markNamingAttempted = vi.fn()

    // Marking here makes the conversation permanently unnameable, even after the
    // user switches to a model that honours the output schema.
    await dispatchedAdapter(namingCodex({ answer: 'Sure! How about "Fix probe"?' }), {
      markNamingAttempted
    })
    await settle()

    expect(markNamingAttempted).not.toHaveBeenCalled()
  })
})
