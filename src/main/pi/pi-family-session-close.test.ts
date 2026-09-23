// Pi-family close and recovery over scripted children (PIF-3, #24).
//
// Proven close and fenced recovery for BOTH providers: graceful close proves
// root exit plus tree absence, unproven teardown retains the owner, a root
// exit without tree proof never releases the lease, no replacement spawns
// until proof succeeds, superseded-driver exits cannot publish against the
// replacement, and repeated close stays idempotent at the host contract.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  AgentSessionAcquisitionRootExitObservedError,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionLifecycleEvent
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiRpcSessionDriver } from './pi-rpc-session-driver'
import { PiRootExitObservedError } from './pi-process-teardown'
import {
  PiStructuredSessionAdapter,
  type PiStructuredBackend
} from './pi-structured-session-adapter'

const PI_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url)
)
const OMP_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-omp-child.mjs', import.meta.url)
)

type Provider = 'pi' | 'omp'

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) {
    rmDir(dir)
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-close-'))
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

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for scripted close condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function freshIdentity(sessionId: string, provider: Provider): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: provider,
    providerHandle: { kind: 'opaque', agent: provider, value: 'pending' }
  }
}

function textBody(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function backendWithScripts(env: Record<string, string>) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env })
  })
}

function fakeBackend(overrides?: Partial<PiStructuredBackend>): PiStructuredBackend {
  const base: PiStructuredBackend = {
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
  return { ...base, ...overrides }
}

function fakeAdapter(
  backend: PiStructuredBackend,
  events: StructuredAgentSessionLifecycleEvent[] = []
): {
  adapter: PiStructuredSessionAdapter
  events: StructuredAgentSessionLifecycleEvent[]
} {
  const adapter = new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => '/tmp/ws',
    backend,
    readProcessStartTime: async (pid) => (pid === 4242 ? 12345 : null),
    onEvent: (event) => {
      events.push(event)
    }
  })
  return { adapter, events }
}

describe('Pi-family proven close', () => {
  it.each(['pi', 'omp'] as const)(
    'gracefully closes a live %s child with proven absence',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const prefix = provider === 'pi' ? 'PI_SCRIPT' : 'OMP_SCRIPT'
      const backend = backendWithScripts({
        [`${prefix}_SESSION_FILE`]: file,
        [`${prefix}_SESSION_ID`]: `${provider}-close-1`
      })
      try {
        const acquired = await backend.acquire({
          orcaSessionId: 'ses-close',
          workspaceRoot: dir,
          provider,
          spawnToken: 's1'
        })
        expect(acquired.pid).toBeGreaterThan(0)
        await expect(backend.close({ orcaSessionId: 'ses-close' })).resolves.toBe(true)
        // Repeated close at the backend contract is idempotent.
        await expect(backend.close({ orcaSessionId: 'ses-close' })).resolves.toBe(true)
      } finally {
        await backend.close({ orcaSessionId: 'ses-close' }).catch(() => undefined)
      }
    }
  )

  it('blocks an omp replacement until the stale teardown is proven', async () => {
    const dir = workspace()
    const file = join(dir, 'omp-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScripts({ OMP_SCRIPT_SESSION_FILE: file })
    const acquire = vi.spyOn(PiRpcSessionDriver.prototype, 'acquire')
    const close = vi.spyOn(PiRpcSessionDriver.prototype, 'close')
    close.mockResolvedValueOnce(false)
    try {
      await backend.acquire({
        orcaSessionId: 'ses-stale-omp',
        workspaceRoot: dir,
        provider: 'omp',
        spawnToken: 's1'
      })
      await expect(
        backend.acquire({
          orcaSessionId: 'ses-stale-omp',
          workspaceRoot: dir,
          provider: 'omp',
          spawnToken: 's2'
        })
      ).rejects.toThrow('PI_STALE_SESSION_UNCLOSED')
      expect(acquire).toHaveBeenCalledTimes(1)
    } finally {
      await backend.close({ orcaSessionId: 'ses-stale-omp' }).catch(() => undefined)
    }
  })

  it('never publishes a superseded driver exit against its replacement', async () => {
    const dir = workspace()
    const file = join(dir, 'shared-session.jsonl')
    writeFileSync(file, '')
    const onUnexpectedExit = vi.fn()
    const backend = createPiRpcBackend({
      piCommand: process.execPath,
      piArgs: [PI_SCRIPT],
      ompCommand: process.execPath,
      ompArgs: [OMP_SCRIPT],
      resolveEnv: () => ({
        ...process.env,
        PI_SCRIPT_SESSION_FILE: file,
        OMP_SCRIPT_SESSION_FILE: file
      }),
      spawnImpl: (spec) => spawnProcess(spec),
      onUnexpectedExit
    })
    const close = vi.spyOn(PiRpcSessionDriver.prototype, 'close')
    close.mockResolvedValueOnce(true)
    try {
      const first = await backend.acquire({
        orcaSessionId: 'ses-replace',
        workspaceRoot: dir,
        provider: 'pi',
        spawnToken: 's1'
      })
      const firstPid = first.pid ?? 0
      expect(firstPid).toBeGreaterThan(0)
      const second = await backend.acquire({
        orcaSessionId: 'ses-replace',
        workspaceRoot: dir,
        provider: 'omp',
        spawnToken: 's2'
      })
      const secondPid = second.pid ?? 0
      expect(secondPid).toBeGreaterThan(0)
      expect(secondPid).not.toBe(firstPid)
      close.mockRestore()
      // The superseded Pi child dies after its replacement owns the session:
      // its exit must not publish.
      process.kill(firstPid, 'SIGKILL')
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(onUnexpectedExit).not.toHaveBeenCalled()
      // The live replacement still owns unexpected-exit reporting.
      process.kill(secondPid, 'SIGKILL')
      await waitFor(() => onUnexpectedExit.mock.calls.length === 1)
      expect(onUnexpectedExit).toHaveBeenCalledWith('ses-replace')
    } finally {
      await backend.close({ orcaSessionId: 'ses-replace' }).catch(() => undefined)
    }
  })
})

