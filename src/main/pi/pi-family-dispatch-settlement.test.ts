// Pi-family dispatch admission + history-backed settlement over scripted
// children (PIF-4, #25). Adapter → backend → driver → transport for BOTH
// providers: prompt ack admits (never accepts), definite refusal rejects,
// transport ambiguity stays unknown and unresent, and admitted submissions
// settle only from durable history at the true final boundary with stable
// provider-native identity. No live LLM or network.

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
      // Best-effort temp cleanup only.
    }
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-dispatch-'))
  DIRS.push(dir)
  return dir
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

function textBody(
  text: string,
  extraBlocks: AgentJournalMessageItem['blocks'] = []
): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }, ...extraBlocks] }
}

/** Read untyped provider-history payloads with narrowing (never decoded as Pi's union). */
function probeHistoryEntry(
  entry: unknown
): { id: unknown; role: unknown; type: unknown } | undefined {
  if (typeof entry !== 'object' || entry === null || !('id' in entry) || !('type' in entry)) {
    return undefined
  }
  const message = 'message' in entry ? entry.message : undefined
  const messageRole =
    typeof message === 'object' && message !== null && 'role' in message ? message.role : undefined
  const topRole = 'role' in entry ? entry.role : undefined
  return { id: entry.id, role: messageRole ?? topRole, type: entry.type }
}

function findHistoryEntry(
  entries: readonly unknown[],
  id: string
): { role: unknown; type: unknown } | undefined {
  for (const entry of entries) {
    const probed = probeHistoryEntry(entry)
    if (probed?.id === id) {
      return probed
    }
  }
  return undefined
}

type Settlement = {
  sessionId: string
  clientMessageId: string
  providerIdentity: { provider: string; agent: string; sessionId: string; recordId: string }
}

async function waitForSettlements(settlements: Settlement[], count: number): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (settlements.length >= count) {
      return
    }
    if (Date.now() - start > 10_000) {
      throw new Error(`timed out waiting for ${count} late settlements`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Adapter over scripted children with late settlements collected. */
function adapterFor(
  dir: string,
  env: Record<string, string>,
  seen: string[] = [],
  extra: Parameters<typeof createPiRpcBackend>[0] = {}
) {
  const settlements: Settlement[] = []
  const backend = createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env }),
    spawnImpl: (spec) => {
      seen.push(spec.program)
      return spawnProcess(spec)
    },
    ...extra
  })
  const adapter = new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => dir,
    backend,
    readProcessStartTime: async () => 777,
    onDispatchSettledLate: (settlement) => {
      const identity = settlement.providerIdentity
      if (identity.provider === 'legacy') {
        settlements.push({
          sessionId: settlement.sessionId,
          clientMessageId: settlement.clientMessageId,
          providerIdentity: {
            provider: identity.provider,
            agent: identity.agent,
            sessionId: identity.sessionId,
            recordId: identity.recordId
          }
        })
      }
    }
  })
  return { backend, adapter, settlements }
}

const ENVS: Record<Provider, (file: string, sessionId: string) => Record<string, string>> = {
  pi: (file, sessionId) => ({ PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: sessionId }),
  omp: (file, sessionId) => ({ OMP_SCRIPT_SESSION_FILE: file, OMP_SCRIPT_SESSION_ID: sessionId })
}

function seedFile(dir: string, name: string, sessionId: string): string {
  const header = { type: 'session', sessionId, cwd: dir, leafId: 'e2' }
  const entries = [
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'seeded' }] }
    },
    {
      type: 'message',
      id: 'e2',
      parentId: 'e1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'seeded reply' }] }
    }
  ]
  const file = join(dir, name)
  writeFileSync(
    file,
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join('\n')
  )
  return file
}

