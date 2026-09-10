// Tests for the SNC1.3 external structured-session adapter (dev seam).
//
// Provider-neutral: the fake host below speaks only the generic bridge
// contract (no Pi imports). The mock-turn test proves a real adapterctomy:
// acquire → dispatch(accepted) → session_event stream → journal sink appends
// carrying normal Native Chat blocks (assistant text, reasoning, tool-call,
// approval/question, status). Unknown dispatch is never auto-resent.

import { describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity,
} from '../../../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import {
  EXTERNAL_BRIDGE_AGENT,
  ExternalStructuredSessionAdapter,
  type ExternalBridgeHostLike,
} from './external-structured-session-adapter'
import { isExternalBridgeConfigured, readExternalBridgeConfig } from './external-structured-bridge-config'
import type { SessionEventEnvelope } from './bridge-host'
import { externalProviderHandleLink } from './external-structured-owner-identity'
import { createExternalStructuredSessionAdapterForRuntime } from './external-structured-runtime'
import { StructuredAgentSessionAdapterRouter } from '../structured-agent-session-adapter-router'

const DEV_ENV = {
  ORCA_PI_BRIDGE_COMMAND: 'node /tmp/mock-provider-cli.js',
}
const DEV_ARGV = ['node', 'orca', '--enable-external-structured-bridge']

function makeSink(): StructuredAgentSessionEventSink & {
  items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]
  activities: unknown[]
  publishes: number
} {
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
    },
  }
  return sink as unknown as StructuredAgentSessionEventSink & {
    items: { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }[]
    activities: unknown[]
    publishes: number
  }
}

function makeIdentity(overrides: Partial<AgentSessionJournalIdentity> = {}): AgentSessionJournalIdentity {
  return {
    sessionId: 'sess-external-01',
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: EXTERNAL_BRIDGE_AGENT,
    providerHandle: { kind: 'opaque', agent: EXTERNAL_BRIDGE_AGENT, value: 'pending' },
    ...overrides,
  }
}

type FakeHostOptions = {
  available?: boolean
  reason?: string
  sessionId?: string
  pid?: number
}

