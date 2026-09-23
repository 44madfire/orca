import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from './structured-agent-session-attach'
import { performAttach } from './structured-agent-session-attach-flow'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const OPERATION = `${NOW}-${'1'.padStart(32, '0')}`
const NEXT_OPERATION = `${NOW}-${'2'.padStart(32, '0')}`
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

function attachParams(
  operationId = OPERATION,
  expectedRuntimeFence: number | null = null
): AgentSessionAttachParams {
  const params: AgentSessionAttachParams = {
    envelope: {
      sessionId: SESSION,
      clientOperationId: operationId,
      expectedRuntimeFence,
      payloadFingerprint: ''
    },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    agent: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }
  return {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.attach',
        sessionId: SESSION,
        fields: attachFingerprintFields(params)
      })
    }
  }
}

describe('processless structured session reservation', () => {
  it('refuses an adapter that declares no create support before reserving a lease', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-unsupported-attach-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const reserveOwner = vi.spyOn(store, 'reserveOwner')
    const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>()
    const adapter = {
      supportsCreate: vi.fn(() => false),
      acquire,
      dispatch: vi.fn(),
      cancelTurn: vi.fn(),
      answerPrompt: vi.fn(),
      setOption: vi.fn()
    } as unknown as StructuredAgentSessionAdapter

    await expect(
      performAttach({
        store,
        adapter,
        journalRoot: root,
        authority: {
          spawnToken: 'spawn-a',
          claimKeyId: 'key-1',
          handoffOperationId: OPERATION,
          probe: { outcome: 'reservation-unused' }
        },
        callerKey: 'client-1',
        params: attachParams(),
        now: () => NOW,
        onAttached: () => {}
      })
    ).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })
    expect(reserveOwner).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
  })

  it('refuses a replay when adapter support drifts after durable reservation', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-replay-support-drift-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const supportsCreate = vi
      .fn<NonNullable<StructuredAgentSessionAdapter['supportsCreate']>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const adapter = {
      supportsCreate,
      acquire: vi.fn(async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'link-1',
          handle: { provider: 'codex' as const, threadId: 'thread-1' },
          origin: 'created' as const,
          mintedAtFence: fence,
          observedAt: NOW
        }
      }))
    } as unknown as StructuredAgentSessionAdapter
    const input = {
      store,
      adapter,
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-a',
        claimKeyId: 'key-1',
        handoffOperationId: OPERATION,
        probe: { outcome: 'reservation-unused' as const }
      },
      callerKey: 'client-1',
      params: attachParams(),
      now: () => NOW,
      onAttached: () => {}
    }

    await expect(performAttach(input)).resolves.toMatchObject({ ok: true })
    await expect(performAttach(input)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })
    expect(supportsCreate).toHaveBeenCalledTimes(3)
    expect(adapter.acquire).toHaveBeenCalledOnce()
  })

  it('releases a new reservation when support drifts before acquisition', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-support-drift-reservation-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const supportsCreate = vi
      .fn<NonNullable<StructuredAgentSessionAdapter['supportsCreate']>>()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
    const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>()
    const adapter = { supportsCreate, acquire } as unknown as StructuredAgentSessionAdapter
    const input = {
      store,
      adapter,
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-drift',
        claimKeyId: 'key-1',
        handoffOperationId: OPERATION,
        probe: { outcome: 'reservation-unused' as const }
      },
      callerKey: 'client-1',
      params: attachParams(),
      now: () => NOW,
      onAttached: () => {}
    }

    await expect(performAttach(input)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })

    expect(acquire).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      reservedSpawnToken: null,
      processlessAt: null,
      runtimeFence: 2,
      deathEvidence: { kind: 'pid-absent', detail: 'reservation failed before spawn' }
    })
    expect(store.listOperationRows()[0]?.outcome).toMatchObject({
      status: 'failed',
      code: 'structured_agent_session_unsupported'
    })
    await expect(performAttach(input)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })
    expect(acquire).not.toHaveBeenCalled()
  })

  it('settles a pre-spawn failure and its processless evidence in one durable transaction', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-processless-reservation-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    const adapter = {
      acquire: vi.fn(async () => {
        throw new AgentSessionPreSpawnError(new Error('workspace no longer exists'))
      })
    } as unknown as StructuredAgentSessionAdapter
    const processlessProof = vi.spyOn(store, 'setReservationProcesslessProof')
    const settlement = vi.spyOn(store, 'settleFailedAcquisition')

    await expect(
      performAttach({
        store,
        adapter,
        journalRoot: root,
        authority: {
          spawnToken: 'spawn-a',
          claimKeyId: 'key-1',
          handoffOperationId: OPERATION,
          probe: { outcome: 'reservation-unused' }
        },
        callerKey: 'client-1',
        params: attachParams(),
        now: () => NOW,
        onAttached: () => {}
      })
    ).rejects.toThrow('workspace no longer exists')
    expect(settlement).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ exitProof: 'processless', spawnToken: 'spawn-a' })
    )
    // No separate durable proof write: the only proof call is acquisition's single-use clear.
    expect(processlessProof).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ processlessAt: null })
    )
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      handoffStage: null,
      handoffOperationId: null,
      runtimeFence: 2,
      processlessAt: null,
      reservedSpawnToken: null,
      deathEvidence: { kind: 'pid-absent', detail: 'reservation failed before spawn' }
    })
    expect(store.listOperationRows()[0]?.outcome).toMatchObject({ status: 'failed' })

    const reopened = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'indeterminate', reason: 'no owner to probe' }),
      now: NOW + 1
    })
    expect(reopened.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      runtimeFence: 2,
      reservedSpawnToken: null
    })
  })

  it('does not rerun a settled pre-spawn failure and admits a fresh operation', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-processless-retry-'))
    const storeDir = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDir, hostId: 'local' })
    const adapter = {
      acquire: vi
        .fn<StructuredAgentSessionAdapter['acquire']>()
        .mockRejectedValueOnce(new AgentSessionPreSpawnError(new Error('launch not ready')))
        .mockImplementationOnce(async ({ fence, spawnToken }) => ({
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: NOW,
            spawnToken
          },
          link: {
            linkId: 'link-1',
            handle: { provider: 'codex', threadId: 'thread-1' },
            origin: 'created',
            mintedAtFence: fence,
            observedAt: NOW
          }
        })),
      releaseAcquisition: vi.fn(async () => true)
    } as unknown as StructuredAgentSessionAdapter
    const input = {
      store,
      adapter,
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-a',
        claimKeyId: 'key-1',
        handoffOperationId: OPERATION,
        probe: { outcome: 'reservation-unused' as const }
      },
      callerKey: 'client-1',
      params: attachParams(),
      now: () => NOW,
      onAttached: () => {}
    }

    await expect(performAttach(input)).rejects.toThrow('launch not ready')
    await expect(performAttach(input)).resolves.toMatchObject({
      ok: false,
      refusal: { code: 'agent_session_operation_invalid' }
    })
    expect(adapter.acquire).toHaveBeenCalledOnce()

    await expect(
      performAttach({
        ...input,
        authority: {
          ...input.authority,
          spawnToken: 'spawn-b',
          handoffOperationId: NEXT_OPERATION
        },
        params: attachParams(NEXT_OPERATION, 2)
      })
    ).resolves.toMatchObject({ ok: true })
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 3,
      ownerProcess: { spawnToken: 'spawn-b' }
    })
  })
})