describe('Pi-family dispatch admission and settlement', () => {
  it.each(['pi', 'omp'] as const)(
    'admits %s prompt ack and settles from history with stable provider identity',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const { backend, adapter, settlements } = adapterFor(
        dir,
        ENVS[provider](file, `${provider}-dispatch-1`)
      )
      const sessionId = `orca-${provider}-d1`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        const outcome = await adapter.dispatch({
          sessionId,
          clientMessageId: 'c1',
          body: textBody('hello dispatch'),
          fence: 0
        })
        expect(outcome).toEqual({ state: 'admitted' })
        await waitForSettlements(settlements, 1)
        const settlement = settlements[0]
        expect(settlement?.clientMessageId).toBe('c1')
        expect(settlement?.providerIdentity).toMatchObject({
          provider: 'legacy',
          agent: provider,
          sessionId: `${provider}-dispatch-1`
        })
        // Stable provider-native entry id, never the client message id.
        expect(settlement?.providerIdentity.recordId).not.toBe('c1')
        expect(settlement?.providerIdentity.recordId.length).toBeGreaterThan(0)
        const history = await backend.readEntries?.({ orcaSessionId: sessionId })
        const entry = findHistoryEntry(
          history?.entries ?? [],
          settlement?.providerIdentity.recordId ?? ''
        )
        expect(entry?.role).toBe('user')
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'settles %s once across duplicate terminal frames',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const { adapter, settlements } = adapterFor(dir, ENVS[provider](file, `${provider}-dup-1`))
      const sessionId = `orca-${provider}-dup`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        await expect(
          adapter.dispatch({
            sessionId,
            clientMessageId: 'c1',
            body: textBody('DUP-SETTLE hello'),
            fence: 0
          })
        ).resolves.toEqual({ state: 'admitted' })
        await waitForSettlements(settlements, 1)
        await sleep(300)
        expect(settlements).toHaveLength(1)
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)('rejects a definite %s refusal', async (provider) => {
    const dir = workspace()
    const file = join(dir, `${provider}-session.jsonl`)
    writeFileSync(file, '')
    const { adapter, settlements } = adapterFor(dir, ENVS[provider](file, `${provider}-rej-1`))
    const sessionId = `orca-${provider}-rej`
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 0,
        spawnToken: 't1'
      })
      await expect(
        adapter.dispatch({
          sessionId,
          clientMessageId: 'c1',
          body: textBody('REJECT me'),
          fence: 0
        })
      ).resolves.toEqual({ state: 'rejected', reason: 'scripted rejection' })
      await sleep(200)
      expect(settlements).toHaveLength(0)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it.each(['pi', 'omp'] as const)(
    'holds a %s exit as unknown and never resends it',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const log = join(dir, `${provider}-log.txt`)
      writeFileSync(log, '')
      const env =
        provider === 'pi'
          ? { ...ENVS.pi(file, `${provider}-exit-1`), PI_SCRIPT_LOG: log }
          : ENVS.omp(file, `${provider}-exit-1`)
      const { backend, adapter, settlements } = adapterFor(dir, env)
      const dispatch = vi.spyOn(backend, 'dispatch')
      const sessionId = `orca-${provider}-exit`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        await expect(
          adapter.dispatch({
            sessionId,
            clientMessageId: 'c1',
            body: textBody('EXIT now'),
            fence: 0
          })
        ).resolves.toMatchObject({ state: 'unknown' })
        await sleep(300)
        // No automatic resend: the provider was written once, and the ambiguity stands.
        expect(dispatch).toHaveBeenCalledTimes(1)
        expect(settlements).toHaveLength(0)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)('holds a %s prompt timeout as unknown', async (provider) => {
    const dir = workspace()
    const file = join(dir, `${provider}-session.jsonl`)
    writeFileSync(file, '')
    const { adapter, settlements } = adapterFor(
      dir,
      ENVS[provider](file, `${provider}-hang-1`),
      [],
      {
        defaultTimeoutMs: 400
      }
    )
    const sessionId = `orca-${provider}-hang`
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 0,
        spawnToken: 't1'
      })
      await expect(
        adapter.dispatch({ sessionId, clientMessageId: 'c1', body: textBody('HANG on'), fence: 0 })
      ).resolves.toMatchObject({ state: 'unknown' })
      expect(settlements).toHaveLength(0)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it.each(['pi', 'omp'] as const)(
    'rejects an unrepresentable %s body before any provider write',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const { backend, adapter, settlements } = adapterFor(
        dir,
        ENVS[provider](file, `${provider}-img-0`)
      )
      const dispatch = vi.spyOn(backend, 'dispatch')
      const sessionId = `orca-${provider}-img0`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        const body: AgentJournalMessageItem = {
          kind: 'message',
          role: 'user',
          blocks: [
            { type: 'text', text: 'classified prompt bytes' },
            { type: 'image-ref', url: 'https://example.invalid/classified.png' }
          ]
        }
        const outcome = await adapter.dispatch({ sessionId, clientMessageId: 'c1', body, fence: 0 })
        expect(outcome.state).toBe('rejected')
        expect(dispatch).not.toHaveBeenCalled()
        const reason = outcome.state === 'rejected' ? outcome.reason : ''
        expect(reason).not.toContain('classified')
        expect(reason).not.toContain('example.invalid')
        expect(settlements).toHaveLength(0)
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'carries %s image MIME and base64 through admission to settlement',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const png = join(dir, 'shot.png')
      writeFileSync(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9, 9]))
      const { adapter, settlements } = adapterFor(dir, ENVS[provider](file, `${provider}-img-1`))
      const sessionId = `orca-${provider}-img`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        await expect(
          adapter.dispatch({
            sessionId,
            clientMessageId: 'c1',
            body: textBody('look', [{ type: 'image-ref', path: png }]),
            fence: 0
          })
        ).resolves.toEqual({ state: 'admitted' })
        await waitForSettlements(settlements, 1)
        expect(settlements[0]?.providerIdentity.recordId).not.toBe('c1')
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'retains %s pending when the new history is ambiguous',
    async (provider) => {
      for (const marker of ['TWO-USER', 'NO-USER']) {
        const dir = workspace()
        const file = join(dir, `${provider}-session.jsonl`)
        writeFileSync(file, '')
        const { adapter, settlements } = adapterFor(dir, ENVS[provider](file, `${provider}-amb-1`))
        const sessionId = `orca-${provider}-amb`
        try {
          await adapter.acquire({
            identity: freshIdentity(sessionId, provider),
            fence: 0,
            spawnToken: 't1'
          })
          // Two user entries (or none) prove nothing about this submission: no invented identity, no resend.
          await expect(
            adapter.dispatch({
              sessionId,
              clientMessageId: 'c1',
              body: textBody(`${marker} hello`),
              fence: 0
            })
          ).resolves.toEqual({ state: 'admitted' })
          await sleep(400)
          expect(settlements).toHaveLength(0)
        } finally {
          await adapter.closeAll().catch(() => undefined)
        }
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'settles %s despite unrelated new entries around the user turn',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const { backend, adapter, settlements } = adapterFor(
        dir,
        ENVS[provider](file, `${provider}-noise-1`)
      )
      const sessionId = `orca-${provider}-noise`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        await expect(
          adapter.dispatch({
            sessionId,
            clientMessageId: 'c1',
            body: textBody('WITH-NOISE hello'),
            fence: 0
          })
        ).resolves.toEqual({ state: 'admitted' })
        await waitForSettlements(settlements, 1)
        const history = await backend.readEntries?.({ orcaSessionId: sessionId })
        const entry = findHistoryEntry(
          history?.entries ?? [],
          settlements[0]?.providerIdentity.recordId ?? ''
        )
        expect(entry?.role).toBe('user')
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'isolates the new %s entry behind the pre-dispatch cursor',
    async (provider) => {
      const dir = workspace()
      const file = seedFile(dir, `${provider}-seed.jsonl`, `${provider}-seed-1`)
      const { adapter, settlements } = adapterFor(dir, ENVS[provider](file, `${provider}-seed-1`))
      const sessionId = `orca-${provider}-seed`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 't1'
        })
        await expect(
          adapter.dispatch({
            sessionId,
            clientMessageId: 'c1',
            body: textBody('hello fresh'),
            fence: 0
          })
        ).resolves.toEqual({ state: 'admitted' })
        await waitForSettlements(settlements, 1)
        // Seeded entries predate the cursor and can never settle this submission.
        expect(['e1', 'e2']).not.toContain(settlements[0]?.providerIdentity.recordId)
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )

  it.each(['pi', 'omp'] as const)(
    'a stale %s generation cannot settle replacement dispatch state',
    async (provider) => {
      const dir = workspace()
      const file = join(dir, `${provider}-session.jsonl`)
      writeFileSync(file, '')
      const { adapter, settlements } = adapterFor(dir, ENVS[provider](file, `${provider}-gen-1`))
      const sessionId = `orca-${provider}-gen`
      try {
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 'gen-1'
        })
        await adapter.dispatch({
          sessionId,
          clientMessageId: 'c-old',
          body: textBody('hello old'),
          fence: 0
        })
        await adapter.acquire({
          identity: freshIdentity(sessionId, provider),
          fence: 0,
          spawnToken: 'gen-2'
        })
        await adapter.dispatch({
          sessionId,
          clientMessageId: 'c-new',
          body: textBody('hello new'),
          fence: 0
        })
        await waitForSettlements(settlements, 1)
        await sleep(300)
        expect(settlements).toHaveLength(1)
        expect(settlements[0]?.clientMessageId).toBe('c-new')
        await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      } finally {
        await adapter.closeAll().catch(() => undefined)
      }
    }
  )
})