function makeFakeHost(options: FakeHostOptions = {}): ExternalBridgeHostLike & {
  events: (envelope: SessionEventEnvelope) => void
  disposed: boolean
  released: string[]
  answered: { requestId: string; value: unknown; cancelled: boolean }[]
  dispatchImpl?: (req: { sessionId: string; text: string }) => Promise<{ status: 'accepted' | 'rejected' | 'unknown'; opId: string; reason?: string }>
} {
  const listeners = new Set<(envelope: SessionEventEnvelope) => void>()
  const fake = {
    providerPid: options.pid ?? 4242,
    disposed: false,
    released: [] as string[],
    answered: [] as { requestId: string; value: unknown; cancelled: boolean }[],
    dispatchImpl: undefined as
      | ((req: { sessionId: string; text: string }) => Promise<{ status: 'accepted' | 'rejected' | 'unknown'; opId: string; reason?: string }>)
      | undefined,
    events(envelope: SessionEventEnvelope) {
      for (const listener of listeners) listener(envelope)
    },
    get support() {
      return options.available === false
        ? { available: false as const, reason: options.reason ?? 'fake-unavailable' }
        : { available: true as const, reason: 'bridge-ready' }
    },
    async probeSupport() {
      return fake.support
    },
    async acquire() {
      return {
        sessionId: options.sessionId ?? 'bridge-ses-1',
        resumed: false,
        metadata: {
          sessionId: options.sessionId ?? 'bridge-ses-1',
          workspaceRoot: '/tmp/ws',
          messageCount: 0,
          isStreaming: false,
          createdAt: new Date(0).toISOString(),
        },
      }
    },
    async release(sessionId: string) {
      fake.released.push(sessionId)
    },
    async dispatch(req: { sessionId: string; text: string }) {
      if (fake.dispatchImpl) return fake.dispatchImpl(req)
      return { status: 'accepted' as const, opId: 'dsp_fake_1' }
    },
    async cancel() {
      return { settled: false }
    },
    async answerPrompt(requestId: string, value: unknown, cancelled = false) {
      fake.answered.push({ requestId, value, cancelled })
    },
    async setOptions(_sessionId: string, next: Record<string, unknown>) {
      return next as never
    },
    async getSession(sessionId: string) {
      return {
        sessionId,
        workspaceRoot: '/tmp/ws',
        messageCount: 0,
        isStreaming: false,
        createdAt: new Date(0).toISOString(),
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
    },
  }
  return fake as unknown as ExternalBridgeHostLike & {
    events: (envelope: SessionEventEnvelope) => void
    disposed: boolean
    released: string[]
    answered: { requestId: string; value: unknown; cancelled: boolean }[]
    dispatchImpl?: (req: { sessionId: string; text: string }) => Promise<{ status: 'accepted' | 'rejected' | 'unknown'; opId: string; reason?: string }>
  }
}

describe('external bridge config (dev-only)', () => {
  it('is disabled without the flag even when the command is set', () => {
    expect(isExternalBridgeConfigured(DEV_ENV, ['node', 'orca'])).toBe(false)
  })

  it('is disabled with the flag but an empty command (fail closed)', () => {
    expect(isExternalBridgeConfigured({}, DEV_ARGV)).toBe(false)
    expect(readExternalBridgeConfig({}, DEV_ARGV).reason).toMatch(/empty/)
  })

  it('parses a quoted command into command + args', () => {
    const config = readExternalBridgeConfig(
      { ORCA_PI_BRIDGE_COMMAND: 'node "/tmp/with space/mock.js" --foo' },
      DEV_ARGV,
    )
    expect(config.command).toBe('node')
    expect(config.args).toEqual(['/tmp/with space/mock.js', '--foo'])
  })
})

describe('ExternalStructuredSessionAdapter', () => {
  it('supportsCreate only for the external agent when configured', () => {
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => makeFakeHost(),
    })
    expect(adapter.supportsCreate?.({}, 'external')).toBe(true)
    expect(adapter.supportsCreate?.({}, 'codex')).toBe(false)
    const off = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: {},
      argv: [],
      createHost: () => makeFakeHost(),
    })
    expect(off.supportsCreate?.({}, 'external')).toBe(false)
  })

  it('acquire fails closed without dev config (Pi TUI path untouched)', async () => {
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: {},
      argv: [],
      createHost: () => makeFakeHost(),
    })
    await expect(
      adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 'tok-1' }),
    ).rejects.toThrow(/not configured/)
  })

  it('acquire fails closed when the bridge is unavailable (no resident session)', async () => {
    const fake = makeFakeHost({ available: false, reason: 'missing-binary' })
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    await expect(
      adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 'tok-1' }),
    ).rejects.toThrow(/unavailable/)
    expect(fake.disposed).toBe(true)
  })

  it('dispatch accepted streams a mock turn into Native Chat blocks via the journal sink', async () => {
    const fake = makeFakeHost({ sessionId: 'bridge-ses-9' })
    const sink = makeSink()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    const acquired = await adapter.acquire({
      identity: makeIdentity(),
      fence: 1,
      spawnToken: 'tok-9',
      events: sink,
    })
    expect(acquired.link.handle).toEqual({ provider: 'external', sessionId: 'bridge-ses-9' })
    expect(acquired.link.linkId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(acquired.process.pid).toBe(4242)

    const outcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'client-1',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fence: 1,
    })
    expect(outcome.state).toBe('accepted')
    const opId = outcome.state === 'accepted' ? outcome.providerIdentity : null
    expect(opId).toMatchObject({ provider: 'legacy', agent: 'external' })
    const turnId = 'dsp_fake_1'

    fake.events({ sessionId: 'bridge-ses-9', opId: turnId, event: { type: 'turn_start' } })
    fake.events({ sessionId: 'bridge-ses-9', opId: turnId, event: { type: 'text_delta', delta: 'mock response' } })
    fake.events({ sessionId: 'bridge-ses-9', opId: turnId, event: { type: 'text_delta', delta: ' for: hello' } })
    fake.events({ sessionId: 'bridge-ses-9', opId: turnId, event: { type: 'text_end', text: 'mock response for: hello' } })
    fake.events({ sessionId: 'bridge-ses-9', opId: turnId, event: { type: 'turn_end', stopReason: 'stop' } })
    fake.events({ sessionId: 'bridge-ses-9', opId: turnId, event: { type: 'settled', willRetry: false } })

    const assistant = sink.items.filter(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant',
    )
    expect(assistant.length).toBeGreaterThan(0)
    const last = assistant[assistant.length - 1]!.body
    expect(last.kind).toBe('message')
    if (last.kind === 'message') {
      expect(last.blocks).toEqual([{ type: 'text', text: 'mock response for: hello' }])
    }
    // settled clears activity so Native Chat re-enables input
    expect(sink.activities[sink.activities.length - 1]).toBeNull()
    expect(sink.publishes).toBeGreaterThan(0)
  })

  it('preserves unknown dispatch (never auto-resends; caller reconciles via history)', async () => {
    const fake = makeFakeHost()
    fake.dispatchImpl = async () => ({ status: 'unknown', opId: 'dsp_x', reason: 'timeout' })
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    const outcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 0,
    })
    expect(outcome).toEqual({ state: 'unknown', reason: 'timeout' })
  })

  it('rejects image dispatches fail-closed (SNC1.6 owns path/url mapping)', async () => {
    const fake = makeFakeHost()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    const outcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'image-ref', path: '/tmp/a.png' }],
      },
      fence: 0,
    })
    expect(outcome.state).toBe('rejected')
  })

  it('routes prompt_request to approval/question items and answers exactly once', async () => {
    const fake = makeFakeHost({ sessionId: 'bridge-ses-p' })
    const sink = makeSink()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't', events: sink })
    fake.events({
      sessionId: 'bridge-ses-p',
      opId: 'dsp_p',
      event: { type: 'prompt_request', requestId: 'req-1', prompt: { kind: 'confirm', title: 'Proceed?', message: 'details' } },
    })
    const approval = sink.items.find((item) => item.body.kind === 'approval')
    expect(approval).toBeDefined()
    const itemId = approval
      ? (await import('../../../../shared/agent-session-journal-item-key')).agentJournalItemKey(approval.identity)
      : ''
    await adapter.answerPrompt({ sessionId: 'sess-external-01', itemId, kind: 'approval', optionId: 'confirm', fence: 0 })
    expect(fake.answered).toEqual([{ requestId: 'req-1', value: 'confirm', cancelled: false }])
    await expect(
      adapter.answerPrompt({ sessionId: 'sess-external-01', itemId, kind: 'approval', optionId: 'confirm', fence: 0 }),
    ).rejects.toThrow(/unknown prompt/)
  })

  it('validates setOption keys fail-closed and reports restore failures', async () => {
    const fake = makeFakeHost()
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    await expect(
      adapter.setOption({ sessionId: 'sess-external-01', key: 'bogus', value: 'x', fence: 0 }),
    ).rejects.toThrow(/no option named/)
    await expect(
      adapter.setOption({ sessionId: 'sess-external-01', key: 'queueMode', value: 'sideways', fence: 0 }),
    ).rejects.toThrow(/invalid queueMode/)
    expect(adapter.readOptionRestoreFailures('sess-external-01')).toContain('queueMode')
    const updated = await adapter.setOption({ sessionId: 'sess-external-01', key: 'model', value: 'm', fence: 0 })
    expect(updated).toMatchObject({ model: 'm' })
  })

  it('teardown releases the bridge session and disposes the helper (no resident process)', async () => {
    const fake = makeFakeHost({ sessionId: 'bridge-ses-t' })
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => fake,
    })
    await adapter.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' })
    expect(await adapter.closeSession('sess-external-01')).toBe(true)
    expect(fake.released).toEqual(['bridge-ses-t'])
    expect(fake.disposed).toBe(true)
    // second close is idempotent:false (nothing live) — no duplicate owner
    expect(await adapter.closeSession('sess-external-01')).toBe(false)
    const outcome = await adapter.dispatch({
      sessionId: 'sess-external-01',
      clientMessageId: 'c',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      fence: 0,
    })
    expect(outcome.state).toBe('rejected')
  })
})

