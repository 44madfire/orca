// SNC1.6 adapter tests: structured images, model/thinking controls, prompts.
//
// Provider-neutral (no Pi imports). A Pi-like fake speaks only the generic
// bridge contract with Pi semantics: exact qualified provider/modelId refs,
// AMBIGUOUS_MODEL for duplicate bare ids, UNKNOWN_MODEL/UNKNOWN_THINKING_LEVEL
// fail-closed, and model-rejects-images gating.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import {
  EXTERNAL_BRIDGE_AGENT,
  ExternalStructuredSessionAdapter,
  type ExternalBridgeHostLike
} from './external-structured-session-adapter'
import type { SessionEventEnvelope } from './bridge-host'

const DEV_ENV = {
  ORCA_PI_BRIDGE_COMMAND: 'node /tmp/mock-provider-cli.js'
}
const DEV_ARGV = ['node', 'orca', '--enable-external-structured-bridge']

type Sink = StructuredAgentSessionEventSink & {
  items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]
  activities: unknown[]
  publishes: number
}

function makeSink(): Sink {
  const sink = {
    items: [] as { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[],
    activities: [] as unknown[],
    publishes: 0,
    appendItem(identity: AgentJournalItemIdentity, body: AgentJournalItemBody) {
      sink.items.push({ identity, body })
    },
    appendTombstone() {},
    publish() {
      sink.publishes += 1
    },
    setActivity(activity: unknown) {
      sink.activities.push(activity)
    }
  }
  return sink as unknown as Sink
}

function makeIdentity(overrides: Partial<AgentSessionJournalIdentity> = {}) {
  return {
    sessionId: 'sess-external-01',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: EXTERNAL_BRIDGE_AGENT,
    providerHandle: { kind: 'opaque', agent: EXTERNAL_BRIDGE_AGENT, value: 'pending' },
    ...overrides
  } as AgentSessionJournalIdentity
}

type DispatchReq = {
  sessionId: string
  text: string
  images?: { data: string; mimeType: string }[]
}

type FakeBase = ExternalBridgeHostLike & {
  events: (envelope: SessionEventEnvelope) => void
  dispatched: DispatchReq[]
  answered: { requestId: string; value: unknown; cancelled: boolean }[]
  dispatchImpl?: (
    req: DispatchReq
  ) => Promise<{ status: 'accepted' | 'rejected' | 'unknown'; opId: string; reason?: string }>
}

function makeBaseFake(sessionId = 'bridge-snc16-1'): FakeBase {
  const listeners = new Set<(envelope: SessionEventEnvelope) => void>()
  const fake = {
    providerPid: 4242,
    disposed: false,
    released: [] as string[],
    answered: [] as { requestId: string; value: unknown; cancelled: boolean }[],
    dispatched: [] as DispatchReq[],
    dispatchImpl: undefined as FakeBase['dispatchImpl'],
    events(envelope: SessionEventEnvelope) {
      for (const listener of listeners) {
        listener(envelope)
      }
    },
    get support() {
      return { available: true as const, reason: 'bridge-ready' }
    },
    async probeSupport() {
      return fake.support
    },
    async acquire() {
      return {
        sessionId,
        resumed: false,
        metadata: {
          sessionId,
          workspaceRoot: '/tmp/ws',
          messageCount: 0,
          isStreaming: false,
          createdAt: new Date(0).toISOString()
        }
      }
    },
    async release(id: string) {
      fake.released.push(id)
    },
    async dispatch(req: DispatchReq) {
      fake.dispatched.push(req)
      if (fake.dispatchImpl) {
        return fake.dispatchImpl(req)
      }
      return { status: 'accepted' as const, opId: 'dsp_fake_1' }
    },
    async cancel() {
      return { settled: false }
    },
    async answerPrompt(requestId: string, value: unknown, cancelled = false) {
      fake.answered.push({ requestId, value, cancelled })
    },
    async setOptions(_id: string, next: Record<string, unknown>) {
      return next as never
    },
    async getSession(id: string) {
      return {
        sessionId: id,
        workspaceRoot: '/tmp/ws',
        messageCount: 0,
        isStreaming: false,
        createdAt: new Date(0).toISOString()
      } as never
    },
    async dispose() {
      fake.disposed = true
    },
    onSessionEvent(listener: (envelope: SessionEventEnvelope) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onLifecycle() {
      return () => undefined
    }
  }
  return fake as unknown as FakeBase
}

type Snc16Fake = FakeBase & { setThinkingCalls: string[] }

// Pi-like semantics without Pi imports: exact refs, duplicate bare ids go
// ambiguous, unknown thinking fails closed, text-only models reject images.
function makeSnc16Fake(
  initial: { sessionId?: string; model?: string; thinking?: string } = {}
): Snc16Fake {
  const base = makeBaseFake(initial.sessionId ?? 'bridge-snc16-1')
  const models = [
    { provider: 'openai-codex', id: 'gpt-5.6-luna', images: true },
    { provider: 'opencode-go', id: 'gpt-5.6-luna', images: true },
    { provider: 'opencode-go', id: 'glm-5.3-flash', images: true },
    { provider: 'opencode-go', id: 'text-only-model', images: false }
  ]
  const levels = ['low', 'high', 'max']
  let model = initial.model ?? 'opencode-go/glm-5.3-flash'
  let thinkingLevel = initial.thinking ?? 'low'
  const setThinkingCalls: string[] = []
  function resolveModel(ref: string): { provider: string; id: string } {
    const trimmed = ref.trim()
    if (trimmed === '') {
      throw new Error('UNKNOWN_MODEL')
    }
    if (trimmed.includes('*')) {
      throw new Error('UNKNOWN_MODEL')
    }
    if (trimmed.includes('/')) {
      const [provider, ...rest] = trimmed.split('/')
      const id = rest.join('/')
      const found = models.find((m) => {
        return m.provider === provider && m.id === id
      })
      if (!found || !provider || !id) {
        throw new Error('UNKNOWN_MODEL')
      }
      return { provider, id }
    }
    const matches = models.filter((m) => {
      return m.id === trimmed
    })
    if (matches.length === 0) {
      throw new Error('UNKNOWN_MODEL')
    }
    if (matches.length > 1) {
      throw new Error('AMBIGUOUS_MODEL: use provider/modelId form')
    }
    return { provider: matches[0]!.provider, id: matches[0]!.id }
  }
  base.dispatchImpl = async (req) => {
    const current = models.find((m) => {
      return `${m.provider}/${m.id}` === model
    })
    if (req.images && req.images.length > 0 && current && !current.images) {
      return {
        status: 'rejected' as const,
        opId: 'dsp_img_reject',
        reason: `model-rejects-images: ${model}`
      }
    }
    return { status: 'accepted' as const, opId: 'dsp_snc16_1' }
  }
  const bridge = base as unknown as { setOptions: unknown; getSession: unknown; acquire: unknown }
  bridge.setOptions = async (_id: string, next: Record<string, unknown>) => {
    if (typeof next['model'] === 'string' && next['model'] !== '') {
      const resolved = resolveModel(next['model'] as string)
      model = `${resolved.provider}/${resolved.id}`
    }
    if (typeof next['thinkingLevel'] === 'string' && next['thinkingLevel'] !== '') {
      const level = next['thinkingLevel'] as string
      if (!levels.includes(level)) {
        throw new Error('UNKNOWN_THINKING_LEVEL')
      }
      setThinkingCalls.push(level)
      thinkingLevel = level
    }
    return { model, thinkingLevel } as never
  }
  bridge.getSession = async (id: string) => {
    return {
      sessionId: id,
      workspaceRoot: '/tmp/ws',
      model,
      thinkingLevel,
      messageCount: 0,
      isStreaming: false,
      createdAt: new Date(0).toISOString()
    } as never
  }
  const acquireOrig = base.acquire.bind(base)
  bridge.acquire = async () => {
    const out = (await acquireOrig()) as unknown as {
      sessionId: string
      resumed: boolean
      metadata: Record<string, unknown>
    }
    return { ...out, metadata: { ...out.metadata, model, thinkingLevel } } as never
  }
  const out = base as unknown as Snc16Fake
  ;(out as unknown as { setThinkingCalls: string[] }).setThinkingCalls = setThinkingCalls
  return out
}

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const TINY_BYTES = Buffer.from(TINY_PNG, 'base64')

describe('SNC1.6 structured images', () => {
  it('maps authorized image-ref attachments to bridge images[] opaquely', async () => {
    const fake = makeSnc16Fake({ sessionId: 'bridge-img-1' })
    const sink = makeSink()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
      readImageFile: (path) => {
        expect(path).toBe('/tmp/a.png')
        return TINY_BYTES
      }
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't', events: sink })
    const outcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-img',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'what is in this image?' },
          { type: 'image-ref', path: '/tmp/a.png' }
        ]
      },
      fence: 0
    })
    expect(outcome.state).toBe('accepted')
    expect(fake.dispatched).toHaveLength(1)
    expect(fake.dispatched[0]?.text).toBe('what is in this image?')
    expect(fake.dispatched[0]?.images).toEqual([{ data: TINY_PNG, mimeType: 'image/png' }])
    fake.events({
      sessionId: 'bridge-img-1',
      opId: 'dsp_snc16_1',
      event: { type: 'text_end', text: 'ONE-PIXEL' }
    })
    fake.events({
      sessionId: 'bridge-img-1',
      opId: 'dsp_snc16_1',
      event: { type: 'turn_end', stopReason: 'stop' }
    })
    fake.events({
      sessionId: 'bridge-img-1',
      opId: 'dsp_snc16_1',
      event: { type: 'settled', willRetry: false }
    })
    const dumped = JSON.stringify(sink.items)
    expect(dumped).toContain('ONE-PIXEL')
    expect(dumped).not.toContain(TINY_PNG.slice(0, 32))
  })

  it('surfaces text-only model refusal as actionable rejected (session stays usable)', async () => {
    const fake = makeSnc16Fake({ sessionId: 'bridge-img-2' })
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
      readImageFile: () => TINY_BYTES
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    await adapter.setOption({
      sessionId: 'sess-external-01',
      key: 'model',
      value: 'opencode-go/text-only-model',
      fence: 0
    })
    const refused = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-bad',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'see this?' },
          { type: 'image-ref', path: '/tmp/a.png' }
        ]
      },
      fence: 0
    })
    expect(refused.state).toBe('rejected')
    if (refused.state === 'rejected') {
      expect(refused.reason).toContain('model-rejects-images')
    }
    const ok = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-ok',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 0
    })
    expect(ok.state).toBe('accepted')
  })

  it('rejects URL refs and unreadable files without touching the provider', async () => {
    const fake = makeSnc16Fake()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
      readImageFile: () => {
        throw new Error('missing')
      }
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    const urlOutcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-url',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'see?' },
          { type: 'image-ref', url: 'https://example.com/a.png' }
        ]
      },
      fence: 0
    })
    expect(urlOutcome.state).toBe('rejected')
    const missingOutcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-missing',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'see?' },
          { type: 'image-ref', path: '/tmp/missing.png' }
        ]
      },
      fence: 0
    })
    expect(missingOutcome.state).toBe('rejected')
    expect(fake.dispatched).toHaveLength(0)
  })
})

