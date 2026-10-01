// Pi-family flavor unit tests (PIF-3, 44madfire/orca#24; settlement revised per #21).
//
// The dialect stays tiny: executable selection plus whole-session idle per
// provider. OMP terminal agent_end is one run yielding, never session idle;
// session_settled (or correlated prompt_result sessionSettled) gates idle.

import { describe, expect, it } from 'vitest'
import { isOmpRunYield, resolvePiFamilyFlavor } from './pi-family-flavor'

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

  it('settles OMP only on session_settled, never on agent_end alone', () => {
    const { isSettled } = resolvePiFamilyFlavor('omp')
    expect(isSettled({ type: 'session_settled' })).toBe(true)
    expect(isSettled({ type: 'agent_end', isTerminal: true })).toBe(false)
    expect(isSettled({ type: 'agent_end' })).toBe(false)
    expect(isSettled({ type: 'agent_end', isTerminal: undefined })).toBe(false)
    expect(isSettled({ type: 'agent_end', isTerminal: false })).toBe(false)
    expect(isSettled({ type: 'agent_settled' })).toBe(false)
    expect(isSettled({ type: 'turn_end' })).toBe(false)
  })

  it('settles OMP on correlated prompt_result sessionSettled, ignoring uncorrelated frames', () => {
    const { isSettled } = resolvePiFamilyFlavor('omp')
    expect(isSettled({ type: 'prompt_result', id: 'r1', sessionSettled: true })).toBe(true)
    expect(isSettled({ type: 'prompt_result', id: '', sessionSettled: true })).toBe(false)
    expect(isSettled({ type: 'prompt_result', sessionSettled: true })).toBe(false)
    expect(isSettled({ type: 'prompt_result', id: 'r1' })).toBe(false)
    expect(isSettled({ type: 'prompt_result', id: 'r1', sessionSettled: false })).toBe(false)
  })

  it('reports OMP terminal agent_end as a run yield, never session idle', () => {
    expect(isOmpRunYield({ type: 'agent_end', isTerminal: true })).toBe(true)
    expect(isOmpRunYield({ type: 'agent_end' })).toBe(true)
    expect(isOmpRunYield({ type: 'agent_end', isTerminal: false })).toBe(false)
    expect(isOmpRunYield({ type: 'session_settled' })).toBe(false)
    expect(isOmpRunYield({ type: 'agent_settled' })).toBe(false)
  })
})
