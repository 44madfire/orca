// Pi-family acquisition integration over scripted children (PIF-3, #24).
//
// Fresh acquire and exact resume through the real adapter → backend → driver →
// transport path for BOTH providers: correct executable per flavor, bounded
// `get_state` readiness before publication (OMP `ready` alone never suffices),
// exact same-provider session files, provider/session-id mismatch refusal, no
// silent creation from a missing file, process identity, and the live-session
// settle predicate with generation fencing. No live LLM or network.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionProviderHandleRoot } from '../../shared/agent-session-provider-handle'
import { spawnProcess } from '../../shared/child-process/run-process'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'

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
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-acquire-'))
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

function sessionFileFor(dir: string, name: string, sessionId: string, leafId: string): string {
  const header = { type: 'session', sessionId, cwd: dir, leafId }
  const entries = [
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'first' }] }
    },
    {
      type: 'message',
      id: 'e2',
      parentId: 'e1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'second' }]
      }
    },
    {
      type: 'message',
      id: leafId,
      parentId: 'e2',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'third' }]
      }
    }
  ]
  const file = join(dir, name)
  writeFileSync(
    file,
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join('\n')
  )
  return file
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

function resumeIdentity(
  sessionId: string,
  provider: Provider,
  providerSessionId: string
): AgentSessionJournalIdentity {
  return {
    ...freshIdentity(sessionId, provider),
    providerHandle: {
      kind: 'opaque',
      agent: provider,
      value: `${provider}:${providerSessionId}`
    }
  }
}

/** Backend spawning scripted children; records the requested executable per spawn. */
function backendWithScripts(env: Record<string, string>, seen: string[] = []) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env }),
    spawnImpl: (spec) => {
      seen.push(spec.program)
      return spawnProcess(spec)
    }
  })
}

function adapterFor(dir: string, env: Record<string, string>, seen: string[] = []) {
  const backend = backendWithScripts(env, seen)
  const adapter = new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => dir,
    backend,
    readProcessStartTime: async () => 777
  })
  return { backend, adapter }
}

const ENVS: Record<Provider, (file: string, sessionId: string) => Record<string, string>> = {
  pi: (file, sessionId) => ({
    PI_SCRIPT_SESSION_FILE: file,
    PI_SCRIPT_SESSION_ID: sessionId
  }),
  omp: (file, sessionId) => ({
    OMP_SCRIPT_SESSION_FILE: file,
    OMP_SCRIPT_SESSION_ID: sessionId
  })
}

