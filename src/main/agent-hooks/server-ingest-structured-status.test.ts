import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

const SESSION = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const TAB = structuredAgentSessionTabId(SESSION)
const STRUCTURED_PANE = structuredAgentSessionPaneKey(TAB, SESSION)
const OBSERVED_AT = 1_757_030_400_000

function summary(over: Partial<AgentSessionStatusSummary> = {}): AgentSessionStatusSummary {
  return {
    sessionId: SESSION,
    workspaceId: 'repo-1::/workspace/app',
    agent: 'codex',
    status: 'working',
    hostExecutionOwned: true,
    latestPrompt: 'ship the thing',
    model: 'gpt-6-astra',
    toolName: 'shell',
    toolInput: 'sleep 30',
    lastAssistantMessage: 'on it',
    updatedAt: OBSERVED_AT,
    ...over
  }
}

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AgentHookServer ingestStructuredStatus', () => {
  it('stores the projection as a row under the pane key the renderer derives', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary())

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({
        paneKey: STRUCTURED_PANE,
        tabId: TAB,
        worktreeId: 'repo-1::/workspace/app',
        connectionId: null,
        state: 'working',
        agentType: 'codex',
        prompt: 'ship the thing',
        model: 'gpt-6-astra',
        toolName: 'shell',
        toolInput: 'sleep 30',
        lastAssistantMessage: 'on it',
        structuredHost: 'owned',
        // The journal clock, not the ingest clock: a restart's republish is not new evidence.
        evidenceObservedAt: OBSERVED_AT,
        stateStartedAt: OBSERVED_AT
      })
    ])
    expect(server.getStatusSnapshot()[0]?.observation?.origin).toBe('structured')
  })

  // The same mapping the sidebar applies, so the two surfaces cannot disagree about one session.
  it('maps attention to blocked and idle to done', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ status: 'attention' }))
    expect(server.getStatusSnapshot()[0]?.state).toBe('blocked')
    server.ingestStructuredStatus(summary({ status: 'idle', updatedAt: OBSERVED_AT + 1 }))
    expect(server.getStatusSnapshot()[0]?.state).toBe('done')
  })

  it('marks a session whose provider child is gone as held, not owned', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ hostExecutionOwned: undefined }))
    expect(server.getStatusSnapshot()[0]?.structuredHost).toBe('held')
  })

  it('keeps the state start while later evidence of the same state arrives', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary())
    server.ingestStructuredStatus(summary({ toolName: 'read', updatedAt: OBSERVED_AT + 5_000 }))

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      toolName: 'read',
      evidenceObservedAt: OBSERVED_AT + 5_000,
      stateStartedAt: OBSERVED_AT
    })
  })

  // Null status means no turn has been persisted; the chat shows nothing, so neither does this.
  it('holds no row for a session without a persisted turn, and drops one that regresses to none', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary({ status: null }))
    expect(server.getStatusSnapshot()).toEqual([])

    server.ingestStructuredStatus(summary())
    server.ingestStructuredStatus(summary({ status: null }))
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('drops the row when the host stops holding the session', () => {
    const server = new AgentHookServer()
    server.ingestStructuredStatus(summary())
    server.dropStructuredStatus(SESSION)
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('leaves a hook-reported pane alone', () => {
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      payload: { state: 'working', prompt: 'watch the build', agentType: 'claude' }
    })
    server.ingestStructuredStatus(summary())

    const byPane = new Map(server.getStatusSnapshot().map((row) => [row.paneKey, row]))
    expect(byPane.get(PANE)?.structuredHost).toBeUndefined()
    expect(byPane.get(STRUCTURED_PANE)?.structuredHost).toBe('owned')
  })
})

describe('structured rows and last-status.json', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-structured-status-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  // The journal is the durable truth and the host republishes on restore; a persisted copy would
  // hydrate as unconfirmed and fight that republish.
  it('are never written, while hook rows still are', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: null,
        payload: { state: 'working', prompt: 'watch the build', agentType: 'claude' }
      })
      server.ingestStructuredStatus(summary())
      server.flushStatusPersistSync()
    } finally {
      server.stop()
    }

    const file = JSON.parse(readFileSync(lastStatusPath(), 'utf8')) as {
      entries: Record<string, unknown>
    }
    expect(Object.keys(file.entries)).toEqual([PANE])

    const restored = new AgentHookServer()
    await restored.start({ env: 'production', userDataPath })
    try {
      expect(restored.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
    } finally {
      restored.stop()
    }
  })

  it('are dropped on hydrate if some other writer put one on disk', async () => {
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
    writeFileSync(
      lastStatusPath(),
      JSON.stringify({
        version: 2,
        entries: {
          [STRUCTURED_PANE]: {
            paneKey: STRUCTURED_PANE,
            tabId: TAB,
            connectionId: null,
            receivedAt: Date.now(),
            stateStartedAt: Date.now(),
            structuredHost: 'owned',
            payload: { state: 'working', prompt: 'ship the thing', agentType: 'codex' }
          }
        }
      })
    )
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      server.stop()
    }
  })
})
