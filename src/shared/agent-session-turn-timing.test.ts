import { describe, expect, it } from 'vitest'
import {
  completedAgentJournalTurnSeconds,
  mergeAgentJournalTurnTiming
} from './agent-session-turn-timing'
import { selectPersistedNativeChatTurnStatuses } from './native-chat-turn-status'

describe('durable turn endpoints', () => {
  it.each([
    undefined,
    { userItemId: 'u' },
    { userItemId: 'u', start: { at: 1000, source: 'host' } },
    { userItemId: 'u', start: { at: 1000, source: 'host' }, end: { at: 0, source: 'host' } },
    { userItemId: 'u', start: { at: 1000, source: 'host' }, end: { at: 999, source: 'host' } },
    {
      userItemId: 'u',
      start: { at: Number.NaN, source: 'host' },
      end: { at: 2000, source: 'host' }
    },
    { userItemId: 'u', start: { at: 1000, source: 'provider' }, end: { at: 2000, source: 'host' } }
  ])('does not invent a numeric interval from %j', (timing) => {
    expect(completedAgentJournalTurnSeconds(timing as never)).toBeNull()
  })
  it('keeps first host observation and allows late provider correction without mixing sources', () => {
    const initial = {
      userItemId: 'u',
      start: { at: 1000, source: 'host' as const },
      end: { at: 188000, source: 'host' as const }
    }
    expect(
      mergeAgentJournalTurnTiming(initial, { userItemId: 'u', end: { at: 999999, source: 'host' } })
    ).toEqual(initial)
    const partial = mergeAgentJournalTurnTiming(initial, {
      userItemId: 'u',
      start: { at: 2000, source: 'provider' }
    })
    expect(completedAgentJournalTurnSeconds(partial)).toBeNull()
    const final = mergeAgentJournalTurnTiming(partial, {
      userItemId: 'u',
      end: { at: 189000, source: 'provider' }
    })
    expect(completedAgentJournalTurnSeconds(final)).toBe(187)
  })
  it('invalid authoritative metadata removes a cached numeric duration', () => {
    const old = { startedAt: 1000, thinking: false, workedSeconds: 187 }
    expect(
      selectPersistedNativeChatTurnStatuses(
        [
          {
            id: 'u',
            role: 'user',
            source: 'transcript',
            timestamp: 1,
            blocks: [],
            turnTiming: { userItemId: 'u' }
          }
        ],
        'u',
        false,
        { active: old, completedByTurn: { u: old } }
      )
    ).toEqual({ active: null, completedByTurn: {} })
  })
})

it('allows provider and ingress provenance only with explicit common execution-host clock evidence', () => {
  expect(
    completedAgentJournalTurnSeconds({
      userItemId: 'u',
      start: { at: 1000, source: 'provider', clock: 'acquisition' },
      end: { at: 188000, source: 'host', clock: 'acquisition' }
    })
  ).toBe(187)
})

it('rejects mixed clocks after a different acquisition or historical restore', () => {
  for (const clock of ['another-acquisition', undefined]) {
    expect(
      completedAgentJournalTurnSeconds({
        userItemId: 'u',
        start: { at: 1000, source: 'provider', clock: 'original' },
        end: { at: 188000, source: 'host', clock }
      })
    ).toBeNull()
  }
})

it('retains clock proof only for an identical authoritative endpoint', () => {
  const current = {
    userItemId: 'u',
    start: { at: 1000, source: 'provider' as const, clock: 'live' },
    end: { at: 188000, source: 'host' as const, clock: 'live' }
  }
  const repeated = mergeAgentJournalTurnTiming(current, {
    userItemId: 'u',
    start: { at: 1000, source: 'provider' }
  })
  expect(completedAgentJournalTurnSeconds(repeated)).toBe(187)
  const corrected = mergeAgentJournalTurnTiming(current, {
    userItemId: 'u',
    start: { at: 2000, source: 'provider' }
  })
  expect(corrected.start?.clock).toBeUndefined()
  expect(completedAgentJournalTurnSeconds(corrected)).toBeNull()
  const changedSource = mergeAgentJournalTurnTiming(current, {
    userItemId: 'u',
    end: { at: 188000, source: 'provider' }
  })
  expect(changedSource.end?.clock).toBeUndefined()
  expect(completedAgentJournalTurnSeconds(changedSource)).toBe(187)
})
