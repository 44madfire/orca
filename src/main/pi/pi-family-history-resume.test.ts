// PIF-8 (#29): TUI → structured resume over scripted Pi/OMP children.
//
// Models `structured A B C / TUI adds D E / active leaf = E`: the structured
// leg acquires the exact provider file, the TUI leg appends provider-native
// rows to that same file, and re-acquisition rebuilds the active root → leaf
// chain exactly once with abandoned siblings excluded. No live LLM or network.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionAccountHome } from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
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
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows EBUSY teardown noise; the next run uses a fresh directory.
    }
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-resume-'))
  DIRS.push(dir)
  return dir
}

function piMessage(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] }
  }
}

function piEntries() {
  return [
    piMessage('a', null, 'user', 'alpha'),
    piMessage('b', 'a', 'assistant', 'beta'),
    piMessage('c', 'b', 'user', 'gamma'),
    // Abandoned sibling off B: append-history carries it, the rebuild must not.
    piMessage('x', 'b', 'user', 'abandoned')
  ]
}

function ompEntries() {
  return [
    { type: 'omp_message', id: 'oa', parentId: null, role: 'user', text: 'alpha' },
    { type: 'omp_model_usage', id: 'ou', parentId: 'oa', model: 'm', tokens: 3 },
    { type: 'omp_message', id: 'ob', parentId: 'ou', role: 'assistant', text: 'beta' },
    { type: 'omp_message', id: 'ox', parentId: 'ob', role: 'user', text: 'abandoned' }
  ]
}

function ompTuiRows() {
  return [
    { type: 'omp_state', id: 'os', parentId: 'ob', snapshot: { turn: 1 } },
    { type: 'omp_message', id: 'oc', parentId: 'os', role: 'user', text: 'gamma' }
  ]
}

function writeSessionFile(
  dir: string,
  name: string,
  sessionId: string,
  leafId: string,
  entries: unknown[]
): string {
  const file = join(dir, name)
  const header = { type: 'session', sessionId, cwd: dir, leafId }
  writeFileSync(
    file,
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join('\n')
  )
  return file
}

/** Simulate the TUI leg: the provider appends rows to its own file and advances its leaf. */
function appendTuiLeg(
  file: string,
  sessionId: string,
  leafId: string,
  dir: string,
  rows: unknown[]
): void {
  const prior = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && JSON.parse(line).type !== 'session')
  const header = { type: 'session', sessionId, cwd: dir, leafId }
  writeFileSync(
    file,
    [JSON.stringify(header), ...prior, ...rows.map((row) => JSON.stringify(row))].join('\n')
  )
}

function backendFor(env: Record<string, string>) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env })
  })
}

function adapterFor(dir: string, env: Record<string, string>) {
  return new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => dir,
    backend: backendFor(env),
    readProcessStartTime: async () => 777
  })
}

function resumeIdentity(
  sessionId: string,
  provider: Provider,
  providerSessionId: string
): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: provider,
    providerHandle: { kind: 'opaque', agent: provider, value: `${provider}:${providerSessionId}` }
  }
}

const ENVS: Record<Provider, (file: string, sessionId: string) => Record<string, string>> = {
  pi: (file, sessionId) => ({ PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: sessionId }),
  omp: (file, sessionId) => ({ OMP_SCRIPT_SESSION_FILE: file, OMP_SCRIPT_SESSION_ID: sessionId })
}

const ACCOUNT_HOME: AgentSessionAccountHome = { variable: 'PI_STATE_DIR', path: '/tmp/pi-state' }

