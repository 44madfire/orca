import { describe, expect, it, vi } from 'vitest'
import { agentSessionLeaseFixture } from '../../shared/agent-session-record.test-fixture'
import {
  findConflictingStructuredAdoption,
  resolveStructuredAgentSessionAdoption,
  structuredAdoptionConflictError,
  type StructuredAgentSessionAdoptionOwnership
} from './structured-agent-session-history-adoption'

function ownership(
  overrides: Partial<StructuredAgentSessionAdoptionOwnership> = {}
): StructuredAgentSessionAdoptionOwnership {
  return {
    sessionId: 'codex_owner',
    provider: 'codex',
    providerSessionId: 'thread-1',
    lease: agentSessionLeaseFixture(),
    ...overrides
  }
}

describe('findConflictingStructuredAdoption', () => {
  it('names the session that already holds the conversation', () => {
    const owner = ownership()

    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: 'thread-1',
        selfSessionId: 'codex_new',
        ownership: [ownership({ sessionId: 'other', providerSessionId: 'thread-2' }), owner]
      })
    ).toBe(owner)
  })

  it('exempts the requesting session, so a committed create replays instead of refusing', () => {
    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: 'thread-1',
        selfSessionId: 'codex_new',
        ownership: [ownership({ sessionId: 'codex_new' })]
      })
    ).toBeNull()
  })

  it('ignores an identical id held under the other provider', () => {
    expect(
      findConflictingStructuredAdoption({
        agent: 'claude',
        providerSessionId: 'thread-1',
        selfSessionId: 'claude_new',
        ownership: [ownership({ provider: 'codex' })]
      })
    ).toBeNull()
  })

  it('finds nothing when no session holds the conversation', () => {
    expect(
      findConflictingStructuredAdoption({
        agent: 'codex',
        providerSessionId: 'thread-unheld',
        selfSessionId: 'codex_new',
        ownership: [ownership()]
      })
    ).toBeNull()
  })
})

describe('structuredAdoptionConflictError', () => {
  it('calls a conversation with an admitted writer a conflict', () => {
    expect(structuredAdoptionConflictError(ownership()).message).toBe('agent_session_conflict')
  })

  it.each([
    ['a reservation with no process yet', { ownerProcess: null, claimStatus: 'reserved' as const }],
    ['a lease mid-handoff', { handoffStage: 'new-owner-proving' as const }],
    ['an unreconciled lease', { unreconciled: true }]
  ])('calls %s an unknown owner rather than a conflict', (_label, leaseOverrides) => {
    // Neither verdict admits a second writer; they differ only in what the user is told.
    expect(
      structuredAdoptionConflictError(
        ownership({ lease: agentSessionLeaseFixture(leaseOverrides) })
      ).message
    ).toBe('agent_session_ownership_unknown')
  })
})

describe('resolveStructuredAgentSessionAdoption', () => {
  it('takes the first candidate home that holds the transcript and probes no further', async () => {
    const resolveTranscript = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('/home/dev/.codex/sessions/thread-1.jsonl')

    await expect(
      resolveStructuredAgentSessionAdoption({
        agent: 'codex',
        providerSessionId: 'thread-1',
        candidateAccountHomes: ['/home/dev/.orca-codex', '/home/dev/.codex', '/never/probed'],
        resolveTranscript
      })
    ).resolves.toEqual({
      accountHomePath: '/home/dev/.codex',
      transcriptPath: '/home/dev/.codex/sessions/thread-1.jsonl'
    })
    expect(resolveTranscript).toHaveBeenCalledTimes(2)
  })

  it('skips blank and repeated candidates instead of probing them again', async () => {
    const resolveTranscript = vi.fn().mockResolvedValue(null)

    await expect(
      resolveStructuredAgentSessionAdoption({
        agent: 'claude',
        providerSessionId: 'session-1',
        candidateAccountHomes: ['', '   ', '/home/dev/.claude', ' /home/dev/.claude ', ''],
        resolveTranscript
      })
    ).rejects.toThrow('agent_session_identity_required')
    expect(resolveTranscript.mock.calls.map(([args]) => args.accountHomePath)).toEqual([
      '/home/dev/.claude'
    ])
  })

  it('refuses rather than falling back to a home that does not hold the conversation', async () => {
    // A resume under the wrong home lands in a blank chat wearing the old chat's name.
    await expect(
      resolveStructuredAgentSessionAdoption({
        agent: 'claude',
        providerSessionId: 'session-1',
        candidateAccountHomes: ['/home/dev/.claude-work', '/home/dev/.claude'],
        resolveTranscript: async () => null
      })
    ).rejects.toThrow('agent_session_identity_required')
  })
})