describe('Pi-family fresh acquire', () => {
  it.each(['pi', 'omp'] as const)(
    'acquires fresh %s with its executable, handle, and process identity',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const seen: string[] = []
      const { adapter } = adapterFor(dir, ENVS[provider](file, `${provider}-fresh-1`), seen)
      try {
        const acquired = await adapter.acquire({
          identity: freshIdentity(`orca-${provider}-1`, provider),
          fence: 7,
          spawnToken: 'spawn-1'
        })
        // One spawn through the configured provider command (executable selection
        // itself is pinned by the configured-command test below).
        expect(seen).toEqual([process.execPath])
        expect(acquired.link.handle).toEqual({
          provider,
          sessionId: `${provider}-fresh-1`,
          leafId: null,
          sessionFile: file
        })
        expect(acquired.link.origin).toBe('created')
        expect(acquired.link.mintedAtFence).toBe(7)
        expect(acquired.process).toMatchObject({
          pid: expect.any(Number),
          processStartTimeMs: 777,
          spawnToken: 'spawn-1'
        })
        expect(typeof acquired.acquisitionGeneration).toBe('string')
        await expect(adapter.closeSession(`orca-${provider}-1`)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it('spawns the configured provider executable per flavor', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const seen: string[] = []
    const backend = createPiRpcBackend({
      piCommand: 'pi-binary-under-test',
      ompCommand: 'omp-binary-under-test',
      resolveEnv: () => process.env,
      spawnImpl: (spec) => {
        seen.push(spec.program)
        // Fail fast: the executable name is the assertion, never spawned.
        throw new Error(`spawn refused in test (saw ${spec.program})`)
      }
    })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => 1
    })
    await expect(
      adapter.acquire({
        identity: freshIdentity('s-pi', 'pi'),
        fence: 0,
        spawnToken: 't'
      })
    ).rejects.toThrow('PI_STARTUP_FAILED')
    // A missing OMP binary names OMP, never Pi, so each capability fails on its own binary.
    await expect(
      adapter.acquire({
        identity: freshIdentity('s-omp', 'omp'),
        fence: 0,
        spawnToken: 't'
      })
    ).rejects.toThrow('OMP executable not found')
    expect(seen).toEqual(['pi-binary-under-test', 'omp-binary-under-test'])
  })

  it('never compares Pi and OMP handles as the same root, even with equal session ids', async () => {
    const dir = workspace()
    const piFile = join(dir, 'pi-session.jsonl')
    const ompFile = join(dir, 'omp-session.jsonl')
    writeFileSync(piFile, '')
    writeFileSync(ompFile, '')
    const pi = adapterFor(dir, ENVS.pi(piFile, 'shared-1'))
    const omp = adapterFor(dir, ENVS.omp(ompFile, 'shared-1'))
    try {
      const piAcquired = await pi.adapter.acquire({
        identity: freshIdentity('orca-pi', 'pi'),
        fence: 0,
        spawnToken: 't-pi'
      })
      const ompAcquired = await omp.adapter.acquire({
        identity: freshIdentity('orca-omp', 'omp'),
        fence: 0,
        spawnToken: 't-omp'
      })
      const piHandle = piAcquired.link.handle
      const ompHandle = ompAcquired.link.handle
      expect(agentSessionProviderHandleRoot(piHandle)).not.toBe(
        agentSessionProviderHandleRoot(ompHandle)
      )
    } finally {
      await pi.adapter.closeAll().catch(() => undefined)
      await omp.adapter.closeAll().catch(() => undefined)
    }
  })

  it('requires OMP readiness beyond the ready frame: a ready-only child never publishes', async () => {
    const dir = workspace()
    const file = join(dir, 'omp-session.jsonl')
    writeFileSync(file, '')
    const backend = createPiRpcBackend({
      piCommand: process.execPath,
      piArgs: [PI_SCRIPT],
      ompCommand: process.execPath,
      ompArgs: [OMP_SCRIPT],
      resolveEnv: () => ({
        ...process.env,
        OMP_SCRIPT_SESSION_FILE: file,
        OMP_SCRIPT_READY_ONLY: '1'
      }),
      defaultTimeoutMs: 500,
      startupTimeoutMs: 1_500
    })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => 1
    })
    // The probe times out (ready alone never suffices); teardown of the hung
    // child stays fenced as unproven rather than claimed clean.
    await expect(
      adapter.acquire({
        identity: freshIdentity('orca-omp-hung', 'omp'),
        fence: 0,
        spawnToken: 't'
      })
    ).rejects.toThrow(/PI_(STARTUP_FAILED|ACQUIRE_UNCLOSED)/)
    // Nothing published: an unknown session closes trivially and dispatches nothing.
    await expect(adapter.closeSession('orca-omp-hung')).resolves.toBe(true)
  })
})

