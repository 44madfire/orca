// Pi-family turn cancellation over scripted children (PIF-6, #27).
//
// Shared guard sequence for BOTH providers through the real adapter ->
// backend -> driver -> transport path: a matching live turn + fence sends
// exactly ONE provider `abort`; a stale fence, a wrong turn, a turn id that
// changes during the guard, and a settled turn all send none and report
// `{ cancelled: false }`; a stale acquisition cannot abort a replacement
// child; an abort rejection or transport failure never claims another turn
// was cancelled. Settlement after abort is observed through the provider's
// own flavor frames (#26), never fabricated. Scripted children only.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createPiRpcBackend } from './pi-rpc-backend'
import { PiStructuredSessionAdapter } from './pi-structured-session-adapter'
import type { PiStructuredBackend } from './pi-structured-backend'
import { PiFamilyRpcConnection } from './rpc/pi-family-rpc-connection'

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
  const dir = mkdtempSync(join(tmpdir(), 'pi-family-cancel-'))
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

function sessionEnv(provider: Provider, dir: string, sessionId: string): Record<string, string> {
  const file = join(dir, `${provider}-session.jsonl`)
  writeFileSync(file, '')
  return provider === 'pi'
    ? { PI_SCRIPT_SESSION_FILE: file, PI_SCRIPT_SESSION_ID: sessionId }
    : { OMP_SCRIPT_SESSION_FILE: file, OMP_SCRIPT_SESSION_ID: sessionId }
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

function capturingSink(): {
  sink: StructuredAgentSessionEventSink
  activity: { current: unknown }
} {
  const activity: { current: unknown } = { current: undefined }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => undefined,
    appendTombstone: () => undefined,
    publish: () => undefined,
    setActivity: (next) => {
      activity.current = next
    }
  }
  return { sink, activity }
}

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (cond()) {
      return
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for scripted Pi-family cancel condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function abortSpy() {
  return vi.spyOn(PiFamilyRpcConnection.prototype, 'abort')
}

describe.each(['pi', 'omp'] as const)('cancel guards over a %s child', (provider) => {
  it('sends exactly ONE abort for a matching live turn, then observes settlement', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-cancel-1`))
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => Date.now()
    })
    const captured = capturingSink()
    const aborts = abortSpy()
    const sessionId = `ses-${provider}-cancel-1`
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 7,
        spawnToken: 's1',
        events: captured.sink
      })
      await adapter.dispatch({
        sessionId,
        clientMessageId: 'c1',
        body: textBody('SLOW turn'),
        fence: 7
      })
      const turnId = backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(turnId).toBeTruthy()
      const settled = await adapter.cancelTurn({
        sessionId,
        turnId: turnId ?? '',
        fence: 7,
        // The journal has not published the turn yet; a null read falls back
        // to the adapter-local live turn rather than refusing Stop.
        resolveLiveTurnId: () => null,
        dispatchStatus: { state: 'pending', recovered: false }
      })
      expect(settled).toEqual({ cancelled: true })
      expect(aborts).toHaveBeenCalledTimes(1)
      // Normal provider settlement clears the turn; a second cancel for the
      // settled turn sends no further abort.
      await waitFor(() => (backend.liveTurnId?.({ orcaSessionId: sessionId }) ?? null) === null)
      await expect(
        adapter.cancelTurn({ sessionId, turnId: turnId ?? '', fence: 7 })
      ).resolves.toEqual({ cancelled: false })
      expect(aborts).toHaveBeenCalledTimes(1)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('sends no abort for a stale fence or a wrong turn', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-cancel-2`))
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => Date.now()
    })
    const captured = capturingSink()
    const aborts = abortSpy()
    const sessionId = `ses-${provider}-cancel-2`
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 7,
        spawnToken: 's1',
        events: captured.sink
      })
      await adapter.dispatch({
        sessionId,
        clientMessageId: 'c1',
        body: textBody('SLOW turn'),
        fence: 7
      })
      const turnId = backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(turnId).toBeTruthy()
      await expect(
        adapter.cancelTurn({ sessionId, turnId: turnId ?? '', fence: 8 })
      ).resolves.toEqual({ cancelled: false })
      await expect(
        adapter.cancelTurn({ sessionId, turnId: 'not-the-live-turn', fence: 7 })
      ).resolves.toEqual({ cancelled: false })
      // The journal naming a different live turn also refuses the request.
      await expect(
        adapter.cancelTurn({
          sessionId,
          turnId: turnId ?? '',
          fence: 7,
          resolveLiveTurnId: () => 'a-newer-turn'
        })
      ).resolves.toEqual({ cancelled: false })
      expect(aborts).not.toHaveBeenCalled()
      // The live turn survived every refused cancel: it still aborts once.
      await expect(
        adapter.cancelTurn({ sessionId, turnId: turnId ?? '', fence: 7 })
      ).resolves.toEqual({ cancelled: true })
      expect(aborts).toHaveBeenCalledTimes(1)
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('a stale acquisition cannot abort a replacement child', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-cancel-3`))
    const makeAdapter = () =>
      new PiStructuredSessionAdapter({
        resolveWorkspacePath: () => dir,
        backend,
        readProcessStartTime: async () => Date.now()
      })
    const adapter = makeAdapter()
    const aborts = abortSpy()
    const sessionId = `ses-${provider}-cancel-3`
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 5,
        spawnToken: 's1',
        events: capturingSink().sink
      })
      await adapter.dispatch({
        sessionId,
        clientMessageId: 'c1',
        body: textBody('SLOW turn'),
        fence: 5
      })
      const staleTurnId = backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(staleTurnId).toBeTruthy()
      // Replacement child under a new fence; the stale backend driver (with
      // its live turn) is proven closed before the new child spawns.
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 6,
        spawnToken: 's2',
        events: capturingSink().sink
      })
      // Stale fence plus stale turn: refused before any provider write.
      await expect(
        adapter.cancelTurn({ sessionId, turnId: staleTurnId ?? '', fence: 5 })
      ).resolves.toEqual({ cancelled: false })
      // Current fence but stale turn: the replacement has no such turn.
      await expect(
        adapter.cancelTurn({ sessionId, turnId: staleTurnId ?? '', fence: 6 })
      ).resolves.toEqual({ cancelled: false })
      expect(aborts).not.toHaveBeenCalled()
      await expect(adapter.closeSession(sessionId)).resolves.toBe(true)
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })

  it('a dead transport sends no abort and claims nothing', async () => {
    const dir = workspace()
    const backend = backendWithScripts(sessionEnv(provider, dir, `${provider}-cancel-4`))
    const adapter = new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => dir,
      backend,
      readProcessStartTime: async () => Date.now()
    })
    const aborts = abortSpy()
    const sessionId = `ses-${provider}-cancel-4`
    try {
      await adapter.acquire({
        identity: freshIdentity(sessionId, provider),
        fence: 5,
        spawnToken: 's1',
        events: capturingSink().sink
      })
      // EXIT kills the child mid-dispatch: the write stays ambiguous (the op
      // remains armed) but the transport is gone, so no abort can be sent.
      await adapter.dispatch({
        sessionId,
        clientMessageId: 'c1',
        body: textBody('EXIT now'),
        fence: 5
      })
      const turnId = backend.liveTurnId?.({ orcaSessionId: sessionId })
      expect(turnId).toBe('pi-turn-1')
      await expect(
        adapter.cancelTurn({ sessionId, turnId: turnId ?? '', fence: 5 })
      ).resolves.toEqual({ cancelled: false })
      expect(aborts).not.toHaveBeenCalled()
    } finally {
      await adapter.closeSession(sessionId).catch(() => undefined)
      rmDir(dir)
    }
  })
})

describe('cancel guard edge cases (transport-independent)', () => {
  function fakeBackend(overrides: Partial<PiStructuredBackend> = {}): PiStructuredBackend {
    return {
      acquire: async () => ({
        piSessionId: 'pi-ses-1',
        leafId: 'leaf-1',
        pid: 4242,
        sessionFilePath: '/tmp/pi-ses-1.jsonl'
      }),
      dispatch: async () => ({ status: 'accepted' }),
      cancel: async () => ({ cancelled: true }),
      close: async () => true,
      ...overrides
    }
  }

  function adapterWith(backend: PiStructuredBackend): PiStructuredSessionAdapter {
    return new PiStructuredSessionAdapter({
      resolveWorkspacePath: () => '/tmp/ws',
      backend,
      readProcessStartTime: async () => 1
    })
  }

  function freshPiIdentity(sessionId: string): AgentSessionJournalIdentity {
    return {
      sessionId,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'pi',
      providerHandle: { kind: 'opaque', agent: 'pi', value: 'pending' }
    }
  }

  it('fails closed without a live-turn seam rather than aborting blind', async () => {
    const cancel = vi.fn(async () => ({ cancelled: true }))
    const adapter = adapterWith(fakeBackend({ cancel }))
    await adapter.acquire({ identity: freshPiIdentity('ses-noseam'), fence: 0, spawnToken: 's1' })
    await expect(
      adapter.cancelTurn({ sessionId: 'ses-noseam', turnId: 't1', fence: 0 })
    ).resolves.toEqual({ cancelled: false })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('sends no abort when the live-turn id changes during the guard', async () => {
    let live: string | null = 'pi-turn-1'
    const aborts: string[] = []
    const backend = fakeBackend({
      liveTurnId: () => {
        // The guard reads the turn, then the turn moves before the send.
        const read = live
        live = 'pi-turn-2'
        return read
      },
      cancel: async (input: { orcaSessionId: string; expectedTurnId?: string }) => {
        // Driver-side send-time check: refuse the stale expectation.
        if (input.expectedTurnId !== live) {
          return { cancelled: false }
        }
        aborts.push(input.expectedTurnId ?? '')
        return { cancelled: true }
      }
    })
    const adapter = adapterWith(backend)
    await adapter.acquire({ identity: freshPiIdentity('ses-moving'), fence: 0, spawnToken: 's1' })
    await expect(
      adapter.cancelTurn({ sessionId: 'ses-moving', turnId: 'pi-turn-1', fence: 0 })
    ).resolves.toEqual({ cancelled: false })
    expect(aborts).toHaveLength(0)
  })

  it('never claims cancellation when the abort is rejected or the transport fails', async () => {
    const rejected = adapterWith(
      fakeBackend({ liveTurnId: () => 'pi-turn-1', cancel: async () => ({ cancelled: false }) })
    )
    await rejected.acquire({ identity: freshPiIdentity('ses-rej'), fence: 0, spawnToken: 's1' })
    await expect(
      rejected.cancelTurn({ sessionId: 'ses-rej', turnId: 'pi-turn-1', fence: 0 })
    ).resolves.toEqual({ cancelled: false })

    const failing = adapterWith(
      fakeBackend({
        liveTurnId: () => 'pi-turn-1',
        cancel: async () => {
          throw new Error('transport lost mid-abort')
        }
      })
    )
    await failing.acquire({ identity: freshPiIdentity('ses-fail'), fence: 0, spawnToken: 's1' })
    await expect(
      failing.cancelTurn({ sessionId: 'ses-fail', turnId: 'pi-turn-1', fence: 0 })
    ).resolves.toEqual({ cancelled: false })
  })
})
