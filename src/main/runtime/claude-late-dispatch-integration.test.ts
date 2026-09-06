import { randomUUID } from 'node:crypto'
import type * as ProcessIdentityProbe from './agent-session-process-identity-probe'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import {
  createStructuredAgentSessionOutboxEntry,
  reconcileStructuredAgentSessionOutbox
} from '../../shared/structured-agent-session-outbox'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { fakeClaude } from '../claude/claude-structured-session-test-support'
import { claudeSessionIdForOrcaSession } from '../claude/claude-structured-launch-resolution'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams,
  hostTestMessage
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

vi.mock('../native-chat/session-file-resolver', () => ({
  readClaudeTranscriptLeafUuid: vi.fn(async () => null),
  resolveSessionFilePath: vi.fn(async () => null)
}))

// The scripted child must remain live when the real lease-renewal timer probes its fake PID.
vi.mock('./agent-session-process-identity-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessIdentityProbe>()),
  probeAgentSessionProcessIdentities: async ({ identities }: { identities: unknown[] }) =>
    identities.map(() => ({ outcome: 'identity-matched', matchedOn: ['process-start-time'] }))
}))

let root: string

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('settles a timed-out unknown through the runtime, publishes outbox removal and fences retries', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-late-dispatch-'))
  const providerSessionId = claudeSessionIdForOrcaSession(SESSION)
  const claude = fakeClaude({ initSessionId: providerSessionId, replayUuids: [null, 'second'] })
  const onError = vi.fn()
  const operationId = () => `${Date.now()}-${randomUUID().replaceAll('-', '')}`
  const host = await ensureStructuredAgentSessionHost({
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeCommand: () => 'claude',
    resolveCodexCommand: () => 'codex',
    resolveEnvironment: async () => ({}),
    resolveClaudeLaunchEnv: () => ({}),
    resolveClaudeAuthPolicy: () => ({ stripAuthEnv: false }),
    openClaudeConnection: claude.openConnection,
    readProcessStartTime: async () => 100,
    onError
  })
  const caller = { callerKey: 'client-1' }
  const attachParams = hostTestAttachParams(null, {
    provider: 'claude',
    agent: 'claude',
    providerHandle: undefined,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root }
  })
  attachParams.envelope.clientOperationId = operationId()
  const attached = await host.attach(caller, attachParams)
  const { handlers, sent, calls } = claude.connections[0]!
  expect(attached, JSON.stringify(attached)).toMatchObject({ ok: true })
  if (!attached.ok) {
    throw new Error(attached.refusal.message)
  }
  const fence = attached.value.fence
  const envelope = (method: string, fields: Record<string, unknown>) => ({
    sessionId: SESSION,
    clientOperationId: operationId(),
    expectedRuntimeFence: fence,
    payloadFingerprint: computeAgentSessionPayloadFingerprint({
      method,
      sessionId: SESSION,
      fields
    })
  })
  const frames: AgentSessionSubscribeEvent[] = []
  const unsubscribe = host.subscribe({
    sessionId: SESSION,
    id: 'late-replay',
    emit: (frame) => frames.push(frame)
  })
  const body = hostTestMessage('first')
  const params = { envelope: envelope('agentSession.send', { body }), body }
  const first = await host.send(caller, params)
  expect(first).toMatchObject({ ok: true, value: { submission: { dispatchState: 'unknown' } } })
  if (!first.ok) {
    throw new Error(first.refusal.message)
  }
  const outbox = [
    createStructuredAgentSessionOutboxEntry({
      sessionId: SESSION,
      clientMessageId: first.value.clientMessageId,
      text: 'first',
      attachments: [],
      queuedAt: 1
    })
  ]
  expect(reconcileStructuredAgentSessionOutbox(outbox, [first.value.submission])[0]?.state).toBe(
    'unconfirmed'
  )
  claude.connections[0]!.send = async (message) => {
    sent.push(message)
    handlers.onMessage?.(message)
  }
  const secondBody = hostTestMessage('second')
  await host.send(caller, {
    envelope: envelope('agentSession.send', { body: secondBody }),
    body: secondBody
  })
  const submissions = (): AgentJournalSubmission[] => {
    const page = host.history({ sessionId: SESSION, direction: 'tail' })
    return page.ok ? page.page.submissions : []
  }
  handlers.onMessage?.(sent[0]!)
  await vi.waitFor(() =>
    expect(submissions().map((row) => row.dispatchState)).toEqual(['accepted', 'accepted'])
  )
  expect(reconcileStructuredAgentSessionOutbox(outbox, submissions())).toEqual([])
  expect(
    frames.some(
      (frame) =>
        frame.type === 'batch' &&
        frame.batch.submissions.some(
          (row) =>
            row.clientMessageId === first.value.clientMessageId && row.dispatchState === 'accepted'
        )
    )
  ).toBe(true)
  const beforeRepeat = submissions()
  handlers.onMessage?.(sent[0]!)
  const retry = await host.send(caller, { ...params, retryUnknown: true })
  expect(retry).toMatchObject({ ok: true, value: { submission: { dispatchState: 'accepted' } } })
  expect(submissions()).toEqual(beforeRepeat)
  expect(sent).toHaveLength(2)
  const turnId = sent[1]!.uuid as string
  const cancelled = await host.cancel(caller, {
    envelope: envelope('agentSession.cancel', { turnId }),
    turnId
  })
  expect(cancelled).toMatchObject({ ok: true })
  expect(calls.filter((call) => call.subtype === 'interrupt')).toHaveLength(1)
  unsubscribe()
  expect(onError).not.toHaveBeenCalled()
}, 20_000)