describe('SNC1.6 model/thinking controls', () => {
  it('requires qualified refs for duplicate bare ids; qualified set confirms via get_session', async () => {
    const fake = makeSnc16Fake()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    await expect(
      adapter.setOption({
        sessionId: 'sess-external-01',
        key: 'model',
        value: 'gpt-5.6-luna',
        fence: 0
      })
    ).rejects.toThrow(/AMBIGUOUS_MODEL/)
    const updated = await adapter.setOption({
      sessionId: 'sess-external-01',
      key: 'model',
      value: 'openai-codex/gpt-5.6-luna',
      fence: 0
    })
    expect(updated).toMatchObject({ model: 'openai-codex/gpt-5.6-luna' })
    const current = await adapter.readOptions({ sessionId: 'sess-external-01', fence: 0 })
    expect(current.current.model).toBe('openai-codex/gpt-5.6-luna')
    expect(current.models).toEqual([])
  })

  it('fails closed on unknown model refs without fuzzy matching', async () => {
    const fake = makeSnc16Fake()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    await expect(
      adapter.setOption({
        sessionId: 'sess-external-01',
        key: 'model',
        value: 'nope-nope',
        fence: 0
      })
    ).rejects.toThrow(/UNKNOWN_MODEL/)
    await expect(
      adapter.setOption({
        sessionId: 'sess-external-01',
        key: 'model',
        value: 'wrong-provider/glm-5.3-flash',
        fence: 0
      })
    ).rejects.toThrow(/UNKNOWN_MODEL/)
    await expect(
      adapter.setOption({ sessionId: 'sess-external-01', key: 'model', value: 'glm-*', fence: 0 })
    ).rejects.toThrow(/UNKNOWN_MODEL/)
  })

  it('fails closed on unknown thinking levels without touching provider semantics', async () => {
    const fake = makeSnc16Fake()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    const before = await adapter.readOptions({ sessionId: 'sess-external-01', fence: 0 })
    const callsBefore = fake.setThinkingCalls.length
    await expect(
      adapter.setOption({
        sessionId: 'sess-external-01',
        key: 'thinkingLevel',
        value: 'bogus-level',
        fence: 0
      })
    ).rejects.toThrow(/UNKNOWN_THINKING_LEVEL/)
    expect(fake.setThinkingCalls.length).toBe(callsBefore)
    const after = await adapter.readOptions({ sessionId: 'sess-external-01', fence: 0 })
    expect(after.current).toEqual(before.current)
    await adapter.setOption({
      sessionId: 'sess-external-01',
      key: 'thinkingLevel',
      value: 'high',
      fence: 0
    })
    expect(
      (await adapter.readOptions({ sessionId: 'sess-external-01', fence: 0 })).current.effort
    ).toBe('high')
  })

  it('reports current from get_session (provider-confirmed)', async () => {
    const fake = makeSnc16Fake({ sessionId: 'bridge-opt-1' })
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    await adapter.setOption({
      sessionId: 'sess-external-01',
      key: 'thinkingLevel',
      value: 'high',
      fence: 0
    })
    const current = await adapter.readOptions({ sessionId: 'sess-external-01', fence: 0 })
    expect(current.current.model).toBe('opencode-go/glm-5.3-flash')
    expect(current.current.effort).toBe('high')
  })

  it('keeps option state isolated across acquisition fences (no leak)', async () => {
    const fakeA = makeSnc16Fake({ sessionId: 'bridge-A' })
    const fakeB = makeSnc16Fake({ sessionId: 'bridge-B' })
    let calls = 0
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => {
        calls += 1
        if (calls === 1) {
          return fakeA
        }
        return fakeB
      }
    })
    await adapter.acquire({
      identity: makeIdentity({ sessionId: 'sess-A' }),
      fence: 0,
      spawnToken: 'a'
    })
    await adapter.acquire({
      identity: makeIdentity({ sessionId: 'sess-B' }),
      fence: 0,
      spawnToken: 'b'
    })
    await adapter.setOption({ sessionId: 'sess-A', key: 'thinkingLevel', value: 'high', fence: 0 })
    expect((await adapter.readOptions({ sessionId: 'sess-A', fence: 0 })).current.effort).toBe(
      'high'
    )
    expect((await adapter.readOptions({ sessionId: 'sess-B', fence: 0 })).current.effort).toBe(
      'low'
    )
    await adapter.closeSession('sess-A')
    const fakeA2 = makeSnc16Fake({ sessionId: 'bridge-A2' })
    const adapter2 = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fakeA2
    })
    await adapter2.acquire({
      identity: makeIdentity({ sessionId: 'sess-A' }),
      fence: 1,
      spawnToken: 'a2'
    })
    expect((await adapter2.readOptions({ sessionId: 'sess-A', fence: 1 })).current.effort).toBe(
      'low'
    )
    await adapter.closeAll()
    await adapter2.closeAll()
  })
})

