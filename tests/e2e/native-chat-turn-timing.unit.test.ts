// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { createElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createCodexJournalTranslator } from '../../src/main/codex/codex-structured-journal-translation'
import { createClaudeJournalTranslator } from '../../src/main/claude/claude-structured-journal-translation'
import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-event-sink'
import { projectJournalBatch } from '../../src/main/native-chat/agent-session-wire/agent-session-journal-batch'
import {
  projectStructuredItemsToNativeChat,
  projectStructuredAgentSessionStatus
} from '../../src/shared/structured-agent-session-projection'
import { structuredAgentSessionPayloadFingerprint } from '../../src/shared/structured-agent-session-mutation'
import { NativeChatMessageList } from '../../src/renderer/src/components/native-chat/NativeChatMessageList'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../src/shared/agent-session-journal-types'

const opened = createTrackedJournalOpener()
const roots: string[] = []
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await opened.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const start = 1_780_000_000_000
const identity: AgentSessionJournalIdentity = {
  sessionId: 'session',
  workspaceId: 'folder-workspace',
  hostId: 'remote-host',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread' }
}
async function setup(agent: 'codex' | 'claude' = 'codex') {
  const journalDir = await mkdtemp(join(tmpdir(), 'orca-turn-timing-'))
  roots.push(journalDir)
  const options = { journalDir, identity: { ...identity, agent }, now: () => start + 86_400_000 }
  const journal = await opened.open(options)
  const deferred = createDeferredStructuredAgentSessionEventSink()
  deferred.bind({ journal, fence: 1, publish: () => {} })
  return { journal, deferred, options }
}
async function submit(
  journal: Awaited<ReturnType<typeof setup>>['journal'],
  id: string,
  text: string
) {
  const body: AgentJournalMessageItem = {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  }
  await journal.appendSubmission({
    clientMessageId: id,
    body,
    fence: 1,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({
      method: 'agentSession.send',
      sessionId: 'session',
      fields: { body }
    })
  })
}
function show(items: Parameters<typeof projectStructuredItemsToNativeChat>[0], working = false) {
  return createElement(NativeChatMessageList, {
    session: {
      messages: projectStructuredItemsToNativeChat(items),
      status: working ? 'working' : 'ready',
      sessionId: 'session',
      agent: 'codex',
      hasMore: false,
      loadingEarlier: false,
      loadEarlier: () => {},
      readPhase: 'ready'
    },
    isWorking: working,
    workingStartedAt: null,
    expandSignal: false,
    fontScale: 1,
    showTurnStatus: true
  })
}

it('reopens a completed 3m7s turn next morning with no renderer cache and associates a second turn', async () => {
  const { journal, deferred, options } = await setup()
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => 'thread'
  })
  const event = (method: string, turnId: string, observedAt: number, endpoints = {}) =>
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params: { turn: { id: turnId, ...endpoints } },
      observedAt
    })
  await submit(journal, 'first', 'First task')
  event('turn/started', 'one', start)
  const beforeCompletion = journal.cursor()
  event('turn/completed', 'one', start + 187_000)
  expect(await deferred.drained()).toEqual({ ok: true })
  // Provider acceptance can arrive after both lifecycle edges have drained.
  await journal.resolveDispatch({
    clientMessageId: 'first',
    fence: 1,
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'one', ordinal: 0 }
  })
  expect(projectStructuredAgentSessionStatus(journal.snapshot().items)).toBe('idle')
  const rows = journal.readSince(beforeCompletion)
  expect(rows.ok).toBe(true)
  if (rows.ok) {
    const batch = projectJournalBatch({
      rows: rows.rows,
      snapshot: journal.snapshot(),
      afterSequence: beforeCompletion.sequence
    })
    expect(
      batch.ok && batch.batch.items.some((item) => item.turnTiming?.end?.at === start + 187_000)
    ).toBe(true)
  }
  translator.dispose()
  deferred.close()
  await journal.close()
  vi.spyOn(Date, 'now').mockReturnValue(start + 86_400_000)
  const reopened = await opened.open(options)
  const view = render(show(reopened.snapshot().items))
  expect(screen.getByText('Worked for 3m 7s')).toBeInTheDocument()
  expect(screen.queryByText(/24h/)).toBeNull()
  await submit(reopened, 'second', 'Second task')
  view.rerender(show(reopened.snapshot().items, true))
  expect(screen.getByText('Worked for 3m 7s')).toBeInTheDocument()
  expect(screen.getByText('Thinking')).toBeInTheDocument()
  expect(
    reopened.snapshot().items.find((item) => item.itemId.endsWith('second'))?.turnTiming
  ).toBeUndefined()
})

