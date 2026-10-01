// Pi-family controls over scripted children (PIF-7, 44madfire/orca#28).
//
// Proves one options implementation serves Pi and OMP over the shared model/
// thinking commands, the intentional command-discovery dialect (Pi
// `get_commands` vs OMP `get_available_commands` + `available_commands_update`)
// normalizing into one Orca command model, and compaction over the shared
// `compact` command. No live LLM or network: every provider is a scripted
// node child. Claude/Codex behavior is untouched (no imports from them here).

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { PiFamilyRpcConnection } from './rpc/pi-family-rpc-connection'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'
import type { PiStructuredBackend } from './pi-structured-backend'
import type { PiDriverDeps } from './pi-rpc-session-lifecycle'
import { normalizeOmpCommands, normalizePiCommands } from './pi-family-commands'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'

const PI_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url)
)
const OMP_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-omp-child.mjs', import.meta.url)
)

type Provider = 'pi' | 'omp'

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'pi-controls-ws-'))
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

function backendFor(
  provider: Provider,
  env: Record<string, string>,
  extra: Partial<PiDriverDeps> = {}
) {
  const script = provider === 'pi' ? PI_SCRIPT : OMP_SCRIPT
  if (provider === 'pi') {
    return createPiRpcBackend({
      piCommand: process.execPath,
      piArgs: [script],
      resolveEnv: () => ({ ...process.env, ...env }),
      ...extra
    })
  }
  return createPiRpcBackend({
    ompCommand: process.execPath,
    ompArgs: [script],
    resolveEnv: () => ({ ...process.env, ...env }),
    ...extra
  })
}

async function acquireBackend(
  provider: Provider,
  env: Record<string, string>,
  orcaSessionId: string,
  logFile?: string
) {
  const dir = workspace()
  const file = join(dir, `${provider}-session.jsonl`)
  writeFileSync(file, '')
  const logEnv: Record<string, string> = {}
  if (logFile) {
    logEnv[provider === 'pi' ? 'PI_SCRIPT_LOG' : 'OMP_SCRIPT_LOG'] = logFile
  }
  const backend = backendFor(provider, {
    ...(provider === 'pi' ? { PI_SCRIPT_SESSION_FILE: file } : { OMP_SCRIPT_SESSION_FILE: file }),
    ...env,
    ...logEnv
  })
  const acquired = await backend.acquire({
    orcaSessionId,
    workspaceRoot: dir,
    provider,
    spawnToken: `spawn-${orcaSessionId}`
  })
  return { backend, dir, file, acquired }
}

function logLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
  } catch {
    return []
  }
}

function freshIdentity(sessionId: string, agent: Provider): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent,
    providerHandle: { kind: 'opaque', agent, value: 'pending' }
  }
}