describe('Pi-family adapter close semantics', () => {
  it('keeps the owner when close is unproven instead of releasing the lease', async () => {
    const { adapter } = fakeAdapter(fakeBackend({ close: async () => false }))
    await adapter.acquire({
      identity: freshIdentity('ses-1', 'pi'),
      fence: 0,
      spawnToken: 's'
    })
    await expect(adapter.closeSession('ses-1')).resolves.toBe(false)
    await expect(
      adapter.dispatch({
        sessionId: 'ses-1',
        clientMessageId: 'c1',
        body: textBody('hi'),
        fence: 0
      })
    ).resolves.toMatchObject({ state: 'accepted' })
  })

  it('maps a root exit without tree proof to evidence, never to a clean release', async () => {
    const { adapter, events } = fakeAdapter(
      fakeBackend({
        close: async () => {
          throw new PiRootExitObservedError('root gone, tree unverified')
        }
      })
    )
    await adapter.acquire({
      identity: freshIdentity('ses-1', 'omp'),
      fence: 3,
      spawnToken: 's'
    })
    await expect(adapter.closeSession('ses-1')).rejects.toBeInstanceOf(
      AgentSessionAcquisitionRootExitObservedError
    )
    // The session stays indexed: no receipt was issued, so the lease is retained.
    await expect(
      adapter.dispatch({
        sessionId: 'ses-1',
        clientMessageId: 'c1',
        body: textBody('hi'),
        fence: 3
      })
    ).resolves.toMatchObject({ state: 'accepted' })
    expect(events).toHaveLength(0)
  })

  it('binds unexpected-exit events to the current generation', async () => {
    const { adapter, events } = fakeAdapter(fakeBackend())
    const first = await adapter.acquire({
      identity: freshIdentity('ses-1', 'pi'),
      fence: 0,
      spawnToken: 's1'
    })
    adapter.publishUnexpectedExit('ses-1')
    await expect(adapter.closeSession('ses-1')).resolves.toBe(true)
    const second = await adapter.acquire({
      identity: freshIdentity('ses-1', 'pi'),
      fence: 0,
      spawnToken: 's2'
    })
    adapter.publishUnexpectedExit('ses-1')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      acquisitionGeneration: first.acquisitionGeneration
    })
    expect(events[1]).toMatchObject({
      acquisitionGeneration: second.acquisitionGeneration
    })
    expect(first.acquisitionGeneration).not.toBe(second.acquisitionGeneration)
    adapter.publishUnexpectedExit('unknown-session')
    expect(events).toHaveLength(2)
  })

  it('holds the host contract: unknown refuses, stopped repeats succeed', async () => {
    const codex = {
      acquire: vi.fn(),
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn(),
      supportsLocation: () => true
    }
    const { adapter: pi } = fakeAdapter(fakeBackend())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test-only router stub; the pi route never consults it here.
    const stub = codex as unknown as StructuredAgentSessionAdapter
    const router = new StructuredAgentSessionAdapterRouter(
      { codex: stub, claude: stub, pi },
      async () => {}
    )
    // No route is loss of contact, never proof: refusing keeps the lease fenced.
    await expect(router.closeSession('never-acquired')).resolves.toBe(false)
    await router.acquire({
      identity: freshIdentity('ses-pi', 'pi'),
      fence: 0,
      spawnToken: 's'
    })
    await expect(router.closeSession('ses-pi')).resolves.toBe(true)
    await expect(router.closeSession('ses-pi')).resolves.toBe(true)
    await expect(router.disposeSession('ses-pi')).resolves.toBe(true)
  })
})