describe('SNC1.6 reacquire safety', () => {
  it('failed reacquire preserves the working session (candidate validated before swap)', async () => {
    const fakeA = makeSnc16Fake({ sessionId: 'bridge-keep' })
    const fakeB = makeSnc16Fake({ sessionId: 'bridge-bad' })
    ;(fakeB as unknown as { providerPid: unknown }).providerPid = 0
    let calls = 0
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => {
        calls += 1
        if (calls === 1) {
          return fakeA
        }
        return fakeB
      },
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 'a' })
    const first = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 0,
    })
    expect(first.state).toBe('accepted')
    await expect(
      adapter.acquire({ identity: makeIdentity(), fence: 1, spawnToken: 'b' }),
    ).rejects.toThrow(/probeable pid/)
    // Candidate cleaned up; working session untouched and still usable.
    expect((fakeB as unknown as { disposed: boolean }).disposed).toBe(true)
    expect((fakeA as unknown as { disposed: boolean }).disposed).toBe(false)
    const second = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-2',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'still here' }] },
      fence: 0,
    })
    expect(second.state).toBe('accepted')
    expect(fakeA.dispatched.map((d) => d.text)).toEqual(['hi', 'still here'])
    expect(fakeB.dispatched).toHaveLength(0)
    await adapter.closeAll()
  })
})

