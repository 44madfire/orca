// PIF-8 (#29): `providerHistoryWindow` sampling for Pi and OMP through a fake
// backend. Proves bounded `since` reads, fail-closed cursors, honest boundary
// flags, same-provider ephemeral sampling, and that reconciliation never sends.

import { describe, expect, it } from 'vitest'
import type { AgentSessionAccountHome } from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import {
  PiStructuredSessionAdapter,
  type PiStructuredBackend
} from './pi-structured-session-adapter'

type Provider = 'pi' | 'omp'

function piMessage(id: string, parentId: string | null, role: string, text: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: { role, content: [{ type: 'text', text }] }
  }
}

const HISTORY = [
  piMessage('a', null, 'user', 'alpha'),
  piMessage('b', 'a', 'assistant', 'beta'),
  piMessage('c', 'b', 'user', 'gamma'),
  piMessage('x', 'b', 'user', 'abandoned'),
  piMessage('e', 'c', 'user', 'epsilon')
]

function identity(
  sessionId: string,
  provider: Provider,
  value: string
): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: provider,
    providerHandle: { kind: 'opaque', agent: provider, value }
  }
}

type BackendCalls = {
  acquire: unknown[]
  readEntries: unknown[]
  close: unknown[]
  dispatch: unknown[]
}

function fakeBackend(
  calls: BackendCalls,
  overrides?: Partial<PiStructuredBackend>
): PiStructuredBackend {
  return {
    acquire: async (input: {
      orcaSessionId: string
      provider?: Provider
      resumeSessionFile?: string
    }) => {
      calls.acquire.push({ provider: input.provider, file: input.resumeSessionFile })
      return {
        piSessionId: 'pi-ses-1',
        leafId: 'b',
        pid: 4242,
        sessionFilePath: '/tmp/pi-ses-1.jsonl'
      }
    },
    readEntries: async (input: { orcaSessionId: string; since?: string }) => {
      calls.readEntries.push({ since: input.since ?? null })
      if (input.since !== undefined && input.since !== 'b') {
        throw new Error('Entry not found')
      }
      const entries =
        input.since === undefined
          ? HISTORY
          : HISTORY.filter((entry) => entry.id !== 'a' && entry.id !== 'b')
      return { entries, leafId: 'e' }
    },
    dispatch: async () => {
      calls.dispatch.push({})
      return { status: 'accepted' as const }
    },
    cancel: async () => ({ cancelled: false }),
    close: async () => {
      calls.close.push({})
      return true
    },
    ...overrides
  }
}

function adapterWith(calls: BackendCalls, overrides?: Partial<PiStructuredBackend>) {
  return new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => '/tmp/ws',
    backend: fakeBackend(calls, overrides),
    readProcessStartTime: async () => 1
  })
}

const ACCOUNT_HOME: AgentSessionAccountHome = { variable: 'PI_STATE_DIR', path: '/tmp/pi-state' }

