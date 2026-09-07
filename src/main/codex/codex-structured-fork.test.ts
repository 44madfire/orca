import { describe, expect, it, vi } from 'vitest'
import { openCodexThread } from './codex-structured-thread-open'

const fork = {
  source: { provider: 'codex', threadId: 'parent' },
  throughId: 'chosen-turn'
} as const

describe('Codex structured fork', () => {
  it('forks inclusively with metadata-only hydration and verifies ancestry', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'child', forkedFromId: 'parent', turns: [] } })
    await expect(
      openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    ).resolves.toMatchObject({ threadId: 'child' })
    expect(request).toHaveBeenCalledExactlyOnceWith(
      'thread/fork',
      { threadId: 'parent', lastTurnId: 'chosen-turn', excludeTurns: true, cwd: '/workspace' },
      { timeoutMs: 100 }
    )
  })

  it.each([
    { id: 'parent', forkedFromId: 'parent' },
    { id: 'child', forkedFromId: 'foreign' },
    { id: 'child' }
  ])('refuses an unproved fork identity %j', async (thread) => {
    const request = vi.fn().mockResolvedValue({ thread })
    await expect(
      openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    ).rejects.toThrow('agent_session_provider_handle_invalid')
  })

  it('does not fall back to unbounded/latest forking when a turn is in progress', async () => {
    const request = vi.fn().mockRejectedValue(new Error('referenced turn is in progress'))
    await expect(
      openCodexThread({ request }, { cwd: '/workspace', resumeThreadId: 'parent' }, 100, fork)
    ).rejects.toThrow('in progress')
    expect(request).toHaveBeenCalledTimes(1)
  })
})