describe('SNC1.6 prompts', () => {
  it('renders input/editor prompt_requests and answers exactly once (stale refused)', async () => {
    const fake = makeBaseFake('bridge-prompt-16')
    const sink = makeSink()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't', events: sink })
    fake.events({
      sessionId: 'bridge-prompt-16',
      opId: 'dsp_1',
      event: {
        type: 'prompt_request',
        requestId: 'req-input-1',
        prompt: { kind: 'input', title: 'Name?', placeholder: 'x' }
      }
    })
    fake.events({
      sessionId: 'bridge-prompt-16',
      opId: 'dsp_1',
      event: {
        type: 'prompt_request',
        requestId: 'req-editor-1',
        prompt: { kind: 'editor', title: 'Edit?' }
      }
    })
    const questions = sink.items.filter((item) => {
      return item.body.kind === 'question'
    })
    expect(questions.length).toBeGreaterThanOrEqual(2)
    const itemId = agentJournalItemKey(questions[0]!.identity)
    await adapter.answerPrompt({
      sessionId: 'sess-external-01',
      itemId,
      kind: 'question',
      optionId: 'submit',
      fence: 0
    })
    expect(fake.answered[0]).toMatchObject({ requestId: 'req-input-1' })
    await expect(
      adapter.answerPrompt({
        sessionId: 'sess-external-01',
        itemId,
        kind: 'question',
        optionId: 'submit',
        fence: 0
      })
    ).rejects.toThrow(/unknown prompt/)
  })

  it('bounded-ignores unknown session_event kinds (never blocks)', async () => {
    const fake = makeBaseFake('bridge-unknown-1')
    const sink = makeSink()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't', events: sink })
    const before = sink.items.length
    fake.events({
      sessionId: 'bridge-unknown-1',
      opId: 'dsp_u',
      event: { type: 'notify' } as never
    })
    fake.events({
      sessionId: 'bridge-unknown-1',
      opId: 'dsp_u',
      event: { type: 'setTitle' } as never
    })
    fake.events({
      sessionId: 'bridge-unknown-1',
      opId: 'dsp_u',
      event: { type: 'future-kind' } as never
    })
    expect(sink.items.length).toBe(before)
    const outcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c-after-unknown',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 0
    })
    expect(outcome.state).toBe('accepted')
  })
})