describe('providerHistoryWindow ephemeral sampling', () => {
  it.each(['pi', 'omp'] as const)(
    'samples %s append-history bounded by the anchor and preserves the leaf',
    async (provider) => {
      const calls: BackendCalls = { acquire: [], readEntries: [], close: [], dispatch: [] }
      const file = `/tmp/${provider}-ses-1.jsonl`
      const sessionId = `${provider}-ses-1`
      const backendOverrides =
        provider === 'omp'
          ? {
              acquire: async () => {
                calls.acquire.push({ provider: 'omp', file })
                return { piSessionId: 'omp-ses-1', leafId: 'b', pid: 4242, sessionFilePath: file }
              }
            }
          : {}
      const adapter = adapterWith(calls, backendOverrides)
      const window = await adapter.providerHistoryWindow?.({
        identity: identity('orca-1', provider, `${provider}:${sessionId}`),
        accountHome: ACCOUNT_HOME,
        resumeSessionFile: file,
        durableLeafId: 'b'
      })
      expect(window).not.toBe(null)
      expect(window?.boundaryConsistent).toBe(true)
      expect(window?.turnInFlight).toBe(false)
      // Only the needed append-history was requested; abandoned siblings excluded.
      expect(calls.readEntries).toEqual([{ since: 'b' }])
      expect(window?.items.map((item) => item.providerItemId)).toEqual(['c', 'e'])
      for (const item of window?.items ?? []) {
        expect(item.identity).toMatchObject({ agent: provider, sessionId })
      }
      // Ephemeral child lifecycle: same-provider acquire on the exact file, then proven stop.
      expect(calls.acquire).toHaveLength(1)
      expect(calls.acquire[0]).toMatchObject({ provider, file })
      expect(calls.close).toHaveLength(1)
      // Reconciliation never resends.
      expect(calls.dispatch).toEqual([])
    }
  )

  it('fails closed with an inconsistent boundary on an unknown cursor', async () => {
    const calls: BackendCalls = { acquire: [], readEntries: [], close: [], dispatch: [] }
    const adapter = adapterWith(calls)
    const window = await adapter.providerHistoryWindow?.({
      identity: identity('orca-1', 'pi', 'pi:pi-ses-1'),
      accountHome: ACCOUNT_HOME,
      resumeSessionFile: '/tmp/pi-ses-1.jsonl',
      durableLeafId: 'no-such-entry'
    })
    expect(window).toMatchObject({ items: [], boundaryConsistent: false })
    expect(calls.acquire).toHaveLength(1)
    expect(calls.close).toHaveLength(1)
    expect(calls.dispatch).toEqual([])
  })

  it('returns null without sampling when the locator, backend, or handle is unusable', async () => {
    const calls: BackendCalls = { acquire: [], readEntries: [], close: [], dispatch: [] }
    const adapter = adapterWith(calls)
    // Missing exact file: never infer the path from the session id.
    await expect(
      adapter.providerHistoryWindow?.({
        identity: identity('orca-1', 'pi', 'pi:pi-ses-1'),
        accountHome: ACCOUNT_HOME,
        durableLeafId: 'b'
      })
    ).resolves.toBe(null)
    // Non-Pi-family handle.
    const claude: AgentSessionJournalIdentity = {
      sessionId: 'orca-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: { kind: 'claude', sessionId: 'cl', leafUuid: null }
    }
    await expect(
      adapter.providerHistoryWindow?.({ identity: claude, accountHome: ACCOUNT_HOME })
    ).resolves.toBe(null)
    expect(calls.acquire).toEqual([])
  })

  it('refuses a sample whose resumed session id belongs to another conversation', async () => {
    const calls: BackendCalls = { acquire: [], readEntries: [], close: [], dispatch: [] }
    const adapter = adapterWith(calls, {
      acquire: async () => {
        calls.acquire.push({})
        return {
          piSessionId: 'pi-other',
          leafId: 'b',
          pid: 1,
          sessionFilePath: '/tmp/pi-ses-1.jsonl'
        }
      }
    })
    await expect(
      adapter.providerHistoryWindow?.({
        identity: identity('orca-1', 'pi', 'pi:pi-ses-1'),
        accountHome: ACCOUNT_HOME,
        resumeSessionFile: '/tmp/pi-ses-1.jsonl',
        durableLeafId: 'b'
      })
    ).resolves.toBe(null)
    expect(calls.readEntries).toEqual([])
    expect(calls.close).toHaveLength(1)
  })

  it('refuses when the journal agent disagrees with the durable provider kind', async () => {
    const calls: BackendCalls = { acquire: [], readEntries: [], close: [], dispatch: [] }
    const adapter = adapterWith(calls)
    const mixed: AgentSessionJournalIdentity = {
      sessionId: 'orca-1',
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'omp',
      providerHandle: { kind: 'opaque', agent: 'omp', value: 'pi:pi-ses-1' }
    }
    await expect(
      adapter.providerHistoryWindow?.({
        identity: mixed,
        accountHome: ACCOUNT_HOME,
        resumeSessionFile: '/tmp/pi-ses-1.jsonl',
        durableLeafId: 'b'
      })
    ).resolves.toBe(null)
    expect(calls.acquire).toEqual([])
  })
})

describe('providerHistoryWindow live read', () => {
  it('reads through the live child without spawning and reports the turn in flight', async () => {
    const calls: BackendCalls = { acquire: [], readEntries: [], close: [], dispatch: [] }
    const adapter = adapterWith(calls)
    await adapter.acquire({
      identity: identity('orca-live', 'pi', 'pending'),
      fence: 0,
      spawnToken: 'spawn-1'
    })
    const acquires = calls.acquire.length
    const window = await adapter.providerHistoryWindow?.({
      identity: identity('orca-live', 'pi', 'pi:pi-ses-1'),
      accountHome: ACCOUNT_HOME,
      resumeSessionFile: '/tmp/pi-ses-1.jsonl'
    })
    // No second spawn: the live child served the read; absence proves nothing while it runs.
    expect(calls.acquire).toHaveLength(acquires)
    expect(window?.turnInFlight).toBe(true)
    expect(window?.boundaryConsistent).toBe(true)
    expect(window?.items.map((item) => item.providerItemId)).toEqual(['c', 'e'])
    expect(calls.dispatch).toEqual([])
  })
})
