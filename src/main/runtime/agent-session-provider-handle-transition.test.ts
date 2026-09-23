import { describe, expect, it } from 'vitest'
import { isAgentSessionRecord } from '../../shared/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import { recordAgentSessionProviderHandle } from './agent-session-provider-handle-transition'

function resumedLink(fence: number): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-2',
    handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: 'leaf-2' },
    origin: 'resumed',
    mintedAtFence: fence,
    observedAt: 4_000
  }
}

describe('recordAgentSessionProviderHandle', () => {
  it('advances a live Claude chain head and its proof', () => {
    const record = agentSessionRecordFixture()
    const next = recordAgentSessionProviderHandle({
      record,
      fence: record.lease.runtimeFence,
      link: resumedLink(record.lease.runtimeFence),
      now: 4_000
    })
    expect(next.providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'leaf-2' })
    expect(next.lease.provenHandleLinkId).toBe('link-2')
  })

  it('records a leaf during proof without granting ownership', () => {
    const lease = agentSessionLeaseFixture({
      runtimeFence: 8,
      claimStatus: 'reserved',
      handoffStage: 'new-owner-proving',
      provenHandleLinkId: null
    })
    const next = recordAgentSessionProviderHandle({
      record: agentSessionRecordFixture(lease),
      fence: lease.runtimeFence,
      link: resumedLink(lease.runtimeFence),
      now: 4_000
    })
    expect(next.providerHandleChain.at(-1)?.handle).toMatchObject({ leafUuid: 'leaf-2' })
    expect(next.lease).toMatchObject({ claimStatus: 'reserved', provenHandleLinkId: null })
  })
})

describe('recordAgentSessionProviderHandle (Pi-family)', () => {
  const PI_FILE = '/tmp/pi-ses-1.jsonl'
  const OMP_FILE = '/tmp/omp-ses-1.jsonl'

  function livePiFamilyRecord(head: AgentSessionProviderHandleLink) {
    const lease = agentSessionLeaseFixture({
      runtimeFence: head.mintedAtFence,
      claimStatus: 'live',
      provenHandleLinkId: head.linkId,
      ownerProcess: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: 1_700_000_000_000,
        spawnToken: 'spawn-tui'
      }
    })
    const record = agentSessionRecordFixture(lease)
    return {
      ...record,
      provider: head.handle.provider,
      providerHandleChain: [head],
      accountHome: { variable: 'PI_STATE_DIR', path: '/tmp/pi-state' } as const
    }
  }

  function createdPiFamilyLink(
    handle: AgentSessionProviderHandleLink['handle']
  ): AgentSessionProviderHandleLink {
    return { linkId: 'pi-1', handle, origin: 'created', mintedAtFence: 8, observedAt: 1_000 }
  }

  function resumedPiFamilyLink(
    handle: AgentSessionProviderHandleLink['handle']
  ): AgentSessionProviderHandleLink {
    return { linkId: 'pi-2', handle, origin: 'resumed', mintedAtFence: 8, observedAt: 4_000 }
  }

  it('advances a live pi chain head keeping the exact session file', () => {
    const record = livePiFamilyRecord(
      createdPiFamilyLink({
        provider: 'pi',
        sessionId: 'pi-ses-1',
        leafId: 'leaf-1',
        sessionFile: PI_FILE
      })
    )
    const next = recordAgentSessionProviderHandle({
      record,
      fence: record.lease.runtimeFence,
      link: resumedPiFamilyLink({
        provider: 'pi',
        sessionId: 'pi-ses-1',
        leafId: 'leaf-2',
        sessionFile: PI_FILE
      }),
      now: 4_000
    })
    expect(next.providerHandleChain.at(-1)?.handle).toEqual({
      provider: 'pi',
      sessionId: 'pi-ses-1',
      leafId: 'leaf-2',
      sessionFile: PI_FILE
    })
    expect(next.lease.provenHandleLinkId).toBe('pi-2')
  })

  it('advances a live omp chain head keeping the exact session file', () => {
    const record = livePiFamilyRecord(
      createdPiFamilyLink({
        provider: 'omp',
        sessionId: 'omp-ses-1',
        leafId: 'leaf-1',
        sessionFile: OMP_FILE
      })
    )
    const next = recordAgentSessionProviderHandle({
      record,
      fence: record.lease.runtimeFence,
      link: resumedPiFamilyLink({
        provider: 'omp',
        sessionId: 'omp-ses-1',
        leafId: 'leaf-2',
        sessionFile: OMP_FILE
      }),
      now: 4_000
    })
    expect(next.providerHandleChain.at(-1)?.handle).toEqual({
      provider: 'omp',
      sessionId: 'omp-ses-1',
      leafId: 'leaf-2',
      sessionFile: OMP_FILE
    })
    expect(next.lease.provenHandleLinkId).toBe('pi-2')
  })

  it('rejects a Pi link proved against an OMP record, and vice versa', () => {
    const record = livePiFamilyRecord(
      createdPiFamilyLink({
        provider: 'omp',
        sessionId: 'omp-ses-1',
        leafId: 'leaf-1',
        sessionFile: OMP_FILE
      })
    )
    expect(() =>
      recordAgentSessionProviderHandle({
        record,
        fence: record.lease.runtimeFence,
        link: resumedPiFamilyLink({
          provider: 'pi',
          sessionId: 'omp-ses-1',
          leafId: 'leaf-1',
          sessionFile: PI_FILE
        }),
        now: 4_000
      })
    ).toThrow('agent_session_provider_handle_invalid')
  })

  it('persists an omp record with its exact session file across JSON', () => {
    const record = livePiFamilyRecord(
      createdPiFamilyLink({
        provider: 'omp',
        sessionId: 'omp-ses-1',
        leafId: 'leaf-1',
        sessionFile: OMP_FILE
      })
    )
    const reloaded = JSON.parse(JSON.stringify(record))
    expect(isAgentSessionRecord(reloaded)).toBe(true)
  })

  it('refuses a persisted Pi-family chain that lost its session file', () => {
    const record = livePiFamilyRecord(
      createdPiFamilyLink({
        provider: 'pi',
        sessionId: 'pi-ses-1',
        leafId: 'leaf-1',
        sessionFile: PI_FILE
      })
    )
    const fileless = {
      ...record,
      providerHandleChain: [
        {
          linkId: 'pi-1',
          handle: { provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-1' },
          origin: 'created',
          mintedAtFence: 8,
          observedAt: 1_000
        }
      ]
    }
    expect(isAgentSessionRecord(JSON.parse(JSON.stringify(fileless)))).toBe(false)
  })
})
