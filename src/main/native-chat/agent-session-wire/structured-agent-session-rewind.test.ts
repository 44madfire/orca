import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AgentSessionRewindRefusal } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type {
  StructuredAgentSessionAdapter,
  StructuredAgentSessionAcquireInput,
  AgentSessionDispatchOutcome
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let sink: StructuredAgentSessionEventSink
let adapter: StructuredAgentSessionAdapter
let acquires: StructuredAgentSessionAcquireInput[]
const rewind = vi.fn<NonNullable<StructuredAgentSessionAdapter['rewind']>>()
let failClaude = false

beforeEach(async () => {
  resetHostTestOperationIds()
  rewind.mockReset().mockResolvedValue({ ok: true })
  failClaude = false
  acquires = []
  directory = await mkdtemp(join(tmpdir(), 'orca-rewind-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  adapter = {
    supportsLocation: () => true,
    acquire: async (input) => {
      acquires.push(input)
      if (input.rewind && failClaude) {
        throw new AgentSessionRewindRefusal('provider-refused')
      }
      sink = input.events!
      const handle = input.identity.providerHandle
      return {
        process: {
          hostId: 'local',
          pid: 4000 + acquires.length,
          processStartTimeMs: HOST_TEST_NOW,
          spawnToken: input.spawnToken
        },
        acquisitionGeneration: `generation-${acquires.length}`,
        link: {
          linkId: `link-${acquires.length}`,
          mintedAtFence: input.fence,
          observedAt: HOST_TEST_NOW,
          origin: acquires.length === 1 ? 'created' : 'resumed',
          handle:
            handle.kind === 'claude'
              ? {
                  provider: 'claude',
                  sessionId: handle.sessionId,
                  leafUuid: input.rewind?.targetUuid ?? 'tip'
                }
              : { provider: 'codex', threadId: HOST_TEST_THREAD }
        }
      }
    },
    dispatch: vi.fn(async (): Promise<AgentSessionDispatchOutcome> => ({
      state: 'unknown',
      reason: 'test'
    })),
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => {},
    setOption: async () => {},
    rewindSupport: () => ({ supported: true }),
    rewind,
    releaseAcquisition: async () => true,
    closeSession: async () => true
  }
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: directory,
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'exit-observed' })
  })
})
afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

async function seed(provider: 'codex' | 'claude' = 'codex') {
  const params =
    provider === 'codex'
      ? hostTestAttachParams(null)
      : hostTestAttachParams(null, {
          provider,
          agent: provider,
          accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/claude' },
          providerHandle: { kind: 'claude', sessionId: 'claude-session', leafUuid: 'tip' }
        })
  expect(await host.attach(caller, params)).toMatchObject({ ok: true })
  const keys = ['kept', 'drop', 'tip'].map((uuid) =>
    provider === 'codex'
      ? { provider, threadId: HOST_TEST_THREAD, turnId: uuid, ordinal: 0 }
      : { provider, sessionId: 'claude-session', uuid }
  )
  keys.forEach((identity, i) =>
    sink.appendItem(identity, {
      ...hostTestMessage(String(i)),
      role: i === 2 ? 'assistant' : 'user'
    })
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  return agentJournalItemKey(keys[1]!)
}
function params(
  itemId: string,
  expectedEpoch = host.journalSnapshot(HOST_TEST_SESSION).cursor.epoch
) {
  return {
    itemId,
    expectedEpoch,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId: HOST_TEST_SESSION,
        fields: { itemId, expectedEpoch }
      })
    }
  }
}

