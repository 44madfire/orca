import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { AgentSessionForkRecord } from '../../../shared/agent-session-fork'
import { isAgentSessionRecord } from '../../../shared/agent-session-record'
import {
  beginStructuredForkAttempt,
  proveStructuredForkAcquisition,
  publishStructuredForkJournal
} from './structured-agent-session-fork-lifecycle'

const NOW = 1_800_000_000_000
const roots: string[] = []
const journals: AgentSessionJournal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) {
    await journal.close()
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function prepare(provider: 'codex' | 'claude' = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'orca-fork-lifecycle-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
  const source =
    provider === 'codex'
      ? ({ provider, threadId: 'parent' } as const)
      : ({ provider, sessionId: 'parent', leafUuid: 'leaf' } as const)
  const fork: AgentSessionForkRecord = {
    sourceSessionId: 'parent-session',
    operationId: `${NOW}-00000000000000000000000000000001`,
    callerKey: 'client',
    itemId: provider === 'codex' ? 'codex:parent:turn:0' : 'claude:parent:leaf',
    expectedEpoch: 'parent-epoch',
    expectedRuntimeFence: 99,
    source,
    throughId: provider === 'codex' ? 'turn' : 'leaf',
    phase: 'prepared',
    retained: [
      {
        itemId: provider === 'codex' ? 'codex:parent:turn:0' : 'claude:parent:leaf',
        body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Kept' }] },
        observedAt: NOW
      }
    ]
  }
  const { record } = await store.reserveOwner({
    sessionId: 'child-session',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace',
      workspaceKind: 'folder'
    },
    provider,
    accountHome: {
      variable: provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
      path: root
    },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'child-token',
    claimKeyId: 'key',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'fingerprint'
    },
    now: NOW,
    fork
  })
  return { root, store, record, fork }
}

describe('durable fork lifecycle', () => {
  it('consumes fork permission before provider execution and refuses an unknown retry', async () => {
    const { root, store, record } = await prepare()
    expect(await beginStructuredForkAttempt(store, record)).toMatchObject({ throughId: 'turn' })
    const reopened = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
    await expect(
      beginStructuredForkAttempt(reopened, reopened.getRecord(record.sessionId)!)
    ).rejects.toThrow('agent_session_operation_unknown')
    expect(record.lease.runtimeFence).toBe(1)
    expect(record.schemaVersion).toBe(3)
    expect(record.providerHandleChain).toEqual([])
    expect(reopened.getRecord(record.sessionId)?.providerHandleChain).toEqual([])
    expect(isAgentSessionRecord(record)).toBe(true)
  })

  it.each(['codex', 'claude'] as const)(
    'proves %s fork and seeds a separate journal without repeating the provider',
    async (provider) => {
      const { root, store, record } = await prepare(provider)
      await beginStructuredForkAttempt(store, record)
      const handle =
        provider === 'codex'
          ? ({ provider, threadId: 'child' } as const)
          : ({ provider, sessionId: 'child', leafUuid: 'leaf' } as const)
      const link = proveStructuredForkAcquisition(record, {
        linkId: 'fork-link',
        handle,
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      })
      expect(record.providerHandleChain).toEqual([])
      expect(link).toMatchObject({ origin: 'forked' })
      await store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence: 1,
        process: { hostId: 'local', pid: 123, processStartTimeMs: NOW, spawnToken: 'child-token' },
        now: NOW
      })
      const proved = await store.proveOwner({
        sessionId: record.sessionId,
        fence: 1,
        link,
        now: NOW
      })
      expect(proved.fork?.phase).toBe('provider-succeeded')
      expect(await beginStructuredForkAttempt(store, proved)).toBeUndefined()
      const journal = new AgentSessionJournal({
        journalDir: join(root, 'journal'),
        identity: {
          sessionId: record.sessionId,
          workspaceId: 'workspace',
          hostId: 'local',
          agent: provider,
          providerHandle:
            provider === 'codex'
              ? { kind: provider, threadId: 'child' }
              : { kind: provider, sessionId: 'child', leafUuid: 'leaf' }
        }
      })
      journals.push(journal)
      await journal.open()
      await publishStructuredForkJournal(store, proved, journal)
      expect(journal.snapshot().items.map((item) => item.itemId)).toEqual([
        provider === 'codex' ? 'codex:child:turn:0' : 'claude:parent:leaf'
      ])
      expect(journal.submissions()).toEqual([])
      expect(store.getRecord(record.sessionId)).toMatchObject({
        schemaVersion: 2,
        fork: { phase: 'completed', retained: [] }
      })
      const epoch = journal.cursor().epoch
      await publishStructuredForkJournal(store, store.getRecord(record.sessionId)!, journal)
      expect(journal.cursor().epoch).toBe(epoch)
    }
  )

  it('uses the existing chain validator to reject unchanged roots', async () => {
    const { record } = await prepare()
    expect(() =>
      proveStructuredForkAcquisition(record, {
        linkId: 'bad',
        handle: { provider: 'codex', threadId: 'parent' },
        origin: 'created',
        mintedAtFence: 1,
        observedAt: NOW
      })
    ).toThrow('agent_session_provider_handle_invalid')
  })
})
