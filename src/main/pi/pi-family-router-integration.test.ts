// PIF-9 (#30) hardening: production call-graph integration for Pi and OMP.
//
// Exercises the real host-adjacent stack — StructuredAgentSessionAdapterRouter
// → one shared PiStructuredSessionAdapter → production createPiRpcBackend →
// focused Pi-family helpers → scripted `pi`/`omp --mode rpc` children — with
// no fakes below the router. The durable store, restart reconciler, TUI
// handoff flow, transport backpressure, and unproven-exit paths already have
// dedicated suites (see the map at the bottom); this file proves they all hang
// off one shared adapter selection with per-provider dialect behavior.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from '../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'

const PI_SCRIPT = fileURLToPath(new URL('./rpc/__fixtures__/scripted-pi-child.mjs', import.meta.url))
const OMP_SCRIPT = fileURLToPath(
  new URL('./rpc/__fixtures__/scripted-omp-child.mjs', import.meta.url)
)

type Provider = 'pi' | 'omp'
type Row = { identityKey: string; body: AgentJournalItemBody }
type Settlement = {
  sessionId: string
  clientMessageId: string
  providerIdentity: { provider: string; agent: string; sessionId: string; recordId: string }
}

const DIRS: string[] = []
afterEach(() => {
  for (const dir of DIRS.splice(0)) {
    rmDir(dir)
  }
  vi.restoreAllMocks()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-pif9-'))
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

function capturingSink(rows: Row[]): StructuredAgentSessionEventSink {
  return {
    appendItem: (identity, body) => {
      rows.push({ identityKey: agentJournalItemKey(identity), body })
    },
    appendTombstone: () => undefined,
    publish: () => undefined,
    setActivity: () => undefined
  }
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for scripted Pi-family condition: ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function sessionEnv(
  provider: Provider,
  dir: string,
  sessionId: string,
  logFile?: string
): Record<string, string> {
  const file = join(dir, `${provider}-session.jsonl`)
  writeFileSync(file, '')
  if (logFile) {
    writeFileSync(logFile, '')
  }
  if (provider === 'pi') {
    return logFile
      ? {
          PI_SCRIPT_SESSION_FILE: file,
          PI_SCRIPT_SESSION_ID: sessionId,
          PI_SCRIPT_LOG: logFile
        }
      : { PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: sessionId }
  }
  return logFile
    ? {
        OMP_SCRIPT_SESSION_FILE: file,
        OMP_SCRIPT_SESSION_ID: sessionId,
        OMP_SCRIPT_LOG: logFile
      }
    : { OMP_SCRIPT_SESSION_FILE: file, OMP_SCRIPT_SESSION_ID: sessionId }
}

function inertAdapter(): StructuredAgentSessionAdapter {
  const refuse = async (): Promise<never> => {
    throw new Error('inert stub adapter owns no sessions')
  }
  return {
    acquire: refuse,
    dispatch: refuse,
    cancelTurn: refuse,
    answerPrompt: refuse,
    setOption: refuse
  }
}

type Stack = {
  backend: ReturnType<typeof createPiRpcBackend>
  adapter: PiStructuredSessionAdapter
  router: StructuredAgentSessionAdapterRouter
  settlements: Settlement[]
  spawns: string[]
}

// One shared adapter under the `pi` key, exactly like production installs it;
// the router must serve `omp` from the same instance via fallback.
function buildStack(
  dir: string,
  env: Record<string, string>,
  overrides: Parameters<typeof createPiRpcBackend>[0] = {}
): Stack {
  const settlements: Settlement[] = []
  const spawns: string[] = []
  const backend = createPiRpcBackend({
    piCommand: process.execPath,
    piArgs: [PI_SCRIPT],
    ompCommand: process.execPath,
    ompArgs: [OMP_SCRIPT],
    resolveEnv: () => ({ ...process.env, ...env }),
    spawnImpl: (spec) => {
      spawns.push(`${spec.program} ${(spec.args ?? []).join(' ')}`)
      return spawnProcess(spec)
    },
    ...overrides
  })
  const adapter = new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => dir,
    backend,
    readProcessStartTime: async () => 777,
    onDispatchSettledLate: (settlement) => {
      const identity = settlement.providerIdentity
      if (identity.provider !== 'legacy') {
        return
      }
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
  })
  const router = new StructuredAgentSessionAdapterRouter(
    { claude: inertAdapter(), codex: inertAdapter(), pi: adapter },
    async () => {}
  )
  return { backend, adapter, router, settlements, spawns }
}

async function acquireViaRouter(
  stack: Stack,
  sessionId: string,
  provider: Provider,
  rows: Row[],
  fence = 3
) {
  return stack.router.acquire({
    identity: freshIdentity(sessionId, provider),
    fence,
    spawnToken: `spawn-${sessionId}`,
    events: capturingSink(rows)
  })
}

async function waitSettlement(
  settlements: Settlement[],
  clientMessageId: string,
  count = 1
): Promise<Settlement[]> {
  await waitFor(
    () => settlements.filter((entry) => entry.clientMessageId === clientMessageId).length >= count,
    `settlement for ${clientMessageId}`
  )
  return settlements.filter((entry) => entry.clientMessageId === clientMessageId)
}

function assistantTexts(rows: Row[]): string[] {
  const texts: string[] = []
  for (const row of rows) {
    if (row.body.kind === 'message' && row.body.role === 'assistant') {
      texts.push(
        row.body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
      )
    }
  }
  return texts
}

function promptRows(rows: Row[]): Row[] {
  return rows.filter((row) => row.body.kind === 'approval' || row.body.kind === 'question')
}

// Stable journal rows: streamed deltas update one row under one key, so every
// key must map to exactly one row kind. A key reused across kinds would be a
// duplicate/overwritten row, not an update.
function assertStableRowKeys(rows: Row[]): void {
  const kinds = new Map<string, Set<string>>()
  for (const row of rows) {
    const kind =
      row.body.kind === 'message' ? `message:${row.body.role}` : row.body.kind
    const seen = kinds.get(row.identityKey) ?? new Set<string>()
    seen.add(kind)
    kinds.set(row.identityKey, seen)
  }
  expect(rows.length).toBeGreaterThan(0)
  for (const [key, kindSet] of kinds) {
    expect(kindSet.size, `row key ${key} carries one row kind`).toBe(1)
  }
}

describe('PIF-9 shared adapter selection', () => {
  it('serves pi and omp from one installed adapter and never consults external', async () => {
    const dir = workspace()
    const stack = buildStack(dir, {})
    const externalAcquire = vi.fn(async () => {
      throw new Error('external must never serve pi-family sessions')
    })
    const external = inertAdapter()
    external.acquire = externalAcquire
    const router = new StructuredAgentSessionAdapterRouter(
      { claude: inertAdapter(), codex: inertAdapter(), pi: stack.adapter, external },
      async () => {}
    )
    const piRows: Row[] = []
    const ompRows: Row[] = []
    try {
      // Capability delegates to the shared adapter; the assertion compares
      // against the adapter so a machine without start-time proof still proves
      // delegation rather than a hard-coded verdict.
      const local = {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      } as const
      expect(router.supportsCreate?.(local, 'pi')).toBe(
        stack.adapter.supportsCreate(local, 'pi')
      )
      expect(router.supportsCreate?.(local, 'omp')).toBe(
        stack.adapter.supportsCreate(local, 'omp')
      )
      const piSessionFile = join(dir, 'pi-session.jsonl')
      const ompSessionFile = join(dir, 'omp-session.jsonl')
      writeFileSync(piSessionFile, '')
      writeFileSync(ompSessionFile, '')
      const piEnv = {
        PI_SCRIPT_SESSION_FILE: piSessionFile,
        PI_SCRIPT_SESSION_ID: 'pi-shared-1'
      }
      const ompEnv = {
        OMP_SCRIPT_SESSION_FILE: ompSessionFile,
        OMP_SCRIPT_SESSION_ID: 'omp-shared-1'
      }
      const mixed = buildStack(dir, { ...piEnv, ...ompEnv })
      const mixedRouter = new StructuredAgentSessionAdapterRouter(
        { claude: inertAdapter(), codex: inertAdapter(), pi: mixed.adapter, external },
        async () => {}
      )
      const piAcquired = await mixedRouter.acquire({
        identity: freshIdentity('ses-shared-pi', 'pi'),
        fence: 3,
        spawnToken: 'spawn-shared-pi',
        events: capturingSink(piRows)
      })
      const ompAcquired = await mixedRouter.acquire({
        identity: freshIdentity('ses-shared-omp', 'omp'),
        fence: 3,
        spawnToken: 'spawn-shared-omp',
        events: capturingSink(ompRows)
      })
      expect(piAcquired.link.handle).toMatchObject({ provider: 'pi' })
      expect(ompAcquired.link.handle).toMatchObject({ provider: 'omp' })
      expect(externalAcquire).not.toHaveBeenCalled()
      // Exactly one provider child per live session, each its own process.
      expect(mixed.spawns).toHaveLength(2)
      await expect(mixedRouter.closeSession('ses-shared-pi')).resolves.toBe(true)
      await expect(mixedRouter.closeSession('ses-shared-omp')).resolves.toBe(true)
    } finally {
      await stack.router.closeSession('ses-shared-pi').catch(() => undefined)
      await stack.router.closeSession('ses-shared-omp').catch(() => undefined)
      rmDir(dir)
    }
  })

  it('keeps remote and WSL locations unsupported for both providers', () => {
    const dir = workspace()
    const stack = buildStack(dir, {})
    const remote = {
      executionHostId: 'ssh:fixture-remote',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    } as const
    const wsl = {
      executionHostId: 'local',
      wslDistro: 'Ubuntu',
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    } as const
    expect(stack.router.supportsCreate?.(remote, 'pi')).toBe(false)
    expect(stack.router.supportsCreate?.(remote, 'omp')).toBe(false)
    expect(stack.router.supportsCreate?.(wsl, 'pi')).toBe(false)
    expect(stack.router.supportsCreate?.(wsl, 'omp')).toBe(false)
  })

  it('a missing pi executable fails closed while omp still acquires', async () => {
    const dir = workspace()
    const ompFile = join(dir, 'omp-session.jsonl')
    writeFileSync(ompFile, '')
    const stack = buildStack(
      dir,
      { OMP_SCRIPT_SESSION_FILE: ompFile, OMP_SCRIPT_SESSION_ID: 'omp-solo-1' },
      { piCommand: 'pi-binary-that-does-not-exist-zzz' }
    )
    const rows: Row[] = []
    await expect(
      stack.router.acquire({
        identity: freshIdentity('ses-pi-missing', 'pi'),
        fence: 3,
        spawnToken: 'spawn-pi-missing',
        events: capturingSink(rows)
      })
    ).rejects.toThrow()
    const acquired = await stack.router.acquire({
      identity: freshIdentity('ses-omp-solo', 'omp'),
      fence: 3,
      spawnToken: 'spawn-omp-solo',
      events: capturingSink(rows)
    })
    expect(acquired.link.handle).toMatchObject({ provider: 'omp', sessionId: 'omp-solo-1' })
    await expect(stack.router.closeSession('ses-omp-solo')).resolves.toBe(true)
  })
})

describe.each(['pi', 'omp'] as const)('PIF-9 happy path over a scripted %s child', (provider) => {
  it('create → dispatch → stream → settle → options → commands → proven close', async () => {
    const dir = workspace()
    const log = join(dir, 'requests.log')
    const providerSessionId = `${provider}-pif9-happy-1`
    const stack = buildStack(dir, sessionEnv(provider, dir, providerSessionId, log))
    const sessionId = `ses-${provider}-pif9-happy`
    const rows: Row[] = []
    try {
      const acquired = await acquireViaRouter(stack, sessionId, provider, rows)
      if (acquired.link.handle.provider !== provider) {
        throw new Error('test requires the acquired provider handle')
      }
      expect(acquired.link.handle.sessionId).toBe(providerSessionId)
      expect(acquired.link.handle.sessionFile.length).toBeGreaterThan(0)
      expect(acquired.process.pid).toBeGreaterThan(0)
      expect(acquired.process.spawnToken).toBe(`spawn-${sessionId}`)

      const outcome = await stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-happy-1',
        body: textBody(provider === 'pi' ? 'TOOL THINK hello happy path' : 'hello happy path'),
        fence: 3
      })
      expect(outcome).toEqual({ state: 'admitted' })
      if (provider === 'pi') {
        // Live deltas stream into the sink and reconcile under stable keys.
        await waitFor(() => assistantTexts(rows).length >= 1, 'assistant streaming rows')
        expect(assistantTexts(rows).at(-1)).toContain('scripted reply for turn')
        const toolKeys = rows
          .filter((row) => row.body.kind === 'tool-call')
          .map((row) => row.identityKey)
        expect(toolKeys.length).toBeGreaterThan(0)
        expect(new Set(toolKeys).size).toBe(1)
      }
      const settled = await waitSettlement(stack.settlements, 'c-happy-1')
      expect(settled).toHaveLength(1)
      expect(settled[0]?.providerIdentity.sessionId).toBe(providerSessionId)
      // Stable provider-native identity, never the client message id.
      const recordId = settled[0]?.providerIdentity.recordId ?? ''
      expect(recordId.length).toBeGreaterThan(0)
      expect(recordId).not.toBe('c-happy-1')
      // OMP emits no live deltas for plain turns; the durable proof is history.
      const history = await stack.backend.readEntries?.({ orcaSessionId: sessionId })
      const historyIds: string[] = []
      for (const entry of history?.entries ?? []) {
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'id' in entry &&
          typeof entry.id === 'string'
        ) {
          historyIds.push(entry.id)
        }
      }
      expect(historyIds).toContain(recordId)
      if (rows.length > 0) {
        assertStableRowKeys(rows)
      }

      const read = await stack.router.readOptions({ sessionId, fence: 3 })
      expect(read.current.model).toContain('script-provider')
      await expect(
        stack.router.setOption({ sessionId, key: 'thinkingLevel', value: 'low', fence: 3 })
      ).resolves.not.toThrow()
      const after = await stack.router.readOptions({ sessionId, fence: 3 })
      expect(after.current.effort).toBe('low')

      // Command discovery uses the provider-specific wire command.
      const commands = stack.router.readCommands?.(sessionId)
      expect(commands?.length).toBeGreaterThan(0)
      const names = (commands ?? []).map((command) => command.name)
      if (provider === 'pi') {
        expect(names).toContain('review')
      } else {
        expect(names).toContain('omp-review')
      }
      const catalogLog = readFileSync(log, 'utf8')
      if (provider === 'pi') {
        expect(catalogLog).toContain('catalog:get_commands')
        expect(catalogLog).not.toContain('catalog:get_available_commands')
      } else {
        expect(catalogLog).toContain('catalog:get_available_commands')
        expect(catalogLog).not.toContain('catalog:get_commands')
      }

      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
      // Proven close is idempotent: a second close reports the same proof.
      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await stack.router.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('cancels only the live turn through the router', async () => {
    const dir = workspace()
    const providerSessionId = `${provider}-pif9-cancel-1`
    const stack = buildStack(dir, sessionEnv(provider, dir, providerSessionId))
    const sessionId = `ses-${provider}-pif9-cancel`
    const rows: Row[] = []
    try {
      await acquireViaRouter(stack, sessionId, provider, rows)
      const outcome = await stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-cancel-1',
        body: textBody('SLOW turn please'),
        fence: 3
      })
      expect(outcome).toEqual({ state: 'admitted' })
      const turnId = stack.backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(turnId).toBeTruthy()
      await expect(
        stack.router.cancelTurn({
          sessionId,
          turnId: turnId ?? '',
          fence: 3,
          resolveLiveTurnId: () => null,
          dispatchStatus: { state: 'pending', recovered: false }
        })
      ).resolves.toEqual({ cancelled: true })
      await waitFor(
        () => (stack.backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null,
        'cancelled turn to clear'
      )
      await expect(
        stack.router.cancelTurn({ sessionId, turnId: turnId ?? '', fence: 3 })
      ).resolves.toEqual({ cancelled: false })
      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await stack.router.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('answers one extension prompt exactly once through the router', async () => {
    const dir = workspace()
    const providerSessionId = `${provider}-pif9-prompt-1`
    const stack = buildStack(dir, sessionEnv(provider, dir, providerSessionId))
    const sessionId = `ses-${provider}-pif9-prompt`
    const rows: Row[] = []
    try {
      await acquireViaRouter(stack, sessionId, provider, rows)
      const pending = stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-prompt-1',
        body: textBody('PROMPT-ME please'),
        fence: 3
      })
      await waitFor(() => promptRows(rows).length >= 1, 'extension prompt row')
      const key = promptRows(rows)[0]?.identityKey ?? ''
      expect(key.length).toBeGreaterThan(0)
      const commit = vi.fn(async () => undefined)
      await stack.router.answerPrompt({
        sessionId,
        itemId: key,
        kind: 'approval',
        optionId: 'confirm',
        fence: 3,
        commit
      })
      expect(commit).toHaveBeenCalledTimes(1)
      await expect(pending).resolves.toEqual({ state: 'admitted' })
      await waitFor(
        () => (stack.backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null,
        'prompted turn to clear'
      )
      // Duplicate answers are refused before commit: no second provider send.
      const retryCommit = vi.fn(async () => undefined)
      await expect(
        stack.router.answerPrompt({
          sessionId,
          itemId: key,
          kind: 'approval',
          optionId: 'confirm',
          fence: 3,
          commit: retryCommit
        })
      ).rejects.toBeInstanceOf(AgentSessionPromptUnavailableError)
      expect(retryCommit).not.toHaveBeenCalled()
      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await stack.router.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe('PIF-9 OMP lifecycle dialect over scripted children', () => {
  it('LOCAL-ONLY prompt_result admits with no phantom agent turn', async () => {
    const dir = workspace()
    const stack = buildStack(dir, sessionEnv('omp', dir, 'omp-pif9-local-1'))
    const sessionId = 'ses-omp-pif9-local'
    const rows: Row[] = []
    try {
      await acquireViaRouter(stack, sessionId, 'omp', rows)
      const outcome = await stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-local-1',
        body: textBody('LOCAL-ONLY task please'),
        fence: 3
      })
      expect(outcome).toEqual({ state: 'admitted' })
      // The fixture sends no agent_end for local-only prompts: history alone
      // settles the admission, so no agent turn is ever awaited.
      const settled = await waitSettlement(stack.settlements, 'c-local-1')
      expect(settled).toHaveLength(1)
      expect(settled[0]?.providerIdentity.sessionId).toBe('omp-pif9-local-1')
      expect(settled[0]?.providerIdentity.recordId).not.toBe('c-local-1')
      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await stack.router.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('a non-terminal agent_end keeps the turn live; the terminal one settles it', async () => {
    const dir = workspace()
    const stack = buildStack(dir, sessionEnv('omp', dir, 'omp-pif9-slow-1'))
    const sessionId = 'ses-omp-pif9-slow'
    const rows: Row[] = []
    try {
      await acquireViaRouter(stack, sessionId, 'omp', rows)
      const outcome = await stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-slow-1',
        body: textBody('SLOW turn please'),
        fence: 3
      })
      expect(outcome).toEqual({ state: 'admitted' })
      // The fixture emits agent_end{isTerminal:false} at ~200ms and settles at
      // ~1500ms; mid-window the turn must still be live.
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(stack.backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null).not.toBe(null)
      const settled = await waitSettlement(stack.settlements, 'c-slow-1')
      expect(settled).toHaveLength(1)
      // Exactly one settlement despite two agent_end frames on the wire.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(
        stack.settlements.filter((entry) => entry.clientMessageId === 'c-slow-1')
      ).toHaveLength(1)
      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await stack.router.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('startup noise and mid-turn extras do not perturb request correlation', async () => {
    const dir = workspace()
    const file = join(dir, 'omp-session.jsonl')
    writeFileSync(file, '')
    const stack = buildStack(dir, {
      OMP_SCRIPT_SESSION_FILE: file,
      OMP_SCRIPT_SESSION_ID: 'omp-pif9-noise-1',
      OMP_SCRIPT_NOISE: '1'
    })
    const sessionId = 'ses-omp-pif9-noise'
    const rows: Row[] = []
    try {
      await acquireViaRouter(stack, sessionId, 'omp', rows)
      const outcome = await stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-noise-1',
        body: textBody('NOISE-TURN hello'),
        fence: 3
      })
      expect(outcome).toEqual({ state: 'admitted' })
      const settled = await waitSettlement(stack.settlements, 'c-noise-1')
      expect(settled).toHaveLength(1)
      // Correlation survives the extras: a follow-up prompt on the same
      // session admits and settles from history as well.
      const followUp = await stack.router.dispatch({
        sessionId,
        clientMessageId: 'c-noise-2',
        body: textBody('hello after noise'),
        fence: 3
      })
      expect(followUp).toEqual({ state: 'admitted' })
      await waitSettlement(stack.settlements, 'c-noise-2')
      await expect(stack.router.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await stack.router.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe('PIF-9 provider file boundaries over scripted children', () => {
  it('keeps pi and omp session files distinct with one child each', async () => {
    const dir = workspace()
    const piFile = join(dir, 'pi-session.jsonl')
    const ompFile = join(dir, 'omp-session.jsonl')
    writeFileSync(piFile, '')
    writeFileSync(ompFile, '')
    const stack = buildStack(dir, {
      PI_SCRIPT_SESSION_FILE: piFile,
      PI_SCRIPT_SESSION_ID: 'pi-pif9-files-1',
      OMP_SCRIPT_SESSION_FILE: ompFile,
      OMP_SCRIPT_SESSION_ID: 'omp-pif9-files-1'
    })
    const piRows: Row[] = []
    const ompRows: Row[] = []
    try {
      const piAcquired = await acquireViaRouter(stack, 'ses-pif9-pi-file', 'pi', piRows)
      const ompAcquired = await acquireViaRouter(stack, 'ses-pif9-omp-file', 'omp', ompRows)
      const piHandle = piAcquired.link.handle
      const ompHandle = ompAcquired.link.handle
      if (piHandle.provider !== 'pi' || ompHandle.provider !== 'omp') {
        throw new Error('test requires pi and omp handles')
      }
      expect(piHandle.sessionFile).toBe(piFile)
      expect(ompHandle.sessionFile).toBe(ompFile)
      expect(piHandle.sessionFile).not.toBe(ompHandle.sessionFile)
      expect(piAcquired.process.pid).not.toBe(ompAcquired.process.pid)
      expect(stack.spawns).toHaveLength(2)
      await expect(stack.router.closeSession('ses-pif9-pi-file')).resolves.toBe(true)
      await expect(stack.router.closeSession('ses-pif9-omp-file')).resolves.toBe(true)
      // Closing proves the exit; it never spawns a replacement child.
      expect(stack.spawns).toHaveLength(2)
    } finally {
      await stack.router.closeSession('ses-pif9-pi-file').catch(() => undefined)
      await stack.router.closeSession('ses-pif9-omp-file').catch(() => undefined)
      rmDir(dir)
    }
  })

  it('refuses to resume a pi session file through omp', async () => {
    const dir = workspace()
    const piFile = join(dir, 'pi-session.jsonl')
    writeFileSync(piFile, '')
    const stack = buildStack(dir, {
      PI_SCRIPT_SESSION_FILE: piFile,
      PI_SCRIPT_SESSION_ID: 'pi-pif9-cross-1'
    })
    const piRows: Row[] = []
    try {
      const piAcquired = await acquireViaRouter(stack, 'ses-pif9-cross-pi', 'pi', piRows)
      const piHandle = piAcquired.link.handle
      if (piHandle.provider !== 'pi') {
        throw new Error('test requires the pi handle')
      }
      await expect(
        stack.router.acquire({
          identity: {
            sessionId: 'ses-pif9-cross-omp',
            workspaceId: 'workspace-1',
            hostId: 'local',
            agent: 'omp',
            providerHandle: {
              kind: 'opaque',
              agent: 'omp',
              value: `omp:${piHandle.sessionId}`
            }
          },
          fence: 3,
          spawnToken: 'spawn-cross-omp',
          resumeSessionFile: piHandle.sessionFile,
          events: capturingSink([])
        })
      ).rejects.toThrow()
      await expect(stack.router.closeSession('ses-pif9-cross-pi')).resolves.toBe(true)
    } finally {
      await stack.router.closeSession('ses-pif9-cross-pi').catch(() => undefined)
      await stack.router.closeSession('ses-pif9-cross-omp').catch(() => undefined)
      rmDir(dir)
    }
  })
})

// PIF-9 scenario map: every hardening scenario in #30 already has a dedicated
// suite; this file adds the production call-graph layer above them.
// - transport framing/correlation/chunk tolerance: rpc/pi-family-rpc-connection
// - acquire/resume/process proof: pi-family-session-acquire
// - dispatch admission + history settlement: pi-family-dispatch-settlement
// - streaming + sink backpressure: pi-family-session-streaming
// - cancel + exactly-once prompts: pi-family-turn-cancellation,
//   pi-family-prompt-answers
// - options/commands/compaction dialect: pi-family-controls
// - restart reconciliation: agent-session-wire/pi-family-restart-settlement
// - structured↔TUI continuity: agent-session-wire/pi-family-tui-handoff
