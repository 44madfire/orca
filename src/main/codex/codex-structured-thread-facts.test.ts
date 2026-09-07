import { describe, expect, it } from 'vitest'
import { readCodexThreadName } from './codex-structured-thread-facts'

describe('readCodexThreadName', () => {
  it('reads the name off the nested thread a start/resume/read reply carries', () => {
    expect(readCodexThreadName({ thread: { id: 't1', name: 'Fix the lease probe' } })).toBe(
      'Fix the lease probe'
    )
  })

  it('reads the envelope field a name-updated notification carries', () => {
    expect(readCodexThreadName({ threadId: 't1', threadName: 'Fix the lease probe' })).toBe(
      'Fix the lease probe'
    )
  })

  it('reads the snake_case spelling the session-configured event uses', () => {
    expect(readCodexThreadName({ thread_name: 'Fix the lease probe' })).toBe('Fix the lease probe')
  })

  it('reports null for an unnamed thread, a cleared name, and a non-object payload', () => {
    expect(readCodexThreadName({ thread: { id: 't1' } })).toBeNull()
    expect(readCodexThreadName({ threadId: 't1', threadName: '' })).toBeNull()
    expect(readCodexThreadName({ threadId: 't1', threadName: null })).toBeNull()
    expect(readCodexThreadName('thread-1')).toBeNull()
    expect(readCodexThreadName(null)).toBeNull()
  })
})
