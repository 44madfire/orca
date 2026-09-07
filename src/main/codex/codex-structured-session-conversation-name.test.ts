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