describe('ExternalStructuredSessionAdapter (real BridgeHost + inline mock provider)', () => {
  it('creates a real bridge session over a live OS process and streams fake output', async () => {
    const { BridgeHost } = await import('./bridge-host')
    const inlineMock = [
      "const readline = require('node:readline');",
      'const rl = readline.createInterface({ input: process.stdin });',
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "rl.on('line', (line) => {",
      '  let m; try { m = JSON.parse(line); } catch { return; }',
      "  if (m.kind === 'hello') send({ v: 1, kind: 'hello_ok', opId: m.opId, provider: { id: 'mock', version: '0.1.0', protocol: 1 }, capabilities: { textStreaming: true, thinking: true, tools: true, images: true, extensionDialogs: true, history: true, options: true, cancel: true, resume: true } });",
      "  else if (m.kind === 'acquire') send({ v: 1, kind: 'acquired', opId: m.opId, sessionId: 'ses_live_1', resumed: false, metadata: { sessionId: 'ses_live_1', workspaceRoot: m.workspaceRoot, messageCount: 0, isStreaming: false, createdAt: new Date(0).toISOString() } });",
      "  else if (m.kind === 'dispatch') {",
      "    send({ v: 1, kind: 'dispatch_ack', opId: m.opId, sessionId: m.sessionId, status: 'accepted' });",
      "    const text = 'mock response for: ' + m.message.text;",
      "    send({ v: 1, kind: 'session_event', sessionId: m.sessionId, opId: m.opId, event: { type: 'turn_start' } });",
      "    send({ v: 1, kind: 'session_event', sessionId: m.sessionId, opId: m.opId, event: { type: 'text_delta', delta: text } });",
      "    send({ v: 1, kind: 'session_event', sessionId: m.sessionId, opId: m.opId, event: { type: 'text_end', text } });",
      "    send({ v: 1, kind: 'session_event', sessionId: m.sessionId, opId: m.opId, event: { type: 'turn_end', stopReason: 'stop' } });",
      "    send({ v: 1, kind: 'session_event', sessionId: m.sessionId, opId: m.opId, event: { type: 'settled', willRetry: false } });",
      '  }',
      "  else if (m.kind === 'release') send({ v: 1, kind: 'released', opId: m.opId, sessionId: m.sessionId });",
      '});',
      "rl.on('close', () => process.exit(0));",
    ].join('\n')
    const sink = makeSink()
    const seen: SessionEventEnvelope[] = []
    const adapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => process.cwd(),
      env: { ...process.env, ORCA_PI_BRIDGE_COMMAND: 'node' },
      argv: DEV_ARGV,
      readProcessStartTime: () => null,
      createHost: (options) =>
        new BridgeHost({
          bridgeCommand: 'node',
          bridgeArgs: ['-e', inlineMock],
          workspaceRoot: options.workspaceRoot,
        }),
    })
    // Point the adapter at the inline mock via a direct host factory; the
    // dev-flag gate still applies (argv carries it).
    const acquired = await adapter.acquire({
      identity: makeIdentity({ sessionId: 'sess-live-01' }),
      fence: 0,
      spawnToken: 'tok-live',
      events: {
        ...sink,
        appendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
          sink.appendItem(identity, body)
          seen.push({ sessionId: 'x', event: { type: 'settled' } })
        },
      } as unknown as StructuredAgentSessionEventSink,
    })
    expect(acquired.link.handle).toEqual({ provider: 'external', sessionId: 'ses_live_1' })
    const outcome = await adapter.dispatch({
      sessionId: 'sess-live-01',
      clientMessageId: 'c-live',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello native chat' }] },
      fence: 0,
    })
    expect(outcome.state).toBe('accepted')
    // Wait for the streamed turn (bounded; mock replies immediately).
    const deadline = Date.now() + 10_000
    for (;;) {
      const assistant = sink.items.filter(
        (item) => item.body.kind === 'message' && item.body.role === 'assistant',
      )
      const done = assistant.some(
        (item) =>
          item.body.kind === 'message' &&
          item.body.blocks.some(
            (block) => block.type === 'text' && block.text === 'mock response for: hello native chat',
          ),
      )
      if (done) break
      if (Date.now() > deadline) throw new Error('timed out waiting for mock streamed response')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(seen.length).toBeGreaterThan(0)
    // Restart independence: dispose + reacquire starts empty (new OS process).
    await adapter.closeSession('sess-live-01')
    const sink2 = makeSink()
    await adapter.acquire({
      identity: makeIdentity({ sessionId: 'sess-live-01' }),
      fence: 1,
      spawnToken: 'tok-live-2',
      events: sink2,
    })
    expect(sink2.items).toEqual([])
    await adapter.closeAll()
    vi.unstubAllEnvs()
  }, 30_000)
})

