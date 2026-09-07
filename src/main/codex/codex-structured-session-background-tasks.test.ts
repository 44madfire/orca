import { describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTaskState } from '../../shared/agent-session-wire'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  openCodexAppServerConnection
} from './codex-app-server-connection'
import { CodexStructuredSessionAdapter } from './codex-structured-session-adapter'

// Proves the strip is actually REACHED from provider traffic: the tracker is
// unit-tested separately, and a producer that is correct but unwired publishes
// nothing while every one of its own tests stays green.

const THREAD_ID = '01a07d54-3785-71d0-b065-82c8ebbc572a'
const PARENT_TURN = '01a07d54-37be-72e1-8206-8f0c23dd2cef'
const CHILD_ID = '01a07d54-5523-78a3-91f5-e0acb1dab065'

/** A three-route stand-in, deliberately smaller than the full adapter harness:
 *  this suite only needs a thread and a notification pipe. */
function fakeCodex(): {
  handlers: () => CodexAppServerConnectionHandlers
  openConnection: typeof openCodexAppServerConnection
} {
  let live: CodexAppServerConnectionHandlers = {}
  const openConnection = (async (_launch, handlers = {}) => {
    live = handlers
    const connection: CodexAppServerConnection = {
      pid: 4321,
      closed: false,
      request: async (method) =>
        method === 'thread/start' ? { thread: { id: THREAD_ID, path: null } } : {},
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    } as unknown as CodexAppServerConnection
    return connection
  }) as typeof openCodexAppServerConnection
  return { handlers: () => live, openConnection }
}

function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'codex',
    providerHandle: { kind: 'codex', threadId: THREAD_ID }
  }
}

function subagentNotification(kind: string): { method: string; params: unknown } {
  return {
    method: 'item/started',
    params: {
      item: {
        type: 'subAgentActivity',
        id: 'call_1',
        kind,
        agentThreadId: CHILD_ID,
        agentPath: '/root/count_a'
      },
      threadId: THREAD_ID,
      turnId: PARENT_TURN
    }
  }
}

const TURN_COMPLETED = {
  method: 'turn/completed',
  params: { threadId: THREAD_ID, turn: { id: PARENT_TURN, status: 'completed' } }
}

async function adapterWithSession(
  published: { sessionId: string; state: AgentSessionBackgroundTaskState | null }[]
): Promise<{ adapter: CodexStructuredSessionAdapter; codex: ReturnType<typeof fakeCodex> }> {
  const codex = fakeCodex()
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
    onBackgroundTasksChanged: (sessionId, state) => published.push({ sessionId, state })
  })
  await adapter.acquire({ identity: identity('session-1'), fence: 7, spawnToken: 'spawn-9' })
  return { adapter, codex }
}

describe('codex background tasks reach the strip', () => {
  it('publishes the orphaned fan-out once the spawning turn completes', async () => {
    const published: { sessionId: string; state: AgentSessionBackgroundTaskState | null }[] = []
    const { adapter, codex } = await adapterWithSession(published)

    const spawn = subagentNotification('started')
    codex.handlers().onNotification?.(spawn.method, spawn.params)
    // The child is still inside the turn, so the strip stays silent.
    expect(published).toEqual([])
    expect(adapter.backgroundTaskState('session-1')).toBeNull()

    codex.handlers().onNotification?.(TURN_COMPLETED.method, TURN_COMPLETED.params)

    expect(published).toEqual([
      {
        sessionId: 'session-1',
        state: {
          state: 'monitoring',
          supportsStopAll: false,
          tasks: [{ id: `codex-agent:${CHILD_ID}`, kind: 'agent', description: 'count_a' }]
        }
      }
    ])
    expect(adapter.backgroundTaskState('session-1')).toEqual(published[0].state)
  })

  it('clears the strip when the session closes', async () => {
    const published: { sessionId: string; state: AgentSessionBackgroundTaskState | null }[] = []
    const { adapter, codex } = await adapterWithSession(published)
    const spawn = subagentNotification('started')
    codex.handlers().onNotification?.(spawn.method, spawn.params)
    codex.handlers().onNotification?.(TURN_COMPLETED.method, TURN_COMPLETED.params)
    published.length = 0

    expect(await adapter.closeSession('session-1')).toBe(true)

    // Explicit null, not silence: the reader answers `undefined` once the
    // session is gone, which every channel treats as "unchanged".
    expect(published).toEqual([{ sessionId: 'session-1', state: null }])
    expect(adapter.backgroundTaskState('session-1')).toBeUndefined()
  })
})