describe.each(['pi', 'omp'] as const)('TUI → structured resume for %s', (provider) => {
  it('rebuilds A B C, then A B C D E exactly once after the TUI leg', async () => {
    const dir = workspace()
    const sessionId = `${provider}-tui-1`
    const seeded = provider === 'pi' ? piEntries() : ompEntries()
    const structuredLeaf = provider === 'pi' ? 'c' : 'ob'
    const file = writeSessionFile(dir, `${provider}-tui.jsonl`, sessionId, structuredLeaf, seeded)
    const adapter = adapterFor(dir, ENVS[provider](join(dir, 'other.jsonl'), 'ignored'))
    const orcaSessionId = `orca-${provider}-tui`
    try {
      // Structured leg: exact same-provider file resumes, leaf verifies.
      const structured = await adapter.acquire({
        identity: resumeIdentity(orcaSessionId, provider, sessionId),
        fence: 0,
        spawnToken: 'spawn-1',
        resumeSessionFile: file
      })
      expect(structured.link.handle).toMatchObject({
        provider,
        sessionId,
        leafId: structuredLeaf,
        sessionFile: file
      })
      const before = await adapter.readResumeHistory?.({ sessionId: orcaSessionId, fence: 0 })
      const beforeIds = before?.rows.map((row) => row.id) ?? []
      expect(before?.leafId).toBe(structuredLeaf)
      expect(beforeIds).not.toContain(provider === 'pi' ? 'x' : 'ox')
      // Proven close before releasing structured ownership (Part C gate artifact).
      await expect(adapter.closeSession(orcaSessionId)).resolves.toBe(true)

      // TUI leg: the SAME provider appends D E to its own file; tip advances.
      const tuiRows =
        provider === 'pi'
          ? [piMessage('d', 'c', 'assistant', 'delta'), piMessage('e', 'd', 'user', 'epsilon')]
          : ompTuiRows()
      const tuiLeaf = provider === 'pi' ? 'e' : 'oc'
      appendTuiLeg(file, sessionId, tuiLeaf, dir, tuiRows)

      // Structured leg again: exact file resumes, identity verifies, active
      // chain becomes A B C D E exactly once with the durable leaf at E.
      const reacquired = await adapter.acquire({
        identity: resumeIdentity(orcaSessionId, provider, sessionId),
        fence: 1,
        spawnToken: 'spawn-2',
        resumeSessionFile: file
      })
      expect(reacquired.link.handle).toMatchObject({
        provider,
        sessionId,
        leafId: tuiLeaf,
        sessionFile: file
      })
      const after = await adapter.readResumeHistory?.({ sessionId: orcaSessionId, fence: 1 })
      expect(after?.leafId).toBe(tuiLeaf)
      const afterIds = after?.rows.map((row) => row.id) ?? []
      const expected = provider === 'pi' ? ['a', 'b', 'c', 'd', 'e'] : ['oa', 'ob', 'oc']
      expect(afterIds).toEqual(expected)
      expect(afterIds).not.toContain(provider === 'pi' ? 'x' : 'ox')
      // Exactly once: a second read reconciles to the same rows, never duplicates.
      const again = await adapter.readResumeHistory?.({ sessionId: orcaSessionId, fence: 1 })
      expect(again?.rows.map((row) => row.id)).toEqual(expected)
      await expect(adapter.closeSession(orcaSessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it('survives a no-new-rows TUI leg without changing the rebuild', async () => {
    const dir = workspace()
    const sessionId = `${provider}-quiet-1`
    const seeded = provider === 'pi' ? piEntries() : ompEntries()
    const leaf = provider === 'pi' ? 'c' : 'ob'
    const file = writeSessionFile(dir, `${provider}-quiet.jsonl`, sessionId, leaf, seeded)
    const adapter = adapterFor(dir, ENVS[provider](join(dir, 'other.jsonl'), 'ignored'))
    const orcaSessionId = `orca-${provider}-quiet`
    try {
      await adapter.acquire({
        identity: resumeIdentity(orcaSessionId, provider, sessionId),
        fence: 0,
        spawnToken: 's-1',
        resumeSessionFile: file
      })
      const before = await adapter.readResumeHistory?.({ sessionId: orcaSessionId, fence: 0 })
      await expect(adapter.closeSession(orcaSessionId)).resolves.toBe(true)
      // No TUI rows: re-acquire converges on the identical rebuild and leaf.
      await adapter.acquire({
        identity: resumeIdentity(orcaSessionId, provider, sessionId),
        fence: 1,
        spawnToken: 's-2',
        resumeSessionFile: file
      })
      const after = await adapter.readResumeHistory?.({ sessionId: orcaSessionId, fence: 1 })
      expect(after?.leafId).toBe(leaf)
      expect(after?.rows.map((row) => row.id)).toEqual(before?.rows.map((row) => row.id))
      await expect(adapter.closeSession(orcaSessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it('fails closed on malformed ancestry instead of returning a truncated rebuild', async () => {
    const dir = workspace()
    const sessionId = `${provider}-broken-1`
    const seeded = provider === 'pi' ? piEntries() : ompEntries()
    // Parent cycle off the tip: the shared structural walk refuses it for both providers.
    const broken =
      provider === 'pi'
        ? [...seeded, piMessage('cy', 'cz', 'user', 'lost'), piMessage('cz', 'cy', 'user', 'loop')]
        : [
            ...seeded,
            { type: 'omp_message', id: 'cy', parentId: 'cz', role: 'user', text: 'lost' },
            { type: 'omp_message', id: 'cz', parentId: 'cy', role: 'user', text: 'loop' }
          ]
    const file = writeSessionFile(dir, `${provider}-broken.jsonl`, sessionId, 'cy', broken)
    const adapter = adapterFor(dir, ENVS[provider](join(dir, 'other.jsonl'), 'ignored'))
    try {
      await expect(
        adapter.acquire({
          identity: resumeIdentity(`orca-${provider}-broken`, provider, sessionId),
          fence: 0,
          spawnToken: 's-1',
          resumeSessionFile: file
        })
      ).rejects.toThrow('PI_HISTORY_CYCLE')
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })
})

describe.each(['pi', 'omp'] as const)(
  'provider history window over scripted %s children',
  (provider) => {
    function windowAdapter(dir: string, logFile: string) {
      const backend = createPiRpcBackend({
        piCommand: process.execPath,
        piArgs: [PI_SCRIPT],
        ompCommand: process.execPath,
        ompArgs: [OMP_SCRIPT],
        resolveEnv: () => ({
          ...process.env,
          ...ENVS[provider](join(dir, 'other.jsonl'), 'ignored'),
          ...(provider === 'pi' ? { PI_SCRIPT_LOG: logFile } : { OMP_SCRIPT_LOG: logFile })
        })
      })
      const adapter = new PiStructuredSessionAdapter({
        resolveWorkspacePath: () => dir,
        backend,
        readProcessStartTime: async () => 777
      })
      return { backend, adapter }
    }

    it('samples strictly-after append rows, preserves the leaf, and never resends', async () => {
      const dir = workspace()
      const sessionId = `${provider}-win-1`
      const seeded = provider === 'pi' ? piEntries() : ompEntries()
      // OMP-native tail: state record keeps chain position while the tip advances.
      const tail =
        provider === 'pi'
          ? []
          : [
              { type: 'omp_state', id: 'os', parentId: 'ob', snapshot: { turn: 1 } },
              { type: 'omp_message', id: 'oc', parentId: 'os', role: 'user', text: 'gamma' }
            ]
      const anchor = provider === 'pi' ? 'b' : 'ob'
      const leaf = provider === 'pi' ? 'c' : 'oc'
      const file = writeSessionFile(dir, `${provider}-win.jsonl`, sessionId, leaf, [
        ...seeded,
        ...tail
      ])
      const logFile = join(dir, 'prompts.log')
      writeFileSync(logFile, '')
      const { backend, adapter } = windowAdapter(dir, logFile)
      try {
        const window = await adapter.providerHistoryWindow?.({
          identity: resumeIdentity(`orca-${provider}-win`, provider, sessionId),
          accountHome: ACCOUNT_HOME,
          resumeSessionFile: file,
          durableLeafId: anchor
        })
        expect(window).not.toBe(null)
        expect(window).toMatchObject({ boundaryConsistent: true, turnInFlight: false })
        // Strictly-after user evidence; the abandoned sibling never qualifies.
        expect(window?.items.map((item) => item.providerItemId)).toEqual(
          provider === 'pi' ? ['c'] : ['oc']
        )
        for (const item of window?.items ?? []) {
          expect(item.identity).toMatchObject({ agent: provider, sessionId })
        }
        // Reconciliation never resends: the scripted child saw no prompt write
        // (catalog reads are ordinary read-only acquire traffic).
        expect(readFileSync(logFile, 'utf8')).not.toContain('prompt:')
        // The ephemeral child stopped again: no driver answers afterwards.
        await expect(
          backend.readEntries?.({ orcaSessionId: `orca-${provider}-win` })
        ).rejects.toThrow()
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    })

    it('fails closed on an unknown cursor and on a missing locator', async () => {
      const dir = workspace()
      const sessionId = `${provider}-win-2`
      const seeded = provider === 'pi' ? piEntries() : ompEntries()
      const leaf = provider === 'pi' ? 'c' : 'ob'
      const file = writeSessionFile(dir, `${provider}-win2.jsonl`, sessionId, leaf, seeded)
      const logFile = join(dir, 'prompts.log')
      writeFileSync(logFile, '')
      const { adapter } = windowAdapter(dir, logFile)
      try {
        const unproven = await adapter.providerHistoryWindow?.({
          identity: resumeIdentity(`orca-${provider}-win2`, provider, sessionId),
          accountHome: ACCOUNT_HOME,
          resumeSessionFile: file,
          durableLeafId: 'no-such-entry'
        })
        expect(unproven).toMatchObject({ items: [], boundaryConsistent: false })
        // Missing exact file: fail closed without spawning or inferring a path.
        const missing = await adapter.providerHistoryWindow?.({
          identity: resumeIdentity(`orca-${provider}-win2`, provider, sessionId),
          accountHome: ACCOUNT_HOME,
          durableLeafId: leaf
        })
        expect(missing).toBe(null)
        expect(readFileSync(logFile, 'utf8')).not.toContain('prompt:')
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    })
  }
)
