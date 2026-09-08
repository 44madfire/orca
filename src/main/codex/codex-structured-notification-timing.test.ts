import { afterEach, expect, it, vi } from 'vitest'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { CodexSession } from './codex-structured-session-state'

afterEach(() => vi.useRealTimers())
it('retains ingress time through backpressure retries and releases the pending timer on close', () => {
  vi.useFakeTimers()
  const connection = { pauseReading: vi.fn(), resumeReading: vi.fn() }
  const session = { connection, ended: false } as unknown as CodexSession
  let admit = false
  const times: (number | undefined)[] = []
  const retry = createCodexStructuredNotificationRetry({
    sessionFor: () => session,
    translate: (_id, _session, _method, _params, observedAt) => {
      times.push(observedAt)
      return admit ? { accepted: true } : { accepted: false, reason: 'backpressure' }
    }
  })
  retry.handle('s', 'turn/completed', { turn: { id: 't' } }, 188000)
  vi.setSystemTime(86400000)
  admit = true
  vi.advanceTimersByTime(25)
  expect(times.length).toBeGreaterThan(1)
  expect(new Set(times)).toEqual(new Set([188000]))
  admit = false
  retry.handle('s', 'turn/started', { turn: { id: 'next' } }, 200000)
  retry.clear('s', null)
  expect(vi.getTimerCount()).toBe(0)
  expect(connection.resumeReading).toHaveBeenCalled()
})
