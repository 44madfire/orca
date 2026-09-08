import { expect, it } from 'vitest'
import { createUsageEventAggregation } from './usage-event-aggregation'
import type { UsageAttributedEventFields } from './usage-rollup-records'

type Event = UsageAttributedEventFields & { cost: number }
const aggregation = createUsageEventAggregation<Event, { cost: number }>({
  metric: {
    empty: () => ({ cost: 0 }),
    fromEvent: (event) => ({ cost: event.cost }),
    fold: (target, source) => {
      target.cost += source.cost
    }
  },
  cloneSessionForMerge: (session) => structuredClone(session)
})

function events(count: number): Event[] {
  return Array.from({ length: count }, (_, index) => ({
    sessionId: 'session',
    timestamp: '2026-09-07T00:00:00Z',
    day: '2026-09-07',
    model: `model-${index % 5}`,
    projectKey: `path-${index}`,
    projectLabel: `Path ${index}`,
    repoId: null,
    worktreeId: null,
    inputTokens: 1,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens: 3,
    cost: 0.5
  }))
}

it('folds events without rescanning accumulated location breakdowns', () => {
  let reads = 0
  const input = events(1000)
  input.forEach((event, index) =>
    Object.defineProperty(event, 'projectKey', {
      get() {
        reads += 1
        return `path-${index}`
      }
    })
  )
  const result = aggregation.aggregate([...input, ...input])
  expect(reads).toBeLessThan(30000)
  const session = result.sessions[0]
  expect(session.totalTokens).toBe(6000)
  expect(session.cost).toBe(1000)
  expect(session.locationBreakdown).toHaveLength(1000)
  expect(session.locationBreakdown.every((entry) => entry.eventCount === 2)).toBe(true)
  expect(session.modelBreakdown).toHaveLength(5)
  expect(result.dailyAggregates).toHaveLength(1000)
})

it('merges rollups using first-match indexes without mutating source breakdowns', () => {
  const source = aggregation.aggregate(events(1000)).sessions[0]
  const existing = structuredClone(source)
  let reads = 0
  for (const entry of [...existing.locationBreakdown, ...existing.locationModelBreakdown]) {
    const key = entry.locationKey
    Object.defineProperty(entry, 'locationKey', {
      get() {
        reads += 1
        return key
      }
    })
  }
  const target = new Map([['session', existing]])
  aggregation.mergeSessions(target, [source, source])
  expect(reads).toBeLessThan(10000)
  expect(existing.totalTokens).toBe(9000)
  expect(existing.cost).toBe(1500)
  expect(source.totalTokens).toBe(3000)
  expect(existing.locationBreakdown.every((entry) => entry.eventCount === 3)).toBe(true)
})

it('preserves first-wins duplicate rows and exact location/model tuple identity', () => {
  const source = aggregation.aggregate(events(1)).sessions[0]
  const existing = structuredClone(source)
  existing.locationBreakdown.push({ ...existing.locationBreakdown[0], eventCount: 42 })
  aggregation.mergeSessions(new Map([['session', existing]]), [source])
  expect(existing.locationBreakdown.map((entry) => entry.eventCount)).toEqual([2, 42])
  const input = events(2)
  input[0].projectKey = 'a::b'
  input[0].model = 'c'
  input[1].projectKey = 'a'
  input[1].model = 'b::c'
  expect(aggregation.aggregate(input).sessions[0].locationModelBreakdown).toHaveLength(2)
})
