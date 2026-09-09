import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { projectStructuredAgentSessionStatus } from '../../shared/structured-agent-session-projection'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-store-test-open'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

const SESSION_ID = 'session-1'
const THREAD_ID = 'thread-abc'
const TURN_ID = 'turn-1'
const LIFECYCLE_KEY = 'legacy:codex:session-1:turn-lifecycle%3Aturn-1'

type Row = { key: string; body: AgentJournalItemBody }

function recorder() {
  const rows: Row[] = []
  const tombstones: string[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: (identity) => tombstones.push(agentJournalItemKey(identity)),
    publish: () => {}
  }
  return { sink, rows, tombstones }
}

/** Latest body per identity, in first-seen order: what the journal reducer keeps. */
function reduced(rows: readonly Row[]): Row[] {
  const latest = new Map<string, Row>()
  for (const row of rows) {
    latest.set(row.key, row)
  }
  return [...latest.values()]
}

function notification(
  method: string,
  params: unknown,
  observedAt?: number
): CodexStructuredSessionEvent {
  return {
    type: 'notification',
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    method,
    params,
    ...(observedAt !== undefined ? { observedAt } : {})
  }
}

function translatorFor(tap: ReturnType<typeof recorder>, now?: () => number) {
  return createCodexJournalTranslator({
    sink: tap.sink,
    sessionId: SESSION_ID,
    primaryThreadId: () => THREAD_ID,
    ...(now ? { now } : {})
  })
}

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-turn-lifecycle-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('codex turn lifecycle rows', () => {
  it('opens the running row with the host receipt time and pins the row time to it', async () => {
    const journal = await journals.open({
      identity: {
        sessionId: SESSION_ID,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD_ID }
      },
      now: () => 9_000,
      journalDir: join(root, SESSION_ID)
    })
    const deferred = createDeferredStructuredAgentSessionEventSink()
    const translator = createCodexJournalTranslator({
      sink: deferred.sink,
      sessionId: SESSION_ID,
      primaryThreadId: () => THREAD_ID
    })
    deferred.bind({ journal, fence: 1, publish: () => {} })

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    await expect(deferred.drained()).resolves.toEqual({ ok: true })

    expect(journal.snapshot().items).toEqual([
      expect.objectContaining({
        observedAt: 1_000,
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: TURN_ID, state: 'running', startedAt: 1_000 }
        }
      })
    ])
    deferred.close()
  })

  it('revises the running row to completed, carrying the start time forward', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
    translator.handle(
      notification('turn/completed', { turn: { id: TURN_ID, status: 'completed' } }, 4_500)
    )

    expect(tap.tombstones).toEqual([])
    expect(tap.rows).toEqual([
      {
        key: LIFECYCLE_KEY,
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: TURN_ID, state: 'running', startedAt: 1_000 }
        }
      },
      {
        key: LIFECYCLE_KEY,
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: {
            turnId: TURN_ID,
            state: 'completed',
            startedAt: 1_000,
            completedAt: 4_500
          }
        }
      }
    ])
    expect(
      projectStructuredAgentSessionStatus(
        reduced(tap.rows).map((row, sequence) => ({
          itemId: row.key,
          revision: 1,
          sequence: sequence + 1,
          observedAt: sequence + 1,
          body: row.body
        }))
      )
    ).toBe('idle')
  })

  it.each(['interrupted', 'failed', 'cancelled'])(
    'maps a %s turn status to an interrupted lifecycle',
    (status) => {
      const tap = recorder()
      const translator = translatorFor(tap)

      translator.handle(notification('turn/started', { turn: { id: TURN_ID } }, 1_000))
      translator.handle(notification('turn/completed', { turn: { id: TURN_ID, status } }, 2_000))

      expect(tap.rows.at(-1)?.body).toMatchObject({
        turnLifecycle: { state: 'interrupted', startedAt: 1_000, completedAt: 2_000 }
      })
    }
  )

  it('stamps the host clock when a boundary arrives without a receipt time', () => {
    const tap = recorder()
    let clock = 10_000
    const translator = translatorFor(tap, () => (clock += 250))

    translator.handle(notification('turn/started', { turn: { id: TURN_ID } }))
    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }))

    expect(tap.rows.map((row) => row.body)).toMatchObject([
      { turnLifecycle: { state: 'running', startedAt: 10_250 } },
      { turnLifecycle: { state: 'completed', startedAt: 10_250, completedAt: 10_500 } }
    ])
  })

  it('writes only the end time when the start was never observed', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    translator.handle(notification('turn/completed', { turn: { id: TURN_ID } }, 3_000))

    expect(tap.rows).toEqual([
      {
        key: LIFECYCLE_KEY,
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: { turnId: TURN_ID, state: 'completed', completedAt: 3_000 }
        }
      }
    ])
  })

  it('revises every open turn to interrupted when the provider ends', () => {
    const tap = recorder()
    const translator = translatorFor(tap, () => 7_000)

    translator.handle(notification('turn/started', { turn: { id: 'turn-a' } }, 1_000))
    translator.handle(notification('turn/started', { turn: { id: 'turn-b' } }, 2_000))
    translator.handle({ type: 'ended', sessionId: SESSION_ID, reason: 'app-server exited' })

    expect(tap.tombstones).toEqual([])
    expect(reduced(tap.rows).map((row) => row.body)).toMatchObject([
      {
        turnLifecycle: {
          turnId: 'turn-a',
          state: 'interrupted',
          startedAt: 1_000,
          completedAt: 7_000
        }
      },
      {
        turnLifecycle: {
          turnId: 'turn-b',
          state: 'interrupted',
          startedAt: 2_000,
          completedAt: 7_000
        }
      },
      { text: 'Provider exited: app-server exited' }
    ])
  })

  it('restores terminal rows for historical turns with both endpoints, in milliseconds', () => {
    const tap = recorder()
    const translator = translatorFor(tap)

    expect(
      translator.restoreThread(THREAD_ID, {
        turns: [
          {
            id: 'turn-done',
            status: 'completed',
            startedAt: 1_700_000_000,
            completedAt: 1_700_000_042,
            items: [{ type: 'agentMessage', id: 'agent-done', text: 'done' }]
          },
          {
            id: 'turn-cut',
            status: 'interrupted',
            startedAt: 1_700_000_100,
            completedAt: 1_700_000_101,
            items: []
          },
          { id: 'turn-open', status: 'inProgress', startedAt: 1_700_000_200, items: [] },
          { id: 'turn-untimed', status: 'completed', items: [] }
        ]
      })
    ).toEqual({ accepted: true })

    expect(tap.rows).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ kind: 'message' }) }),
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-done',
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: {
            turnId: 'turn-done',
            state: 'completed',
            startedAt: 1_700_000_000_000,
            completedAt: 1_700_000_042_000
          }
        }
      },
      {
        key: 'legacy:codex:session-1:turn-lifecycle%3Aturn-cut',
        body: {
          kind: 'status',
          text: 'Codex is working…',
          turnLifecycle: {
            turnId: 'turn-cut',
            state: 'interrupted',
            startedAt: 1_700_000_100_000,
            completedAt: 1_700_000_101_000
          }
        }
      }
    ])
    expect(tap.tombstones).toEqual([])
  })

  it('restores no lifecycle rows without a session identity to key them by', () => {
    const tap = recorder()
    const translator = createCodexJournalTranslator({
      sink: tap.sink,
      primaryThreadId: () => THREAD_ID
    })

    translator.restoreThread(THREAD_ID, {
      turns: [{ id: 'turn-done', status: 'completed', startedAt: 1, completedAt: 2, items: [] }]
    })

    expect(tap.rows).toEqual([])
  })
})