describe('host rewind', () => {
  it('finishes a durable provider success on reattach without repeating the provider mutation', async () => {
    const target = await seed()
    const request = params(target)
    const replace = vi
      .spyOn(AgentSessionJournal.prototype, 'replaceEpochItems')
      .mockRejectedValueOnce(new Error('disk failed'))
    await expect(host.rewind(caller, request)).rejects.toThrow('disk failed')
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('provider-succeeded')
    replace.mockRestore()
    const fence = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.attach(caller, hostTestAttachParams(fence))).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
    expect(rewind).toHaveBeenCalledTimes(1)
  })

  it('recovers the saved full prefix when hydration fails after native revert acknowledgement', async () => {
    const target = await seed()
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    rewind.mockImplementation(async (input) => {
      await input.onReverted?.()
      throw new Error('history unavailable')
    })
    await expect(host.rewind(caller, params(target))).rejects.toThrow('history unavailable')
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('provider-succeeded')
    expect(
      await host.attach(
        caller,
        hostTestAttachParams(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence)
      )
    ).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
    expect(rewind).toHaveBeenCalledTimes(1)
  })
  it('fences stale owners and the second of two concurrent rewinds', async () => {
    const target = await seed()
    const stale = params(target)
    stale.envelope.expectedRuntimeFence++
    expect(await host.rewind(caller, stale)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_checkpoint_stale' }
    })
    let finish!: () => void
    rewind.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true })
        })
    )
    const first = host.rewind(caller, params(target))
    const second = host.rewind(caller, params(target))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    finish()
    expect(await first).toMatchObject({ ok: true })
    expect(await second).toMatchObject({ ok: false, refusal: { rewindReason: 'stale-epoch' } })
    expect(rewind).toHaveBeenCalledTimes(1)
  })
  it('replaces the epoch with the retained prefix and replays without another provider call', async () => {
    const target = await seed()
    const request = params(target)
    const result = await host.rewind(caller, request)
    expect(result).toMatchObject({ ok: true })
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(1)
    expect(host.journalSnapshot(HOST_TEST_SESSION).cursor.epoch).not.toBe(request.expectedEpoch)
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true, replayed: true })
    expect(rewind).toHaveBeenCalledTimes(1)
  })
  it('reacquires Claude at the retained cursor with the same session and a new lease fence', async () => {
    const target = await seed('claude')
    const before = store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    expect(await host.rewind(caller, params(target))).toMatchObject({ ok: true })
    const emit = vi.fn()
    const unsubscribe = host.subscribe({ id: 'after-rewind', sessionId: HOST_TEST_SESSION, emit })
    emit.mockClear()
    sink.appendItem(
      { provider: 'claude', sessionId: 'claude-session', uuid: 'next' },
      hostTestMessage('next')
    )
    sink.publish()
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'batch' }))
    unsubscribe()
    expect(acquires[1]?.rewind).toEqual({
      targetUuid: 'kept',
      previousLeafUuid: 'tip',
      dropsTurn: 'drop'
    })
    expect(store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence).toBeGreaterThan(before)
    expect(store.getRecord(HOST_TEST_SESSION)!.lease.ownerProcess?.pid).toBe(4002)
    expect(host.journalSnapshot(HOST_TEST_SESSION).items).toHaveLength(2)
  })
  it('recovers a Claude refusal with one plain resume and preserves the journal', async () => {
    const target = await seed('claude')
    failClaude = true
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    expect(await host.rewind(caller, params(target))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'provider-refused' }
    })
    expect(acquires).toHaveLength(3)
    expect(acquires[2]?.rewind).toBeUndefined()
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(store.getRecord(HOST_TEST_SESSION)!.lease.claimStatus).toBe('live')
  })
  it('refuses a rewind racing an active turn before provider execution', async () => {
    const target = await seed()
    sink.appendItem(
      { provider: 'orca', clientMessageId: 'active' },
      { kind: 'status', text: 'working', turnLifecycle: { turnId: 'active', state: 'running' } }
    )
    expect(await host.rewind(caller, params(target))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'busy' }
    })
    expect(rewind).not.toHaveBeenCalled()
  })
  it('refuses stale epochs and targets from another provider', async () => {
    const target = await seed()
    expect(await host.rewind(caller, params(target, 'old-epoch'))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'stale-epoch' }
    })
    expect(await host.rewind(caller, params('claude:foreign'))).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'invalid-target' }
    })
    expect(rewind).not.toHaveBeenCalled()
  })
  it('keeps a failed hydration epoch intact and blocks sends and duplicate rewind', async () => {
    const target = await seed()
    const request = params(target)
    const before = host.journalSnapshot(HOST_TEST_SESSION)
    rewind.mockRejectedValue(new Error('hydration failed'))
    await expect(host.rewind(caller, request)).rejects.toThrow('hydration failed')
    expect(host.journalSnapshot(HOST_TEST_SESSION)).toEqual(before)
    expect(await host.rewind(caller, request)).toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_unknown' }
    })
    const body = hostTestMessage('new prompt')
    const envelope = {
      ...params(target).envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: HOST_TEST_SESSION,
        fields: { body }
      })
    }
    expect(await host.send(caller, { envelope, body })).toMatchObject({
      ok: false,
      refusal: { rewindReason: 'outcome-unknown' }
    })
    expect(adapter.dispatch).not.toHaveBeenCalled()
  })
})