describe('OMP prompt_result dialect over a scripted child', () => {
  function ompAdapter(dir: string, env: Record<string, string>) {
    const file = join(dir, 'omp-session.jsonl')
    writeFileSync(file, '')
    return {
      file,
      ...adapterFor(dir, {
        OMP_SCRIPT_SESSION_FILE: file,
        OMP_SCRIPT_SESSION_ID: 'omp-dialect-1',
        ...env
      })
    }
  }

  it('retires a locally-completed prompt without awaiting an agent turn', async () => {
    const dir = workspace()
    const { adapter, settlements } = ompAdapter(dir, {})
    const sessionId = 'orca-omp-local'
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, 'omp'),
        fence: 0,
        spawnToken: 't1'
      })
      await expect(
        adapter.dispatch({
          sessionId,
          clientMessageId: 'c1',
          body: textBody('LOCAL-ONLY hello'),
          fence: 0
        })
      ).resolves.toEqual({ state: 'admitted' })
      // The fixture sends no agent_end for local-only prompts; history alone settles it.
      await waitForSettlements(settlements, 1)
      expect(settlements[0]?.providerIdentity).toMatchObject({
        agent: 'omp',
        sessionId: 'omp-dialect-1'
      })
      expect(settlements[0]?.providerIdentity.recordId).not.toBe('c1')
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it('settles a duplicate local-only result exactly once', async () => {
    const dir = workspace()
    const { adapter, settlements } = ompAdapter(dir, {})
    const sessionId = 'orca-omp-duplocal'
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, 'omp'),
        fence: 0,
        spawnToken: 't1'
      })
      await expect(
        adapter.dispatch({
          sessionId,
          clientMessageId: 'c1',
          body: textBody('LOCAL-ONLY DUP-RESULT hello'),
          fence: 0
        })
      ).resolves.toEqual({ state: 'admitted' })
      await waitForSettlements(settlements, 1)
      await sleep(300)
      expect(settlements).toHaveLength(1)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it('retains pending when a local-only prompt commits no provable entry', async () => {
    const dir = workspace()
    const { adapter, settlements } = ompAdapter(dir, {})
    const sessionId = 'orca-omp-noentry'
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, 'omp'),
        fence: 0,
        spawnToken: 't1'
      })
      await expect(
        adapter.dispatch({
          sessionId,
          clientMessageId: 'c1',
          body: textBody('LOCAL-ONLY NO-ENTRY hello'),
          fence: 0
        })
      ).resolves.toEqual({ state: 'admitted' })
      await sleep(400)
      expect(settlements).toHaveLength(0)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })

  it('settles OMP-native entry variants without Pi decoding', async () => {
    const dir = workspace()
    const { backend, adapter, settlements } = ompAdapter(dir, { OMP_SCRIPT_NATIVE_ENTRIES: '1' })
    const sessionId = 'orca-omp-native'
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, 'omp'),
        fence: 0,
        spawnToken: 't1'
      })
      await expect(
        adapter.dispatch({
          sessionId,
          clientMessageId: 'c1',
          body: textBody('hello native'),
          fence: 0
        })
      ).resolves.toEqual({ state: 'admitted' })
      await waitForSettlements(settlements, 1)
      const history = await backend.readEntries?.({ orcaSessionId: sessionId })
      const entry = findHistoryEntry(
        history?.entries ?? [],
        settlements[0]?.providerIdentity.recordId ?? ''
      )
      expect(entry?.type).toBe('omp_message')
      expect(entry?.role).toBe('user')
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeAll().catch(() => undefined)
    }
  })
})