describe('Pi-family exact resume', () => {
  it.each(['pi', 'omp'] as const)(
    'resumes the exact same-provider %s file and persists the leaf update',
    async (provider) => {
      const dir = workspace()
      const file = sessionFileFor(dir, `${provider}-resume.jsonl`, `${provider}-resume-1`, 'e3')
      const seen: string[] = []
      const { adapter } = adapterFor(dir, ENVS[provider](join(dir, 'other.jsonl'), 'ignored'), seen)
      try {
        const acquired = await adapter.acquire({
          identity: resumeIdentity(`orca-${provider}-r`, provider, `${provider}-resume-1`),
          fence: 4,
          spawnToken: 'spawn-2',
          resumeSessionFile: file
        })
        expect(acquired.link.origin).toBe('resumed')
        expect(acquired.link.handle).toMatchObject({
          provider,
          sessionId: `${provider}-resume-1`,
          leafId: 'e3',
          sessionFile: file
        })
        await expect(adapter.closeSession(`orca-${provider}-r`)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'refuses a %s resume when the session id mismatches after the switch',
    async (provider) => {
      const dir = workspace()
      const file = sessionFileFor(dir, `${provider}-resume.jsonl`, `${provider}-actual`, 'e3')
      const { adapter } = adapterFor(dir, ENVS[provider](join(dir, 'other.jsonl'), 'ignored'))
      try {
        await expect(
          adapter.acquire({
            identity: resumeIdentity(`orca-${provider}-m`, provider, `${provider}-wanted`),
            fence: 0,
            spawnToken: 't',
            resumeSessionFile: file
          })
        ).rejects.toThrow('PI_RESUME_FAILED')
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'never silently creates a session when the exact %s resume file is missing',
    async (provider) => {
      const dir = workspace()
      const missing = join(dir, 'absent.jsonl')
      const { adapter } = adapterFor(dir, ENVS[provider](join(dir, 'other.jsonl'), `${provider}-x`))
      try {
        await expect(
          adapter.acquire({
            identity: resumeIdentity(`orca-${provider}-n`, provider, `${provider}-x`),
            fence: 0,
            spawnToken: 't',
            resumeSessionFile: missing
          })
        ).rejects.toThrow('PI_RESUME_FAILED')
        expect(existsSync(missing)).toBe(false)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it('refuses a cross-provider resume before spawning', async () => {
    const dir = workspace()
    const file = sessionFileFor(dir, 'pi-resume.jsonl', 'pi-resume-1', 'e3')
    const seen: string[] = []
    const { adapter } = adapterFor(dir, ENVS.omp(join(dir, 'other.jsonl'), 'ignored'), seen)
    const mixed: AgentSessionJournalIdentity = {
      ...freshIdentity('orca-omp-x', 'omp'),
      providerHandle: { kind: 'opaque', agent: 'omp', value: 'pi:pi-resume-1' }
    }
    await expect(
      adapter.acquire({
        identity: mixed,
        fence: 0,
        spawnToken: 't',
        resumeSessionFile: file
      })
    ).rejects.toThrow('mixes pi session with omp acquisition')
    expect(seen).toEqual([])
  })
})

describe('Pi-family live settle predicate', () => {
  it.each(['pi', 'omp'] as const)(
    'exposes the correct final-settle predicate on a live %s session',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const { adapter } = adapterFor(dir, ENVS[provider](file, `${provider}-live-1`))
      const sessionId = `orca-${provider}-live`
      try {
        const acquired = await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't'
        })
        const generation = acquired.acquisitionGeneration ?? ''
        if (provider === 'pi') {
          expect(
            adapter.isSettledEvent({
              sessionId,
              event: { type: 'agent_settled' }
            })
          ).toBe(true)
          expect(
            adapter.isSettledEvent({
              sessionId,
              event: { type: 'agent_end', isTerminal: true }
            })
          ).toBe(false)
        } else {
          expect(
            adapter.isSettledEvent({
              sessionId,
              event: { type: 'agent_end', isTerminal: true }
            })
          ).toBe(true)
          expect(adapter.isSettledEvent({ sessionId, event: { type: 'agent_end' } })).toBe(true)
          expect(
            adapter.isSettledEvent({
              sessionId,
              event: { type: 'agent_end', isTerminal: false }
            })
          ).toBe(false)
        }
        // Stale generations cannot settle through the live predicate.
        expect(
          adapter.isSettledEvent({
            sessionId,
            event: { type: provider === 'pi' ? 'agent_settled' : 'agent_end' },
            acquisitionGeneration: 'superseded-generation'
          })
        ).toBe(false)
        expect(
          adapter.isSettledEvent({
            sessionId,
            event: { type: provider === 'pi' ? 'agent_settled' : 'agent_end' },
            acquisitionGeneration: generation
          })
        ).toBe(true)
        expect(
          adapter.isSettledEvent({
            sessionId: 'unknown',
            event: { type: 'agent_settled' }
          })
        ).toBe(false)
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
        expect(
          adapter.isSettledEvent({
            sessionId,
            event: { type: 'agent_settled' }
          })
        ).toBe(false)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )
})
