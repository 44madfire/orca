import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DirectReturnProbe } from './mobile-direct-return-probe'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { FakeSession, host } from './mobile-endpoint-supervisor-test-fakes'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

// A LAN that never answers: every dial sits open until the probe's own 12s budget.
function fixture(
  overrides: {
    migrate?: () => Promise<void>
    adoptsOutright?: () => boolean
    onCutoverFailure?: (error: Error) => void
  } = {}
) {
  const opened: FakeSession[] = []
  const cutoverFailures: Error[] = []
  const probe = new DirectReturnProbe(
    {
      now: Date.now,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      openDirect: () => {
        const candidate = new FakeSession('connecting')
        opened.push(candidate)
        return candidate
      }
    },
    {
      hysteresis: new MobileEndpointHysteresis(Date.now(), {
        directSuccessesRequired: 1,
        directObservationMs: 60_000,
        failureCooldownMs: 0,
        minimumDwellMs: 0
      }),
      host: () => host,
      canSchedule: () => true,
      canDial: () => true,
      canAttempt: () => true,
      // These cases model a live relay session, so hysteresis still arbitrates.
      adoptsOutright: overrides.adoptsOutright ?? (() => false),
      beginOperation: () => {},
      migrate: overrides.migrate ?? (async () => {}),
      onDirectMigrated: async () => {},
      afterProbe: () => {},
      onCutoverFailure: overrides.onCutoverFailure ?? ((error) => cutoverFailures.push(error))
    }
  )
  return { opened, probe, cutoverFailures }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('never opens a second dial while one is still in flight', async () => {
  const { opened, probe } = fixture()
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toHaveLength(1)

  // A relay drop and a foreground return both ask for an immediate probe while the
  // first dial is still awaiting authentication.
  probe.schedule(0)
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toHaveLength(1)

  // Why this is the assertion that matters: a second probe would have overwritten
  // activeProbe, so stop() would abort only the newest dial and leave this socket
  // open for the rest of its 12s budget.
  probe.stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(opened[0]!.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('honors an urgent reprobe asked for mid-dial instead of dropping it on the 15s floor', async () => {
  const { opened, probe } = fixture()
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  expect(opened).toHaveLength(1)

  // The deferred ask survives the dial and runs at once when it settles, so holding
  // the slot does not cost the caller the 15s it was trying to skip.
  await vi.advanceTimersByTimeAsync(12_000)
  await vi.advanceTimersByTimeAsync(1)
  expect(opened).toHaveLength(2)
  probe.stop()
})

it('falls back to the ordinary interval when nothing asked for a sooner probe', async () => {
  const { opened, probe } = fixture()
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(12_000)
  expect(opened).toHaveLength(1)

  await vi.advanceTimersByTimeAsync(14_999)
  expect(opened).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(opened).toHaveLength(2)
  probe.stop()
})

it('reports a cutover that fails after authentication instead of rejecting unhandled', async () => {
  // Why: probe() runs from a timer that discards its promise. During a reconnect
  // race the abort predicate stays false while nothing is connected, so a candidate
  // that drops between authentication and the swap used to escape as an unhandled
  // rejection on every such reconnect.
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    const { opened, probe, cutoverFailures } = fixture({
      adoptsOutright: () => true,
      migrate: async () => {
        throw new Error('direct session dropped before cutover')
      }
    })
    probe.schedule(0)
    await vi.advanceTimersByTimeAsync(0)
    opened[0]!.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(cutoverFailures.map((error) => error.message)).toEqual([
      'direct session dropped before cutover'
    ])
    expect(unhandled).not.toHaveBeenCalled()
    probe.stop()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})

it('stays quiet when the cutover was withdrawn because relay won the race', async () => {
  let relayWon = false
  const { opened, probe, cutoverFailures } = fixture({
    adoptsOutright: () => !relayWon,
    migrate: async () => {
      relayWon = true
      throw new Error('migration superseded')
    }
  })
  probe.schedule(0)
  await vi.advanceTimersByTimeAsync(0)
  opened[0]!.publishState('connected')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(0)

  expect(cutoverFailures).toEqual([])
  probe.stop()
})

it('contains a reporter that throws, so the timer promise still settles cleanly', async () => {
  const unhandled = vi.fn()
  process.on('unhandledRejection', unhandled)
  try {
    const { opened, probe } = fixture({
      adoptsOutright: () => true,
      migrate: async () => {
        throw new Error('direct session dropped before cutover')
      },
      onCutoverFailure: () => {
        throw new Error('reporter exploded')
      }
    })
    probe.schedule(0)
    await vi.advanceTimersByTimeAsync(0)
    opened[0]!.publishState('connected')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)

    expect(unhandled).not.toHaveBeenCalled()
    probe.stop()
  } finally {
    process.off('unhandledRejection', unhandled)
  }
})
