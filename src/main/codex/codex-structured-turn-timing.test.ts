import { expect, it } from 'vitest'
import {
  codexStructuredTurnTiming,
  codexTurnTimingSettlementKey
} from './codex-structured-turn-timing'

it('gives duplicate and retried endpoint evidence one settlement identity and late corrections another', () => {
  const timing = codexStructuredTurnTiming('thread', 'turn', {
    turn: { startedAt: 100, completedAt: 287 }
  })
  expect(codexTurnTimingSettlementKey(timing)).toBe(
    codexTurnTimingSettlementKey(JSON.parse(JSON.stringify(timing)))
  )
  expect(codexTurnTimingSettlementKey(timing)).not.toBe(
    codexTurnTimingSettlementKey({ ...timing, end: { at: 288000, source: 'provider' } })
  )
  expect(codexTurnTimingSettlementKey(codexStructuredTurnTiming('thread', 'turn', {}))).toBe('')
})
it('does not replace invalid provider endpoints with host observation time', () => {
  expect(
    codexStructuredTurnTiming('thread', 'turn', { turn: { startedAt: -1 } }, 'start', 1000).start
  ).toBeUndefined()
  expect(codexStructuredTurnTiming('thread', 'turn', {}, 'start', 1000).start).toEqual({
    at: 1000,
    source: 'host'
  })
})