it('restores actual provider endpoints without restamping history and renders late authoritative correction', async () => {
  const { journal, deferred } = await setup()
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => 'thread'
  })
  translator.restoreThread('thread', {
    turns: [
      {
        id: 'old',
        startedAt: start / 1000,
        completedAt: start / 1000 + 187,
        items: [
          { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Historical task' }] }
        ]
      }
    ]
  })
  expect(await deferred.drained()).toEqual({ ok: true })
  const view = render(show(journal.snapshot().items))
  expect(screen.getByText('Worked for 3m 7s')).toBeInTheDocument()
  translator.restoreThread('thread', {
    turns: [
      {
        id: 'old',
        startedAt: start / 1000,
        completedAt: start / 1000 + 190,
        items: [
          { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Historical task' }] }
        ]
      }
    ]
  })
  await deferred.drained()
  view.rerender(show(journal.snapshot().items))
  expect(screen.getByText('Worked for 3m 10s')).toBeInTheDocument()
  translator.restoreThread('thread', {
    turns: [
      {
        id: 'unknown',
        items: [
          { id: 'user2', type: 'userMessage', content: [{ type: 'text', text: 'No endpoints' }] }
        ]
      }
    ]
  })
  await deferred.drained()
  expect(
    journal.snapshot().items.find((item) => item.itemId.includes('unknown'))?.turnTiming?.end
  ).toBeUndefined()
  translator.dispose()
  deferred.close()
})

it('persists Claude live endpoints but never stamps a replayed result on reopen', async () => {
  const { journal, deferred, options } = await setup('claude')
  const translator = createClaudeJournalTranslator({ sink: deferred.sink })
  await submit(journal, 'claude-user', 'Claude task')
  translator.handle({
    type: 'message',
    sessionId: 'session',
    startsTurn: true,
    observedAt: start,
    message: {
      type: 'user',
      session_id: 'provider',
      uuid: 'user',
      timestamp: new Date(start).toISOString(),
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Claude task' }] }
    }
  })
  translator.handle({
    type: 'message',
    sessionId: 'session',
    observedAt: start + 187_000,
    message: { type: 'result', subtype: 'success' }
  })
  await deferred.drained()
  await journal.resolveDispatch({
    clientMessageId: 'claude-user',
    fence: 1,
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'user' }
  })
  translator.dispose()
  deferred.close()
  await journal.close()
  const reopened = await opened.open(options)
  const replaySink = createDeferredStructuredAgentSessionEventSink()
  replaySink.bind({ journal: reopened, fence: 1, publish: () => {} })
  const replay = createClaudeJournalTranslator({ sink: replaySink.sink })
  replay.handle({
    type: 'message',
    sessionId: 'session',
    observedAt: start + 86_400_000,
    message: { type: 'result', subtype: 'success' }
  })
  await replaySink.drained()
  render(show(reopened.snapshot().items))
  expect(screen.getByText('Worked for 3m 7s')).toBeInTheDocument()
  replay.dispose()
  replaySink.close()
})

it('delivers late provider completion metadata after the original settlement batch and preserves retained rewind timing', async () => {
  const { journal, deferred } = await setup()
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    primaryThreadId: () => 'thread'
  })
  await submit(journal, 'late', 'Late correction')
  await journal.resolveDispatch({
    clientMessageId: 'late',
    fence: 1,
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'late', ordinal: 0 }
  })
  for (const [method, observedAt] of [
    ['turn/started', start],
    ['turn/completed', start + 200_000]
  ] as const) {
    translator.handle({
      type: 'notification',
      sessionId: 'session',
      threadId: 'thread',
      method,
      params: { turn: { id: 'late' } },
      observedAt
    })
  }
  await deferred.drained()
  const view = render(show(journal.snapshot().items))
  expect(screen.getByText('Worked for 3m 20s')).toBeInTheDocument()
  translator.handle({
    type: 'notification',
    sessionId: 'session',
    threadId: 'thread',
    method: 'turn/completed',
    params: { turn: { id: 'late', startedAt: start / 1000, completedAt: start / 1000 + 187 } }
  })
  await deferred.drained()
  view.rerender(show(journal.snapshot().items))
  expect(screen.getByText('Worked for 3m 7s')).toBeInTheDocument()
  const item = journal.snapshot().items.find((item) => item.body.kind === 'message')!
  await journal.replaceEpochItems('handle_forked', 1, [
    {
      identity: { provider: 'codex', threadId: 'thread', turnId: 'late', ordinal: 0 },
      body: item.body
    }
  ])
  view.rerender(show(journal.snapshot().items))
  expect(screen.getByText('Worked for 3m 7s')).toBeInTheDocument()
  translator.dispose()
  deferred.close()
})
