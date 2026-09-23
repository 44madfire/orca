// Pi-family streaming integration over scripted children (PIF-5, #26).
//
// Live event translation plus backpressure through the real adapter →
// backend → driver → transport path for BOTH providers: settlement clearing
// exactly once per dialect, OMP non-terminal continuity, bounded OMP extras,
// pre-publication buffering with overflow failure, and sink-driven stdout
// control. Scripted provider children only; no live LLM or network.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createPiRpcBackend } from './pi-rpc-backend'
import type { PiDriverDeps } from './pi-rpc-session-lifecycle'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'
import type { PiStructuredBackend } from './pi-structured-backend'
import { PiFamilyRpcConnection } from './rpc/pi-family-rpc-connection'
import type { PiFamilyPromptFact } from './translation/pi-family-record-dialect'

const PI_SCRIPT = fileURLToPath(new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url))
const OMP_SCRIPT = fileURLToPath(new URL('./rpc/__fixtures__/scripted-omp-child.mjs', import.meta.url))

type Provider = 'pi' | 'omp'
type Row = { identityKey: string; body: AgentJournalItemBody }

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) {
    rmDir(dir)
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-stream-'))
  DIRS.push(dir)
  return dir
}

function rmDir(dir: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      const start = Date.now()
      while (Date.now() - start < 100) {
        // Busy-wait keeps the test synchronous and short.
      }
    }
  }
}

function backendWithScripts(
  env: Record<string, string>,
  extra: Pick<PiDriverDeps, 'acquisitionBufferLimits'> = {}
) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env }),
    ...extra
  })
}

function sessionEnv(provider: Provider, dir: string, sessionId: string): Record<string, string> {
  const file = join(dir, `${provider}-session.jsonl`)
  writeFileSync(file, '')
  return provider === 'pi'
    ? { PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: sessionId }
    : { OMP_SCRIPT_SESSION_FILE: file, OMP_SCRIPT_SESSION_ID: sessionId }
}

type Captured = {
  sink: StructuredAgentSessionEventSink
  rows: Row[]
  activity: { current: unknown }
  control: { current: { pauseReading(): void; resumeReading(): void } | null }
  unbindCalls: { count: number }
}

function capturingSink(): Captured {
  const rows: Row[] = []
  const activity: { current: unknown } = { current: undefined }
  const control: Captured['control'] = { current: null }
  const unbindCalls = { count: 0 }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
      rows.push({ identityKey: agentJournalItemKey(identity), body })
    },
    appendTombstone: () => undefined,
    publish: () => undefined,
    setActivity: (next) => {
      activity.current = next
    },
    bindReadingControl: (next) => {
      control.current = next
      return () => {
        control.current = null
        unbindCalls.count += 1
      }
    }
  }
  return { sink, rows, activity, control, unbindCalls }
}

async function acquireSession(
  backend: ReturnType<typeof backendWithScripts>,
  sessionId: string,
  dir: string,
  provider: Provider,
  sink?: StructuredAgentSessionEventSink,
  spawnToken = 's1'
) {
  return backend.acquire({
    orcaSessionId: sessionId,
    workspaceRoot: dir,
    provider,
    spawnToken,
    ...(sink ? { sink } : {})
  })
}

