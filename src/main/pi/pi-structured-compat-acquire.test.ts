// Deterministic scripted-Pi compat acquisition tests (SNC1.10 Orca slice).
// Proves production wiring consumes evidence: supported/unsupported acquire,
// capability mismatch, TUI fallback, resume/restart, and session isolation.
// No binary, no credentials; every child is closed and every dir removed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'
import { MIN_KNOWN_GOOD_PI_VERSION } from './pi-structured-compat'
import { verifyPiLiveCapabilities } from './pi-live-capability-probe'
import { rejectedError } from './rpc/pi-rpc-errors'
import { classifyPiHandoffFailure } from './pi-structured-handoff-policy'
import { buildPiTuiResumeProviderSession } from './pi-structured-tui-resume'
const SCRIPT = fileURLToPath(new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url))
const LOCAL: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'folder'
}
const PROD_CAPS = ['textStreaming', 'options', 'history', 'cancel', 'resume'] as const
function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'pi-compat-ws-'))
}
function rmDir(dir: string): void {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      const start = Date.now()
      while (Date.now() - start < 100) {
        // Keep the test synchronous and short.
      }
    }
  }
}
function backendWithScript(env: Record<string, string>, extra: Record<string, unknown> = {}) {
  return createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env }),
    ...(extra as object)
  })
}
function identity(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'pi',
    providerHandle: { kind: 'opaque', agent: 'pi', value: 'pending' }
  } as unknown as AgentSessionJournalIdentity
}
function adapterFor(
  backend: ReturnType<typeof createPiRpcBackend>,
  overrides: Record<string, unknown> = {}
) {
  return new PiStructuredSessionAdapter({
    resolveWorkspacePath: (id: string) =>
      (overrides['workspaceRoot'] as string | undefined) ?? `/tmp/${id}`,
    backend,
    readProcessStartTime: async () => 12345,
    piVersion: MIN_KNOWN_GOOD_PI_VERSION,
    requiredCapabilities: [...PROD_CAPS],
    ...(overrides as object)
  } as never)
}
async function waitForHistory(
  backend: ReturnType<typeof createPiRpcBackend>,
  sessionId: string,
  timeoutMs = 10_000
) {
  const start = Date.now()
  for (;;) {
    try {
      return await backend.readResumeHistory!({ orcaSessionId: sessionId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('PI_HISTORY_BUSY')) {
        throw error
      }
      if (Date.now() - start > timeoutMs) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
describe('Pi compat acquisition over a scripted child', () => {
  it('acquires supported with evidence on every call and proves option/history live RPCs', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    const acquire = vi.spyOn(backend, 'acquire')
    try {
      const compat = { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      const first = await backend.acquire({
        orcaSessionId: 'ses-ok',
        workspaceRoot: dir,
        spawnToken: 's1',
        compat
      })
      expect(first.piSessionId).not.toBe('')
      expect(first.model).toBe('script-provider/script-model')
      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          compat: expect.objectContaining({ piVersion: MIN_KNOWN_GOOD_PI_VERSION })
        })
      )
      await expect(
        backend.setOption!({
          orcaSessionId: 'ses-ok',
          key: 'model',
          value: 'script-provider/script-model'
        })
      ).resolves.toMatchObject({ model: 'script-provider/script-model' })
      await expect(
        backend.setOption!({ orcaSessionId: 'ses-ok', key: 'autoCompaction', value: 'true' })
      ).resolves.toMatchObject({ autoCompaction: 'true' })
      await backend.dispatch({
        orcaSessionId: 'ses-ok',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] } as never
      })
      const history = await waitForHistory(backend, 'ses-ok')
      expect(typeof history.leafId).toBe('string')
      expect(history.rows.length).toBeGreaterThan(0)
      await expect(backend.close({ orcaSessionId: 'ses-ok' })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: 'ses-ok' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('refuses unsupported version, location, and unknown capabilities pre-spawn with TUI fallback', async () => {
    const dir = workspace()
    const backend = backendWithScript({})
    try {
      await expect(
        backend.acquire({
          orcaSessionId: 's',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: { piVersion: '0.1.0', requiredCapabilities: [...PROD_CAPS] }
        })
      ).rejects.toThrow('PI_COMPAT_VERSION')
      const adapter = adapterFor(backend, { workspaceRoot: dir, piVersion: '0.1.0' })
      await expect(
        adapter.acquire({ identity: identity('s'), fence: 0, spawnToken: 's', location: LOCAL })
      ).rejects.toThrow('PI_COMPAT_VERSION')
      const badLocation = adapterFor(backend, { workspaceRoot: dir })
      await expect(
        badLocation.acquire({
          identity: identity('s2'),
          fence: 0,
          spawnToken: 's',
          location: { ...LOCAL, executionHostId: 'ssh:host-1' }
        })
      ).rejects.toThrow('PI_COMPAT_LOCATION')
      await expect(
        backend.acquire({
          orcaSessionId: 's3',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['teleportation'] }
        })
      ).rejects.toThrow('PI_COMPAT_CAPABILITY')
      expect(classifyPiHandoffFailure('PI_COMPAT_VERSION')).toBe('retry-tui')
      expect(classifyPiHandoffFailure('PI_COMPAT_LOCATION')).toBe('retry-tui')
      expect(classifyPiHandoffFailure('PI_COMPAT_CAPABILITY')).toBe('retry-tui')
    } finally {
      rmDir(dir)
    }
  })
  it('requires nonempty evidence in production mode and passes it on every acquire', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const strict = createPiRpcBackend({
      piCommand: process.execPath,
      piArgs: [SCRIPT],
      resolveEnv: () => ({ ...process.env, PI_SCRIPT_SESSION_FILE: file }),
      requireCompat: true
    })
    try {
      await expect(
        strict.acquire({ orcaSessionId: 's', workspaceRoot: dir, spawnToken: 's' })
      ).rejects.toThrow('PI_COMPAT_EVIDENCE_MISSING')
      await expect(
        strict.acquire({
          orcaSessionId: 's',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION }
        })
      ).rejects.toThrow('PI_COMPAT_EVIDENCE_MISSING')
      const ok = await strict.acquire({
        orcaSessionId: 's',
        workspaceRoot: dir,
        spawnToken: 's',
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      })
      expect(ok.piSessionId).not.toBe('')
      await expect(strict.close({ orcaSessionId: 's' })).resolves.toBe(true)
      const strictAdapter = new PiStructuredSessionAdapter({
        resolveWorkspacePath: () => dir,
        backend: strict,
        readProcessStartTime: async () => 1,
        requireCompatEvidence: true,
        piVersion: null,
        requiredCapabilities: [...PROD_CAPS]
      })
      await expect(
        strictAdapter.acquire({
          identity: identity('s2'),
          fence: 0,
          spawnToken: 's',
          location: LOCAL
        })
      ).rejects.toThrow('PI_COMPAT_EVIDENCE_MISSING')
      expect(classifyPiHandoffFailure('PI_COMPAT_EVIDENCE_MISSING')).toBe('retry-tui')
    } finally {
      await strict.close({ orcaSessionId: 's' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('tears down the started child when live probes fail and stays recoverable', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const noCatalog = backendWithScript({
      PI_SCRIPT_SESSION_FILE: file,
      PI_SCRIPT_DISABLE_METHODS:
        'get_available_models,get_available_thinking_levels,get_entries,get_tree'
    })
    try {
      await expect(
        noCatalog.acquire({
          orcaSessionId: 's',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: {
            piVersion: MIN_KNOWN_GOOD_PI_VERSION,
            requiredCapabilities: ['options', 'history']
          }
        })
      ).rejects.toThrow('PI_COMPAT_CAPABILITY')
      const retry = await noCatalog.acquire({
        orcaSessionId: 's2',
        workspaceRoot: dir,
        spawnToken: 's',
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['textStreaming'] }
      })
      expect(retry.piSessionId).not.toBe('')
      await expect(noCatalog.close({ orcaSessionId: 's2' })).resolves.toBe(true)
    } finally {
      await noCatalog.close({ orcaSessionId: 's' }).catch(() => undefined)
      await noCatalog.close({ orcaSessionId: 's2' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('refuses options without live setters and images without an image-capable model', async () => {
    // Setter and switch presence are proven without a child: the running
    // connection object itself must expose the mutations the capability
    // advertises (presence only, never invoked so probing never mutates).
    await expect(
      verifyPiLiveCapabilities(
        {
          getAvailableModels: async () => ({ models: [{ input: ['image'] }] }),
          getAvailableThinkingLevels: async () => ({ levels: ['low'] })
        } as never,
        ['options']
      )
    ).resolves.toMatch(/setter/)
    await expect(
      verifyPiLiveCapabilities(
        {
          getAvailableModels: async () => ({ models: [{ input: ['image'] }] }),
          getAvailableThinkingLevels: async () => ({ levels: ['low'] }),
          setModel: async () => ({}),
          setThinkingLevel: async () => undefined,
          setAutoCompaction: async () => undefined,
          getEntries: async () => ({ entries: [] })
        } as never,
        ['resume']
      )
    ).resolves.toMatch(/switchSession/)
    // `set_model` verb proof without mutation: a definite Model-not-found
    // rejection proves the running Pi understands the command; any other
    // outcome proves nothing and fails the probe.
    const verbProven = {
      getAvailableModels: async () => ({ models: [{ input: ['image'] }] }),
      getAvailableThinkingLevels: async () => ({ levels: ['low'] }),
      setModel: async () => {
        throw rejectedError(
          'set_model',
          undefined,
          'Model not found: no exact provider/modelId match'
        )
      },
      setThinkingLevel: async () => undefined,
      setAutoCompaction: async () => undefined
    } as never
    await expect(
      verifyPiLiveCapabilities(verbProven, ['options'], 1_000, { id: 'm', provider: 'p' } as never)
    ).resolves.toBeNull()
    const verbUnproven = {
      getAvailableModels: async () => ({ models: [{ input: ['image'] }] }),
      getAvailableThinkingLevels: async () => ({ levels: ['low'] }),
      setModel: async () => {
        throw new Error('transport boom')
      },
      setThinkingLevel: async () => undefined,
      setAutoCompaction: async () => undefined
    } as never
    await expect(
      verifyPiLiveCapabilities(verbUnproven, ['options'], 1_000, {
        id: 'm',
        provider: 'p'
      } as never)
    ).resolves.toMatch(/verb unproven/)
    // History serves from either RPC: entries failure falls back to tree.
    const treeFallback = {
      getEntries: async () => {
        throw new Error('entries gone')
      },
      getTree: async () => ({ tree: [] })
    } as never
    await expect(verifyPiLiveCapabilities(treeFallback, ['history'])).resolves.toBeNull()
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const textOnly = backendWithScript({
      PI_SCRIPT_SESSION_FILE: file,
      PI_SCRIPT_TEXT_ONLY_CATALOG: '1'
    })
    try {
      await expect(
        textOnly.acquire({
          orcaSessionId: 's',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['images'] }
        })
      ).rejects.toThrow('PI_COMPAT_CAPABILITY')
      const ok = await textOnly.acquire({
        orcaSessionId: 's2',
        workspaceRoot: dir,
        spawnToken: 's',
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['options'] }
      })
      expect(ok.piSessionId).not.toBe('')
      await expect(textOnly.close({ orcaSessionId: 's2' })).resolves.toBe(true)
    } finally {
      await textOnly.close({ orcaSessionId: 's' }).catch(() => undefined)
      await textOnly.close({ orcaSessionId: 's2' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('refuses options when the set_model verb is unproven though wrappers exist', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    // Wrappers stay present (real PiRpcConnection shape); the underlying
    // `set_model` command rejects without Model-not-found evidence.
    const noVerb = backendWithScript({
      PI_SCRIPT_SESSION_FILE: file,
      PI_SCRIPT_DISABLE_METHODS: 'set_model'
    })
    try {
      await expect(
        noVerb.acquire({
          orcaSessionId: 's',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: ['options'] }
        })
      ).rejects.toThrow(/verb unproven|PI_COMPAT_CAPABILITY/)
    } finally {
      await noVerb.close({ orcaSessionId: 's' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('falls back to Pi TUI with the exact session file and reacquires without duplication', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    try {
      await expect(
        backend.acquire({
          orcaSessionId: 's',
          workspaceRoot: dir,
          spawnToken: 's',
          compat: { piVersion: '0.1.0', requiredCapabilities: [...PROD_CAPS] }
        })
      ).rejects.toThrow('PI_COMPAT_VERSION')
      const acquired = await backend.acquire({
        orcaSessionId: 'ses-tui',
        workspaceRoot: dir,
        spawnToken: 's',
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      })
      const record = {
        sessionId: 'ses-tui',
        location: LOCAL,
        provider: 'pi',
        providerHandleChain: [
          {
            linkId: 'l1',
            handle: {
              provider: 'pi',
              sessionId: acquired.piSessionId,
              leafId: acquired.leafId,
              sessionFile: file
            },
            origin: 'created',
            mintedAtFence: 0,
            observedAt: Date.now()
          }
        ],
        accountHome: { variable: 'PI_STATE_DIR', path: dir }
      } as never
      const providerSession = buildPiTuiResumeProviderSession(record)
      expect(providerSession.transcriptPath).toBe(file)
      await expect(backend.close({ orcaSessionId: 'ses-tui' })).resolves.toBe(true)
      const reacquired = await backend.acquire({
        orcaSessionId: 'ses-tui-2',
        workspaceRoot: dir,
        spawnToken: 's2',
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      })
      expect(reacquired.piSessionId).not.toBe('')
      await expect(backend.close({ orcaSessionId: 'ses-tui-2' })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: 's' }).catch(() => undefined)
      await backend.close({ orcaSessionId: 'ses-tui' }).catch(() => undefined)
      await backend.close({ orcaSessionId: 'ses-tui-2' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('resumes the same session across a restart with wholesale history and no duplication', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    const header = { type: 'session', sessionId: 'pi-resume-compat', cwd: dir, leafId: 'e3' }
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
        message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] }
      },
      {
        type: 'message',
        id: 'e3',
        parentId: 'e2',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'third' }] }
      }
    ]
    writeFileSync(
      file,
      [JSON.stringify(header), ...entries.map((e) => JSON.stringify(e))].join('\n')
    )
    const firstBackend = backendWithScript({ PI_SCRIPT_SESSION_FILE: join(dir, 'other.jsonl') })
    try {
      const acquired = await firstBackend.acquire({
        orcaSessionId: 'ses-r',
        workspaceRoot: dir,
        resumePiSessionId: 'pi-resume-compat',
        resumeSessionFile: file,
        spawnToken: 's1',
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      })
      expect(acquired.piSessionId).toBe('pi-resume-compat')
      const history = await firstBackend.readResumeHistory!({ orcaSessionId: 'ses-r' })
      expect(history.leafId).toBe('e3')
      expect(history.rows.map((r) => r.text).join('|')).toContain('first')
      await expect(firstBackend.close({ orcaSessionId: 'ses-r' })).resolves.toBe(true)
      const secondBackend = backendWithScript({ PI_SCRIPT_SESSION_FILE: join(dir, 'other2.jsonl') })
      try {
        const reacquired = await secondBackend.acquire({
          orcaSessionId: 'ses-r2',
          workspaceRoot: dir,
          resumePiSessionId: 'pi-resume-compat',
          resumeSessionFile: file,
          spawnToken: 's2',
          compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
        })
        expect(reacquired.piSessionId).toBe('pi-resume-compat')
        const secondHistory = await secondBackend.readResumeHistory!({ orcaSessionId: 'ses-r2' })
        expect(secondHistory.leafId).toBe('e3')
        expect(secondHistory.rows).toHaveLength(history.rows.length)
        await expect(secondBackend.close({ orcaSessionId: 'ses-r2' })).resolves.toBe(true)
      } finally {
        await secondBackend.close({ orcaSessionId: 'ses-r2' }).catch(() => undefined)
      }
    } finally {
      await firstBackend.close({ orcaSessionId: 'ses-r' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('keeps sessions isolated with no cross-session history or prompt leakage', async () => {
    const dir = workspace()
    const fileA = join(dir, 'a.jsonl')
    const fileB = join(dir, 'b.jsonl')
    writeFileSync(fileA, '')
    writeFileSync(fileB, '')
    const backend = backendWithScript({})
    const rows: { key: string; kind: string }[] = []
    const sinkFor = () =>
      ({
        appendItem: (id: { sessionId?: string }, body: { kind: string }) => {
          rows.push({
            key: String((id as { sessionId?: string }).sessionId ?? ''),
            kind: body.kind
          })
        },
        appendTombstone: () => undefined,
        publish: () => undefined,
        setActivity: () => undefined
      }) as never
    try {
      await backend.acquire({
        orcaSessionId: 'ses-a',
        workspaceRoot: dir,
        spawnToken: 'sa',
        sink: sinkFor(),
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      })
      await backend.acquire({
        orcaSessionId: 'ses-b',
        workspaceRoot: dir,
        spawnToken: 'sb',
        sink: sinkFor(),
        compat: { piVersion: MIN_KNOWN_GOOD_PI_VERSION, requiredCapabilities: [...PROD_CAPS] }
      })
      await backend.dispatch({
        orcaSessionId: 'ses-a',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello-a' }]
        } as never
      })
      await backend.dispatch({
        orcaSessionId: 'ses-b',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'hello-b' }]
        } as never
      })
      const historyA = await waitForHistory(backend, 'ses-a')
      const historyB = await waitForHistory(backend, 'ses-b')
      expect(historyA.rows.map((r) => r.text).join('|')).toContain('hello-a')
      expect(historyA.rows.map((r) => r.text).join('|')).not.toContain('hello-b')
      expect(historyB.rows.map((r) => r.text).join('|')).toContain('hello-b')
      expect(historyB.rows.map((r) => r.text).join('|')).not.toContain('hello-a')
      await expect(
        backend.dispatch({
          orcaSessionId: 'ses-missing',
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] } as never
        })
      ).resolves.toMatchObject({ status: 'rejected' })
      await expect(backend.close({ orcaSessionId: 'ses-a' })).resolves.toBe(true)
      await expect(
        backend.dispatch({
          orcaSessionId: 'ses-a',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'after-close' }]
          } as never
        })
      ).resolves.toMatchObject({ status: 'rejected' })
      const stillLive = await backend.dispatch({
        orcaSessionId: 'ses-b',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'still-live' }]
        } as never
      })
      expect(stillLive.status).toBe('accepted')
      await expect(backend.close({ orcaSessionId: 'ses-b' })).resolves.toBe(true)
    } finally {
      await backend.close({ orcaSessionId: 'ses-a' }).catch(() => undefined)
      await backend.close({ orcaSessionId: 'ses-b' }).catch(() => undefined)
      rmDir(dir)
    }
  })
  it('probes the version lazily on Pi acquire, never at construction', async () => {
    const dir = workspace()
    const file = join(dir, 'pi-session.jsonl')
    writeFileSync(file, '')
    const backend = backendWithScript({ PI_SCRIPT_SESSION_FILE: file })
    let probeCalls = 0
    const resolvePiVersion = async (): Promise<string | null> => {
      probeCalls += 1
      return MIN_KNOWN_GOOD_PI_VERSION
    }
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => 12345,
      requireCompatEvidence: true,
      resolvePiVersion,
      requiredCapabilities: [...PROD_CAPS]
    })
    expect(probeCalls).toBe(0)
    await adapter.acquire({
      identity: identity('lazy-1'),
      fence: 0,
      spawnToken: 's1',
      location: LOCAL
    })
    expect(probeCalls).toBe(1)
    await adapter.acquire({
      identity: identity('lazy-2'),
      fence: 0,
      spawnToken: 's2',
      location: LOCAL
    })
    expect(probeCalls).toBe(2)
    await expect(adapter.closeSession('lazy-1')).resolves.toBe(true)
    await expect(adapter.closeSession('lazy-2')).resolves.toBe(true)
    rmDir(dir)
  })
})