describe.each(['pi', 'omp'] as const)(
  'model catalog and state over a %s-like child',
  (provider) => {
    it('normalizes live models to qualified Orca ids without leaking metadata', async () => {
      const { backend, dir } = await acquireBackend(provider, {}, `ses-catalog-${provider}`)
      try {
        const models = await backend.listModels!({ orcaSessionId: `ses-catalog-${provider}` })
        expect(models.length).toBeGreaterThanOrEqual(4)
        const qualified = models.map((entry) => `${entry.provider}/${entry.id}`)
        expect(qualified).toContain('script-provider/script-model')
        expect(qualified).toContain('script-provider/text-model')
        // Provider/id collisions stay distinguishable by qualification.
        expect(qualified.filter((id) => id.endsWith('/dup-model'))).toEqual([
          'provider-a/dup-model',
          'provider-b/dup-model'
        ])
        for (const entry of models) {
          expect(Object.keys(entry).sort()).toEqual(['id', 'provider'])
        }
      } finally {
        await backend.close({ orcaSessionId: `ses-catalog-${provider}` }).catch(() => undefined)
        rmDir(dir)
      }
    })

    it('reports the current selection from provider-confirmed get_state', async () => {
      const { backend, dir } = await acquireBackend(provider, {}, `ses-state-${provider}`)
      try {
        const before = await backend.readOptions!({ orcaSessionId: `ses-state-${provider}` })
        expect(before.model).toBe('script-provider/script-model')
        await backend.setOption!({
          orcaSessionId: `ses-state-${provider}`,
          key: 'model',
          value: 'script-provider/text-model'
        })
        const after = await backend.readOptions!({ orcaSessionId: `ses-state-${provider}` })
        expect(after.model).toBe('script-provider/text-model')
      } finally {
        await backend.close({ orcaSessionId: `ses-state-${provider}` }).catch(() => undefined)
        rmDir(dir)
      }
    })

    it('leaves an unavailable catalog without fabricated choices', async () => {
      const failures = new Map<string, Set<string>>()
      const adapter = new PiStructuredSessionAdapter({
        resolveWorkspacePath: () => '/tmp/ws',
        readProcessStartTime: async () => 1,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fake implements only the backend surface this case exercises.
        backend: {
          acquire: async () => ({
            piSessionId: `${provider}-ses-1`,
            leafId: 'leaf-1',
            pid: 4242,
            sessionFilePath: '/tmp/s.jsonl'
          }),
          dispatch: async () => ({ status: 'accepted' }),
          cancel: async () => ({ cancelled: true }),
          close: async () => true,
          setOption: async (input: { key: string; value: string }) => ({
            [input.key]: input.value
          }),
          readOptions: async () => ({ options: {}, model: undefined, thinkingLevel: undefined }),
          listModels: async () => {
            throw new Error('catalog down')
          },
          listThinkingLevels: async () => {
            throw new Error('catalog down')
          }
        } as unknown as PiStructuredBackend
      })
      expect(failures.size).toBe(0)
      await adapter.acquire({
        identity: freshIdentity('ses-nocat', provider),
        fence: 0,
        spawnToken: 's1'
      })
      const options = await adapter.readOptions({ sessionId: 'ses-nocat', fence: 0 })
      expect(options.models).toEqual([])
    })
  }
)

describe.each(['pi', 'omp'] as const)(
  'model/thinking mutation over a %s-like child',
  (provider) => {
    it('applies a valid model with exactly one provider-confirmed set_model', async () => {
      const dir = workspace()
      const log = join(dir, 'requests.log')
      writeFileSync(log, '')
      const { backend, dir: acquiredDir } = await acquireBackend(
        provider,
        {},
        `ses-mut-${provider}`,
        log
      )
      try {
        const before = logLines(log).filter((line) => line.startsWith('set_model:')).length
        const confirmed = await backend.setOption!({
          orcaSessionId: `ses-mut-${provider}`,
          key: 'model',
          value: 'script-provider/text-model'
        })
        expect(confirmed).toMatchObject({ model: 'script-provider/text-model' })
        const sets = logLines(log).filter((line) => line.startsWith('set_model:'))
        expect(sets.length - before).toBe(1)
        expect(sets.at(-1)).toBe('set_model:script-provider/text-model')
        const current = await backend.readOptions!({ orcaSessionId: `ses-mut-${provider}` })
        expect(current.model).toBe('script-provider/text-model')
      } finally {
        await backend.close({ orcaSessionId: `ses-mut-${provider}` }).catch(() => undefined)
        rmDir(acquiredDir)
        rmDir(dir)
      }
    })

    it('sends no mutation for an invalid or ambiguous selection', async () => {
      const dir = workspace()
      const log = join(dir, 'requests.log')
      writeFileSync(log, '')
      const { backend, dir: acquiredDir } = await acquireBackend(
        provider,
        {},
        `ses-nomut-${provider}`,
        log
      )
      try {
        const setsBefore = logLines(log).filter((line) => line.startsWith('set_model:')).length
        await expect(
          backend.setOption!({
            orcaSessionId: `ses-nomut-${provider}`,
            key: 'model',
            value: 'dup-model'
          })
        ).rejects.toThrow('AMBIGUOUS_MODEL')
        await expect(
          backend.setOption!({
            orcaSessionId: `ses-nomut-${provider}`,
            key: 'model',
            value: 'nope/nope'
          })
        ).rejects.toThrow('UNKNOWN_MODEL')
        const setsAfter = logLines(log).filter((line) => line.startsWith('set_model:'))
        expect(setsAfter.length).toBe(setsBefore)
        const current = await backend.readOptions!({ orcaSessionId: `ses-nomut-${provider}` })
        expect(current.model).toBe('script-provider/script-model')
      } finally {
        await backend.close({ orcaSessionId: `ses-nomut-${provider}` }).catch(() => undefined)
        rmDir(acquiredDir)
        rmDir(dir)
      }
    })

    it('applies a valid thinking level with exactly one set_thinking_level', async () => {
      const dir = workspace()
      const log = join(dir, 'requests.log')
      writeFileSync(log, '')
      const sessionId = `ses-think-${provider}`
      const { backend, dir: acquiredDir } = await acquireBackend(provider, {}, sessionId, log)
      try {
        const levels = await backend.listThinkingLevels!({ orcaSessionId: sessionId })
        const wanted = levels.includes('high') ? 'high' : levels[0]!
        const before = logLines(log).filter((line) => line.startsWith('set_thinking_level:')).length
        const confirmed = await backend.setOption!({
          orcaSessionId: sessionId,
          key: 'thinkingLevel',
          value: wanted
        })
        expect(confirmed).toMatchObject({ thinkingLevel: wanted })
        const sets = logLines(log).filter((line) => line.startsWith('set_thinking_level:'))
        expect(sets.length - before).toBe(1)
      } finally {
        await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
        rmDir(acquiredDir)
        rmDir(dir)
      }
    })

    it('rejects an unsupported thinking level before relying on provider fallback', async () => {
      const dir = workspace()
      const log = join(dir, 'requests.log')
      writeFileSync(log, '')
      const sessionId = `ses-badthink-${provider}`
      const { backend, dir: acquiredDir } = await acquireBackend(provider, {}, sessionId, log)
      try {
        const before = logLines(log).filter((line) => line.startsWith('set_thinking_level:')).length
        await expect(
          backend.setOption!({ orcaSessionId: sessionId, key: 'thinkingLevel', value: 'ultra' })
        ).rejects.toThrow('UNKNOWN_THINKING_LEVEL')
        const after = logLines(log).filter((line) => line.startsWith('set_thinking_level:'))
        expect(after.length).toBe(before)
      } finally {
        await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
        rmDir(acquiredDir)
        rmDir(dir)
      }
    })
  }
)

