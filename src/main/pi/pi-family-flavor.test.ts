// Pi-family flavor unit tests (PIF-3, 44madfire/orca#24).
//
// The dialect stays tiny: executable selection plus the final-settle
// predicate per provider. OMP `agent_end { isTerminal: false }` must remain
// active; every other `agent_end` shape is terminal.

import { describe, expect, it } from 'vitest'
import { resolvePiFamilyFlavor } from './pi-family-flavor'

describe('resolvePiFamilyFlavor', () => {
  it('selects the matching executable per provider', () => {
    expect(resolvePiFamilyFlavor('pi')).toMatchObject({
      provider: 'pi',
      executable: 'pi'
    })
    expect(resolvePiFamilyFlavor('omp')).toMatchObject({
      provider: 'omp',
      executable: 'omp'
    })
  })

  it('settles Pi only on agent_settled', () => {
    const { isSettled } = resolvePiFamilyFlavor('pi')
    expect(isSettled({ type: 'agent_settled' })).toBe(true)
    expect(isSettled({ type: 'agent_end', isTerminal: true })).toBe(false)
    expect(isSettled({ type: 'turn_end' })).toBe(false)
    expect(isSettled({ type: 'message_update' })).toBe(false)
  })

  it('settles OMP on terminal agent_end, including the absent legacy field', () => {
    const { isSettled } = resolvePiFamilyFlavor('omp')
    expect(isSettled({ type: 'agent_end', isTerminal: true })).toBe(true)
    expect(isSettled({ type: 'agent_end' })).toBe(true)
    expect(isSettled({ type: 'agent_end', isTerminal: undefined })).toBe(true)
  })

  it('keeps OMP agent_end with isTerminal false active', () => {
    const { isSettled } = resolvePiFamilyFlavor('omp')
    expect(isSettled({ type: 'agent_end', isTerminal: false })).toBe(false)
    expect(isSettled({ type: 'turn_end' })).toBe(false)
    expect(isSettled({ type: 'agent_settled' })).toBe(false)
  })
})
