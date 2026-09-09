import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-contracts'
import { createCodexStructuredNotificationRetry } from './codex-structured-notification-retry'
import type { CodexSession } from './codex-structured-session-state'

type Translate = Parameters<typeof createCodexStructuredNotificationRetry>[0]['translate']

function sessionWith(connection: CodexAppServerConnection): CodexSession {
  return { connection, ended: false } as CodexSession
}

function translateMock(
  ...results: CodexJournalTranslationAdmission[]
): ReturnType<typeof vi.fn<Translate>> {
  const translate = vi.fn<Translate>()
  for (const result of results) {
    translate.mockReturnValueOnce(result)
  }
  return translate
}

describe('createCodexStructuredNotificationRetry', () => {
  it('replays a backpressured turn boundary with its original receipt time', async () => {
    vi.useFakeTimers()
    try {
      const connection = {
        pauseReading: vi.fn(),
        resumeReading: vi.fn()
      } as unknown as CodexAppServerConnection
      const session = sessionWith(connection)
      const translate = translateMock({ accepted: false, reason: 'backpressure' })
      translate.mockReturnValue({ accepted: true })
      const retries = createCodexStructuredNotificationRetry({
        sessionFor: () => session,
        translate
      })

      const admission = retries.handle('session-1', 'turn/started', { turn: { id: 't' } }, 1_000)
      expect(admission).toEqual({ accepted: false, reason: 'backpressure' })
      await vi.advanceTimersByTimeAsync(50)

      expect(translate).toHaveBeenCalledTimes(2)
      expect(translate.mock.calls.map((call) => call[4])).toEqual([1_000, 1_000])
      expect(connection.resumeReading).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('queues a later notification behind a pending one without inventing a receipt time', () => {
    const connection = {
      pauseReading: vi.fn(),
      resumeReading: vi.fn()
    } as unknown as CodexAppServerConnection
    const session = sessionWith(connection)
    const translate = translateMock()
    translate.mockReturnValue({ accepted: false, reason: 'backpressure' })
    const retries = createCodexStructuredNotificationRetry({
      sessionFor: () => session,
      translate
    })

    retries.handle('session-1', 'turn/started', { turn: { id: 't' } }, 1_000)
    retries.handle('session-1', 'item/completed', { item: { id: 'i' } })
    retries.clear('session-1', connection)

    // Every attempt replays the head of the queue with its own receipt time;
    // the later notification never jumps ahead of it.
    expect(translate.mock.calls.length).toBeGreaterThan(0)
    expect(translate.mock.calls.map((call) => [call[2], call[4]])).toEqual(
      translate.mock.calls.map(() => ['turn/started', 1_000])
    )
  })
})