describe('pi-family provider attach (omp is creatable through the shared adapter since PIF-3)', () => {
  function ompParams(
    overrides: Partial<AgentSessionAttachParams> = {}
  ): AgentSessionAttachParams {
    const params: AgentSessionAttachParams = {
      envelope: {
        sessionId: SESSION,
        clientOperationId: OPERATION,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'omp',
      agent: 'omp',
      accountHome: { variable: 'PI_STATE_DIR', path: '/tmp/omp-state' },
      runtimeKind: 'native',
      ...overrides
    }
    return {
      ...params,
      envelope: {
        ...params.envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.attach',
          sessionId: SESSION,
          fields: attachFingerprintFields(params)
        })
      }
    }
  }

  // The stub adapter claims omp support on purpose: a matching attach must pass
  // the creatability gate into reservation and acquisition, while a mismatched
  // pair still refuses before any reservation exists and before any child spawns.
  function claimingAdapter(
    acquire: StructuredAgentSessionAdapter['acquire']
  ): StructuredAgentSessionAdapter {
    return {
      supportsCreate: () => true,
      acquire,
      releaseAcquisition: async () => true,
      dispatch: async () => ({ state: 'unknown', reason: 'unreachable' }),
      cancelTurn: async () => ({ cancelled: false }),
      answerPrompt: async () => undefined,
      setOption: async () => undefined
    }
  }

  async function attachOmp(params: AgentSessionAttachParams) {
    root = await mkdtemp(join(tmpdir(), 'orca-omp-attach-'))
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const reserveOwner = vi.spyOn(store, 'reserveOwner')
    const acquire = vi.fn<StructuredAgentSessionAdapter['acquire']>().mockImplementation(
      async ({ fence, spawnToken }) => ({
        process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW, spawnToken },
        link: {
          linkId: 'link-omp-1',
          handle: {
            provider: 'omp',
            sessionId: 'omp-ses-1',
            leafId: null,
            sessionFile: '/tmp/omp-ses-1.jsonl'
          },
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      })
    )
    const journals: { close: () => Promise<void> }[] = []
    const result = await performAttach({
      store,
      adapter: claimingAdapter(acquire),
      journalRoot: root,
      authority: {
        spawnToken: 'spawn-a',
        claimKeyId: 'key-1',
        handoffOperationId: OPERATION,
        probe: { outcome: 'reservation-unused' }
      },
      callerKey: 'client-1',
      params,
      now: () => NOW,
      onAttached: (attached) => {
        journals.push(attached.journal)
      }
    })
    // Test-only cleanup: the host owns journal lifetime in production, but an
    // open journal holds its sqlite lock and breaks temp-dir removal on Windows.
    for (const journal of journals) {
      await journal.close().catch(() => undefined)
    }
    return { result, reserveOwner, acquire, store }
  }

  it('admits a matching omp attach through reservation into acquisition', async () => {
    const { result, reserveOwner, acquire } = await attachOmp(ompParams())
    expect(reserveOwner).toHaveBeenCalled()
    expect(acquire).toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true })
  })

  it('refuses a mismatched pi-provider/omp-agent attach before spawning', async () => {
    // Both discriminants are creatable, but the pair disagrees: the lease,
    // router, and handle chain key on one discriminant, so the incoherent
    // pair refuses pre-spawn exactly like an uncreatable provider.
    const { result, reserveOwner, acquire, store } = await attachOmp(
      ompParams({ provider: 'pi' })
    )
    expect(result).toMatchObject({
      ok: false,
      refusal: { code: 'structured_agent_session_unsupported' }
    })
    expect(reserveOwner).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)).toBeNull()
  })
})