describe.each(['pi', 'omp'] as const)('thinking discovery over a %s-like child', (provider) => {
  it('reports reasoning levels, off-only for the non-reasoning model, and accepts every advertised level', async () => {
    const sessionId = `ses-levels-${provider}`
    const { backend, dir } = await acquireBackend(provider, {}, sessionId)
    try {
      const reasoning = await backend.listThinkingLevels!({ orcaSessionId: sessionId })
      if (provider === 'pi') {
        expect(reasoning).toEqual(['low', 'medium', 'high'])
        expect(reasoning).not.toContain('off')
      } else {
        expect(reasoning).toContain('off')
        expect(reasoning.length).toBeGreaterThan(1)
      }
      for (const level of reasoning) {
        await expect(
          backend.setOption!({ orcaSessionId: sessionId, key: 'thinkingLevel', value: level })
        ).resolves.toMatchObject({ thinkingLevel: level })
      }
      await backend.setOption!({
        orcaSessionId: sessionId,
        key: 'model',
        value: 'script-provider/text-model'
      })
      const nonReasoning = await backend.listThinkingLevels!({ orcaSessionId: sessionId })
      expect(nonReasoning).toEqual(['off'])
      await expect(
        backend.setOption!({ orcaSessionId: sessionId, key: 'thinkingLevel', value: 'off' })
      ).resolves.toMatchObject({ thinkingLevel: 'off' })
      await backend.setOption!({
        orcaSessionId: sessionId,
        key: 'model',
        value: 'script-provider/script-model'
      })
      const back = await backend.listThinkingLevels!({ orcaSessionId: sessionId })
      expect(back).toEqual(reasoning)
    } finally {
      await backend.close({ orcaSessionId: sessionId }).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe('command discovery dialect', () => {
  it('maps Pi get_commands into the Orca command model without leaking metadata', async () => {
    const dir = workspace()
    const log = join(dir, 'requests.log')
    writeFileSync(log, '')
    const { backend, dir: acquiredDir } = await acquireBackend('pi', {}, 'ses-cmd-pi', log)
    try {
      const commands = backend.readCommands!({ orcaSessionId: 'ses-cmd-pi' })
      expect(commands).toMatchObject([
        { name: 'review', kind: 'command', description: 'Review the diff' },
        { name: 'deploy', kind: 'command', description: 'Deploy the app' }
      ])
      for (const entry of commands ?? []) {
        expect(Object.keys(entry).sort()).toEqual(['description', 'kind', 'name'])
      }
      expect(logLines(log).some((line) => line === 'catalog:get_commands')).toBe(true)
      // Unit normalization drops unknown metadata safely.
      expect(
        normalizePiCommands([{ name: 'x', description: 'y', sourceInfo: { path: '/s' } }])
      ).toEqual([{ name: 'x', kind: 'command', description: 'y' }])
      expect(normalizePiCommands([{ name: '  ' }])).toEqual([])
    } finally {
      await backend.close({ orcaSessionId: 'ses-cmd-pi' }).catch(() => undefined)
      rmDir(acquiredDir)
      rmDir(dir)
    }
  })

  it('maps OMP get_available_commands into the same model and never sends get_commands', async () => {
    const dir = workspace()
    const log = join(dir, 'requests.log')
    writeFileSync(log, '')
    const { backend, dir: acquiredDir } = await acquireBackend('omp', {}, 'ses-cmd-omp', log)
    try {
      const commands = backend.readCommands!({ orcaSessionId: 'ses-cmd-omp' })
      expect(commands).toMatchObject([
        { name: 'omp-review', kind: 'command', description: 'OMP review' },
        { name: 'omp-deploy', kind: 'command', description: 'OMP deploy' }
      ])
      for (const entry of commands ?? []) {
        expect(Object.keys(entry).sort()).toEqual(['description', 'kind', 'name'])
      }
      const lines = logLines(log)
      expect(lines).toContain('catalog:get_available_commands')
      expect(lines).not.toContain('catalog:get_commands')
      expect(
        normalizeOmpCommands([
          {
            name: 'a',
            description: 'b',
            aliases: ['x'],
            input: {},
            subcommands: [],
            source: 's',
            secret: 1
          }
        ])
      ).toEqual([{ name: 'a', kind: 'command', description: 'b' }])
      expect(normalizeOmpCommands({ nope: true })).toEqual([])
    } finally {
      await backend.close({ orcaSessionId: 'ses-cmd-omp' }).catch(() => undefined)
      rmDir(acquiredDir)
      rmDir(dir)
    }
  })

  it('refreshes the normalized catalog from OMP available_commands_update frames', async () => {
    const conn = new PiFamilyRpcConnection({
      provider: 'omp',
      piCommand: process.execPath,
      piArgs: [OMP_SCRIPT],
      defaultTimeoutMs: 5_000,
      startupTimeoutMs: 10_000,
      spawnFn: (program, argv, options) =>
        spawn(program, argv, {
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          env: { ...process.env, ...options.env }
        })
    })
    try {
      const seen: string[][] = []
      conn.onEvent((event) => {
        if (event.type === 'available_commands_update' && Array.isArray(event['commands'])) {
          seen.push(normalizeOmpCommands(event['commands']).map((entry) => entry.name))
        }
      })
      await conn.start()
      const start = Date.now()
      while (seen.length === 0 && Date.now() - start < 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(seen.at(0)).toEqual(['omp-review', 'omp-deploy'])
      const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
      const update = b64(
        `${JSON.stringify({ type: 'available_commands_update', commands: [{ name: 'fresh-cmd', description: 'fresh', aliases: ['f'] }] })}\n`
      )
      await conn.request({ type: 'test_emit', chunks: [update], delayMs: 5 })
      const deadline = Date.now() + 5_000
      while (seen.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(seen.at(-1)).toEqual(['fresh-cmd'])
    } finally {
      await conn.close(50).catch(() => undefined)
    }
  })
})

describe.each(['pi', 'omp'] as const)('compaction over a %s-like child', (provider) => {
  it('maps success and provider refusal into the existing result contract', async () => {
    const ok = await acquireBackend(provider, {}, `ses-compact-ok-${provider}`)
    try {
      await expect(
        ok.backend.compact!({ orcaSessionId: `ses-compact-ok-${provider}` })
      ).resolves.toEqual({})
    } finally {
      await ok.backend.close({ orcaSessionId: `ses-compact-ok-${provider}` }).catch(() => undefined)
      rmDir(ok.dir)
    }
    const failKey = provider === 'pi' ? 'PI_SCRIPT_COMPACT_FAIL' : 'OMP_SCRIPT_COMPACT_FAIL'
    const fail = await acquireBackend(provider, { [failKey]: '1' }, `ses-compact-fail-${provider}`)
    try {
      const result = await fail.backend.compact!({ orcaSessionId: `ses-compact-fail-${provider}` })
      expect(result.error).toMatch(/Nothing to compact/)
    } finally {
      await fail.backend
        .close({ orcaSessionId: `ses-compact-fail-${provider}` })
        .catch(() => undefined)
      rmDir(fail.dir)
    }
  })

  it('refuses a stale fence without touching the replacement session', async () => {
    const compact = vi.fn(async () => ({}))
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      readProcessStartTime: async () => 1,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fake implements only the backend surface this case exercises.
      backend: {
        acquire: async () => ({
          piSessionId: 'pi-ses-1',
          leafId: 'leaf-1',
          pid: 4242,
          sessionFilePath: '/tmp/s.jsonl'
        }),
        dispatch: async () => ({ status: 'accepted' }),
        cancel: async () => ({ cancelled: true }),
        close: async () => true,
        readCommands: () => undefined,
        compact
      } as unknown as PiStructuredBackend
    })
    await adapter.acquire({
      identity: freshIdentity('ses-fence', provider),
      fence: 0,
      spawnToken: 's1'
    })
    await expect(
      adapter.compact!({ turnId: 't1', sessionId: 'ses-fence', fence: 9 })
    ).rejects.toThrow('agent_session_checkpoint_stale')
    expect(compact).not.toHaveBeenCalled()
    const late = vi.fn(async () => undefined)
    await expect(
      adapter.compact!({ turnId: 't1', sessionId: 'ses-fence', fence: 0, onLateResult: late })
    ).resolves.toEqual({})
    expect(compact).toHaveBeenCalledTimes(1)
    expect(late).not.toHaveBeenCalled()
    // Sequential compacts leave no duplicate pending state.
    await expect(
      adapter.compact!({ turnId: 't2', sessionId: 'ses-fence', fence: 0 })
    ).resolves.toEqual({})
    expect(compact).toHaveBeenCalledTimes(2)
  })
})

describe('option restore failures stay scoped to the affected key', () => {
  it('tracks only the rejected key', async () => {
    const setOption = vi.fn(async (input: { key: string; value: string }) => {
      if (input.key === 'model') {
        throw new Error('UNKNOWN_MODEL: no exact model id match')
      }
      return { [input.key]: input.value }
    })
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      readProcessStartTime: async () => 1,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fake implements only the backend surface this case exercises.
      backend: {
        acquire: async () => ({
          piSessionId: 'pi-ses-1',
          leafId: 'leaf-1',
          pid: 4242,
          sessionFilePath: '/tmp/s.jsonl'
        }),
        dispatch: async () => ({ status: 'accepted' }),
        cancel: async () => ({ cancelled: true }),
        close: async () => true,
        setOption,
        readOptions: async () => ({ options: {}, model: 'pi', thinkingLevel: undefined }),
        listModels: async () => [],
        listThinkingLevels: async () => []
      } as unknown as PiStructuredBackend
    })
    await adapter.acquire({
      identity: freshIdentity('ses-restore', 'pi'),
      fence: 0,
      spawnToken: 's1'
    })
    await expect(
      adapter.setOption({ sessionId: 'ses-restore', key: 'model', value: 'nope', fence: 0 })
    ).rejects.toThrow('UNKNOWN_MODEL')
    await expect(
      adapter.setOption({ sessionId: 'ses-restore', key: 'thinkingLevel', value: 'high', fence: 0 })
    ).resolves.toMatchObject({ thinkingLevel: 'high' })
    expect(adapter.readOptionRestoreFailures?.('ses-restore')).toEqual(['model'])
  })
})