describe('external owner identity + runtime hookup', () => {
  it('mints a first-class external handle link (never impersonates codex)', () => {
    const link = externalProviderHandleLink({
      sessionId: 'ses_bridge_1',
      fence: 3,
      observedAt: 1700000000000,
    })
    expect(link.handle).toEqual({ provider: 'external', sessionId: 'ses_bridge_1' })
    expect(link.origin).toBe('created')
    expect(link.mintedAtFence).toBe(3)
    expect(link.linkId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
  })

  it('sanitizes hostile bridge session ids into valid link ids', () => {
    const link = externalProviderHandleLink({
      sessionId: '  spaces/and:colons  ',
      fence: 0,
      observedAt: 0,
    })
    expect(link.linkId).toMatch(/^[A-Za-z0-9_-]{1,128}$/)
    expect(link.handle).toEqual({ provider: 'external', sessionId: '  spaces/and:colons  ' })
  })

  it('runtime helper returns null without dev config (production pair untouched)', () => {
    expect(
      createExternalStructuredSessionAdapterForRuntime({
        resolveWorkspacePath: () => '/tmp/ws',
      }),
    ).toBeNull()
    expect(
      createExternalStructuredSessionAdapterForRuntime({
        resolveWorkspacePath: () => '/tmp/ws',
        env: {},
        argv: ['node', 'orca'],
      }),
    ).toBeNull()
  })

  it('runtime helper builds the adapter when configured', () => {
    const adapter = createExternalStructuredSessionAdapterForRuntime({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
    })
    expect(adapter).not.toBeNull()
    expect(adapter?.supportsCreate?.({}, 'external')).toBe(true)
    expect(adapter?.supportsCreate?.({}, 'codex')).toBe(false)
  })

  it('router routes external sessions to the external adapter only when installed', async () => {
    const { vi: vitestVi } = await import('vitest')
    const stub = (name: string) => ({
      acquire: vitestVi.fn(async () => ({}) as never),
      dispatch: vitestVi.fn(async () => ({ state: 'rejected', reason: name }) as never),
      cancelTurn: vitestVi.fn(async () => ({ cancelled: false }) as never),
      answerPrompt: vitestVi.fn(async () => undefined as never),
      setOption: vitestVi.fn(async () => undefined as never),
    })
    const codex = stub('codex')
    const claude = stub('claude')
    const withoutExternal = new StructuredAgentSessionAdapterRouter(
      { codex, claude } as never,
      async () => {},
    )
    expect(withoutExternal.supportsCreate?.({}, 'external')).toBe(false)
    await expect(
      withoutExternal.acquire({ identity: makeIdentity(), fence: 0, spawnToken: 't' } as never),
    ).rejects.toThrow(/structured sessions do not support/)

    const externalAdapter = new ExternalStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      env: DEV_ENV,
      argv: DEV_ARGV,
      createHost: () => makeFakeHost(),
    })
    const withExternal = new StructuredAgentSessionAdapterRouter(
      { codex, claude, external: externalAdapter } as never,
      async () => {},
    )
    expect(withExternal.supportsCreate?.({}, 'external')).toBe(true)
    expect(withExternal.supportsCreate?.({}, 'codex')).toBe(false)
    const acquired = await withExternal.acquire({
      identity: makeIdentity({ sessionId: 'sess-routed-01' }),
      fence: 0,
      spawnToken: 'tok-route',
    } as never)
    expect(acquired.link.handle).toEqual({ provider: 'external', sessionId: 'bridge-ses-1' })
    await withExternal.closeAll()
  })
})