function textBody(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for scripted Pi-family condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function assistantTexts(rows: Row[]): string[] {
  return rows
    .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
    .map((row) => {
      const body = row.body
      if (body.kind !== 'message') {
        throw new Error('expected a message row')
      }
      return body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
    })
}

async function dispatch(backend: ReturnType<typeof backendWithScripts>, sessionId: string, text: string) {
  return backend.dispatch({ orcaSessionId: sessionId, body: textBody(text) })
}

function mustDrainFacts(
  backend: ReturnType<typeof backendWithScripts>
): (input: { orcaSessionId: string }) => PiFamilyPromptFact[] {
  const drain = backend.drainPromptFacts
  if (!drain) {
    throw new Error('test requires backend.drainPromptFacts')
  }
  return drain.bind(backend)
}

describe('Pi settlement lifecycle', () => {
  it('streams text into one final item and clears the turn exactly once', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv('pi', dir, 'pi-settle-1'))
    const captured = capturingSink()
    try {
      await acquireSession(backend, 'ses-pi-settle', dir, 'pi', captured.sink)
      await expect(dispatch(backend, 'ses-pi-settle', 'hello')).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => captured.activity.current === null)
      const keys = captured.rows
        .filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
        .map((row) => row.identityKey)
      expect(keys.length).toBeGreaterThan(0)
      expect(new Set(keys).size).toBe(1)
      expect(assistantTexts(captured.rows).at(-1)).toContain('scripted reply for turn')
      // The turn cleared exactly once: a follow-up dispatches instead of refusing.
      await expect(dispatch(backend, 'ses-pi-settle', 'again')).resolves.toEqual({ status: 'accepted' })
      await expect(backend.close({ orcaSessionId: 'ses-pi-settle' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('keeps the turn active through low-level events until settle or cancel', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv('pi', dir, 'pi-slow-1'))
    const captured = capturingSink()
    try {
      await acquireSession(backend, 'ses-pi-slow', dir, 'pi', captured.sink)
      await expect(dispatch(backend, 'ses-pi-slow', 'SLOW turn')).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => captured.activity.current !== null && captured.activity.current !== undefined)
      // Deltas streamed but no final arrived: the turn must still own dispatch.
      await expect(dispatch(backend, 'ses-pi-slow', 'interrupt')).resolves.toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('already-streaming')
      })
      await expect(backend.cancel({ orcaSessionId: 'ses-pi-slow' })).resolves.toEqual({ cancelled: true })
      await waitFor(() => captured.activity.current === null)
      await expect(dispatch(backend, 'ses-pi-slow', 'after cancel')).resolves.toEqual({ status: 'accepted' })
      await expect(backend.close({ orcaSessionId: 'ses-pi-slow' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('streams tool and text rows in order without loss', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv('pi', dir, 'pi-order-1'))
    const captured = capturingSink()
    try {
      await acquireSession(backend, 'ses-pi-order', dir, 'pi', captured.sink)
      await expect(dispatch(backend, 'ses-pi-order', 'do TOOL')).resolves.toEqual({ status: 'accepted' })
      await waitFor(() =>
        captured.rows.some((row) => row.body.kind === 'tool-call' && row.body.state === 'completed')
      )
      const toolKeys = captured.rows
        .filter((row) => row.body.kind === 'tool-call')
        .map((row) => row.identityKey)
      expect(toolKeys.length).toBeGreaterThan(0)
      expect(new Set(toolKeys).size).toBe(1)
      const texts = assistantTexts(captured.rows)
      expect(texts.some((text) => text.includes('scripted reply for turn'))).toBe(true)
      const lastTool = Math.max(
        ...captured.rows.map((row, index) => (row.body.kind === 'tool-call' ? index : -1))
      )
      const firstText = Math.min(
        ...captured.rows.map((row, index) =>
          row.body.kind === 'message' && row.body.role === 'assistant' ? index : Number.MAX_SAFE_INTEGER
        )
      )
      expect(lastTool).toBeLessThan(firstText)
      await expect(backend.close({ orcaSessionId: 'ses-pi-order' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })
})

describe('OMP settlement lifecycle', () => {
  it('clears the turn exactly once on terminal agent_end with a prompt fact', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv('omp', dir, 'omp-settle-1'))
    const captured = capturingSink()
    try {
      await acquireSession(backend, 'ses-omp-settle', dir, 'omp', captured.sink)
      const drainFacts = mustDrainFacts(backend)
      drainFacts({ orcaSessionId: 'ses-omp-settle' })
      await expect(dispatch(backend, 'ses-omp-settle', 'hello')).resolves.toEqual({ status: 'accepted' })
      let facts: PiFamilyPromptFact[] = []
      await waitFor(() => {
        facts = drainFacts({ orcaSessionId: 'ses-omp-settle' })
        return facts.length > 0
      })
      expect(facts).toEqual([{ kind: 'prompt-result', agentInvoked: true }])
      await waitFor(() => captured.activity.current === null)
      await expect(dispatch(backend, 'ses-omp-settle', 'again')).resolves.toEqual({ status: 'accepted' })
      await expect(backend.close({ orcaSessionId: 'ses-omp-settle' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })

  it('keeps the turn active through non-terminal agent_end', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv('omp', dir, 'omp-slow-1'))
    const captured = capturingSink()
    try {
      await acquireSession(backend, 'ses-omp-slow', dir, 'omp', captured.sink)
      const drainFacts = mustDrainFacts(backend)
      drainFacts({ orcaSessionId: 'ses-omp-slow' })
      await expect(dispatch(backend, 'ses-omp-slow', 'SLOW turn')).resolves.toEqual({ status: 'accepted' })
      await expect(dispatch(backend, 'ses-omp-slow', 'interrupt')).resolves.toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('already-streaming')
      })
      // The fixture emits agent_end { isTerminal:false } mid-turn: still active.
      await sleep(600)
      await expect(dispatch(backend, 'ses-omp-slow', 'still here')).resolves.toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('already-streaming')
      })
      await waitFor(() => drainFacts({ orcaSessionId: 'ses-omp-slow' }).length > 0)
      await expect(dispatch(backend, 'ses-omp-slow', 'after settle')).resolves.toEqual({ status: 'accepted' })
      await expect(backend.close({ orcaSessionId: 'ses-omp-slow' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })
})

describe('OMP extras stay bounded and forward-compatible', () => {
  it('tolerates startup noise and unknown records without journaling them', async () => {
    const dir = workspace()
    const backend = backendWithScripts({
      ...sessionEnv('omp', dir, 'omp-noise-1'),
      OMP_SCRIPT_NOISE: '1'
    })
    const captured = capturingSink()
    try {
      await acquireSession(backend, 'ses-omp-noise', dir, 'omp', captured.sink)
      // Host-tool, subagent, notice, and unknown frames: no rows, no crash.
      expect(captured.rows).toHaveLength(0)
      // The pre-publication command update still arrives as a handoff fact.
      const facts = mustDrainFacts(backend)({ orcaSessionId: 'ses-omp-noise' })
      expect(facts).toContainEqual({ kind: 'commands-update', count: 1 })
      // The session still dispatches and settles afterwards.
      await expect(dispatch(backend, 'ses-omp-noise', 'hello')).resolves.toEqual({ status: 'accepted' })
      await waitFor(() => mustDrainFacts(backend)({ orcaSessionId: 'ses-omp-noise' }).length > 0)
      await expect(backend.close({ orcaSessionId: 'ses-omp-noise' })).resolves.toBe(true)
    } finally {
      rmDir(dir)
    }
  })
})

describe('acquisition-window safety', () => {
  it('fails acquisition on buffer overflow instead of dropping history', async () => {
    const dir = workspace()
    const backend = backendWithScripts(
      {
        ...sessionEnv('omp', dir, 'omp-overflow-1'),
        OMP_SCRIPT_NOISE: '1'
      },
      { acquisitionBufferLimits: { maxOperations: 2 } }
    )
    try {
      await expect(
        backend.acquire({
          orcaSessionId: 'ses-omp-overflow',
          workspaceRoot: dir,
          provider: 'omp',
          spawnToken: 's1'
        })
      ).rejects.toThrow('PI_ACQUIRE_OVERFLOW')
      // The stale buffer is discarded: no facts leak and a fresh acquire works.
      expect(mustDrainFacts(backend)({ orcaSessionId: 'ses-omp-overflow' })).toEqual([])
      await expect(backend.close({ orcaSessionId: 'ses-omp-overflow' })).resolves.toBe(true)
      const retry = backendWithScripts(sessionEnv('omp', dir, 'omp-overflow-1'))
      try {
        const acquired = await acquireSession(retry, 'ses-omp-overflow', dir, 'omp', undefined, 's2')
        expect(acquired.piSessionId).toBe('omp-overflow-1')
        await expect(retry.close({ orcaSessionId: 'ses-omp-overflow' })).resolves.toBe(true)
      } finally {
        await retry.close({ orcaSessionId: 'ses-omp-overflow' }).catch(() => undefined)
      }
    } finally {
      await backend.close({ orcaSessionId: 'ses-omp-overflow' }).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe.each(['pi', 'omp'] as const)('backpressure over a %s child', (provider) => {
  it('binds sink reading control to the provider stdout and unbinds on close', async () => {
    const pauseSpy = vi.spyOn(PiFamilyRpcConnection.prototype, 'pauseReading')
    const resumeSpy = vi.spyOn(PiFamilyRpcConnection.prototype, 'resumeReading')
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-bp-1`))
    const captured = capturingSink()
    const sessionId = `ses-${provider}-bp`
    try {
      await acquireSession(backend, sessionId, dir, provider, captured.sink)
      const control = captured.control.current
      expect(control).not.toBeNull()
      control?.pauseReading()
      expect(pauseSpy).toHaveBeenCalledTimes(1)
      control?.resumeReading()
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      await expect(backend.close({ orcaSessionId: sessionId })).resolves.toBe(true)
      expect(captured.unbindCalls.count).toBe(1)
      // A stale control into a dead child is safe and settles nothing.
      expect(() => control?.pauseReading()).not.toThrow()
      await expect(dispatch(backend, sessionId, 'after close')).resolves.toMatchObject({
        status: 'rejected'
      })
    } finally {
      await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
      pauseSpy.mockRestore()
      resumeSpy.mockRestore()
      rmDir(dir)
    }
  })
})

describe('stale generations cannot settle a replacement session', () => {
  function fakeBackend(): PiStructuredBackend {
    return {
      acquire: async () => ({
        piSessionId: 'pi-ses-1',
        leafId: 'leaf-1',
        pid: 4242,
        sessionFilePath: '/tmp/pi-ses-1.jsonl'
      }),
      dispatch: async () => ({ status: 'accepted' }),
      cancel: async () => ({ cancelled: true }),
      close: async () => true
    }
  }

  function freshIdentity(sessionId: string): AgentSessionJournalIdentity {
    return {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: { kind: 'opaque', agent: 'pi', value: 'pending' }
    }
  }

  it('rejects the superseded generation through the live predicate', async () => {
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend: fakeBackend(),
      readProcessStartTime: async () => 1
    })
    const first = await adapter.acquire({ identity: freshIdentity('ses-gen'), fence: 0, spawnToken: 't1' })
    const stale = first.acquisitionGeneration ?? ''
    await expect(adapter.closeSession('ses-gen')).resolves.toBe(true)
    const second = await adapter.acquire({ identity: freshIdentity('ses-gen'), fence: 0, spawnToken: 't2' })
    const current = second.acquisitionGeneration ?? ''
    expect(current).not.toBe(stale)
    expect(
      adapter.isSettledEvent({
        sessionId: 'ses-gen',
        event: { type: 'agent_settled' },
        acquisitionGeneration: stale
      })
    ).toBe(false)
    expect(
      adapter.isSettledEvent({
        sessionId: 'ses-gen',
        event: { type: 'agent_settled' },
        acquisitionGeneration: current
      })
    ).toBe(true)
    await expect(adapter.closeSession('ses-gen')).resolves.toBe(true)
  })
})
