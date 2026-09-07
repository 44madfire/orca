import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adapterFor,
  fakeClaude,
  identityFor
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { evictHeldStructuredAgentSession } from './structured-agent-session-host-lifetime'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'

const NOW = 1_788_727_031_330
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function capturedSession(verdict: {
  root: 'exited' | 'live'
  tree: 'unverifiable' | 'live'
}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-expired-claude-'))
  roots.push(root)
  const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
  const claude = fakeClaude({ unprovenCloseVerdict: verdict })
  const adapter = adapterFor(claude)
  const reservation = await store.reserveOwner({
    sessionId: 'session-1',
    location: {
      executionHostId: 'local',
      workspaceId: 'folder-1',
      workspaceKind: 'folder',
      wslDistro: null
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-1',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'create'
    },
    now: NOW
  })
  const fence = reservation.record.lease.runtimeFence
  const acquisition = await adapter.acquire({
    identity: { ...identityFor(), hostId: 'local', workspaceId: 'folder-1' },
    fence,
    spawnToken: 'spawn-1'
  })
  await store.commitProcessIdentity({
    sessionId: 'session-1',
    fence,
    process: acquisition.process,
    now: NOW
  })
  await store.proveOwner({ sessionId: 'session-1', fence, link: acquisition.link, now: NOW })
  const close = vi.fn(async () => undefined)
  const sessions = new Map<string, StructuredAgentSessionHostSession>([
    [
      'session-1',
      {
        journal: { close } as unknown as StructuredAgentSessionHostSession['journal'],
        params: {} as StructuredAgentSessionHostSession['params'],
        fence,
        hasProviderChild: true,
        acquisitionGeneration: acquisition.acquisitionGeneration ?? null
      }
    ]
  ])
  const deps = { store, adapter, journalRoot: root, claimKeyId: 'key-1' }
  const runtimeState = new StructuredAgentSessionHostRuntimeState(deps)
  const now = () => NOW + 30 * 60_000
  return {
    store,
    adapter,
    claude,
    close,
    sessions,
    context: { deps, runtimeState, sessions, now },
    now
  }
}

describe('expired native Claude lease and close', () => {
  it('closes the captured live claim after root exit even without a descendant snapshot', async () => {
    const fixture = await capturedSession({ root: 'exited', tree: 'unverifiable' })
    expect(fixture.store.getRecord('session-1')?.lease).toMatchObject({
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null,
      processlessAt: null,
      leaseDeadlineAt: NOW + 30_000
    })
    fixture.claude.connections[0].handlers.onExit?.(new Error('provider exited'))
    await expect(
      evictHeldStructuredAgentSession(fixture.context, 'session-1')
    ).resolves.toBeUndefined()
    expect(fixture.store.getRecord('session-1')?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
    expect(fixture.sessions.size).toBe(0)
    expect(fixture.close).toHaveBeenCalledOnce()
    // Cleanup retains its uncertainty instead of claiming that descendants were stopped.
    await expect(fixture.adapter.closeSession('session-1')).rejects.toThrow('provider exited')
  })

  it.each([
    { root: 'live', tree: 'unverifiable' },
    { root: 'exited', tree: 'live' }
  ] as const)('retains the surface when the process verdict is $root / $tree', async (verdict) => {
    const fixture = await capturedSession(verdict)
    if (verdict.root === 'exited') {
      fixture.claude.connections[0].handlers.onExit?.(new Error('descendant remains'))
    }
    await expect(
      evictHeldStructuredAgentSession(fixture.context, 'session-1')
    ).rejects.toMatchObject({ step: 'stop-provider-child' })
    expect(fixture.store.getRecord('session-1')?.lease.claimStatus).toBe('live')
    expect(fixture.sessions.size).toBe(1)
    expect(fixture.close).not.toHaveBeenCalled()
  })

  it('reclaims a proven-dead native owner before its lease deadline', async () => {
    const fixture = await capturedSession({ root: 'exited', tree: 'unverifiable' })
    const beforeDeadline = NOW + 1_000
    expect(fixture.store.getRecord('session-1')!.lease.leaseDeadlineAt).toBeGreaterThan(
      beforeDeadline
    )
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: fixture.store,
      probe: async () => ({ outcome: 'pid-absent' }) as AgentSessionOwnerProbe,
      now: () => beforeDeadline
    })
    await renewer.renewNow()
    expect(fixture.store.getRecord('session-1')?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'pid-absent' }
    })
  })

  it.each(['pid-absent', 'indeterminate', 'identity-matched'] as const)(
    'periodically reconciles an expired lease using %s host evidence',
    async (outcome) => {
      const fixture = await capturedSession({ root: 'exited', tree: 'unverifiable' })
      const probe: AgentSessionOwnerProbe =
        outcome === 'identity-matched'
          ? { outcome, matchedOn: ['process-start-time'] }
          : outcome === 'indeterminate'
            ? { outcome, reason: 'host unavailable' }
            : { outcome }
      const renewer = new StructuredAgentSessionLeaseRenewer({
        store: fixture.store,
        probe: async () => probe,
        now: fixture.now
      })
      await renewer.renewNow()
      expect(fixture.store.getRecord('session-1')?.lease.claimStatus).toBe(
        outcome === 'pid-absent' ? 'released' : 'live'
      )
      if (outcome === 'pid-absent') {
        expect(fixture.store.getRecord('session-1')?.lease).toMatchObject({
          ownerProcess: null,
          deathEvidence: { kind: 'pid-absent' }
        })
        fixture.claude.connections[0].handlers.onExit?.(new Error('provider exited'))
        await expect(
          evictHeldStructuredAgentSession(fixture.context, 'session-1')
        ).resolves.toBeUndefined()
        expect(fixture.sessions.size).toBe(0)
      }
    }
  )
})
