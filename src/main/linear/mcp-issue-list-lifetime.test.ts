import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueListLifetime } from './mcp-issue-list-lifetime'
import { acquire, release } from './linear-request-concurrency'
import { readFetchResponseBytesWithinLimit } from '../../shared/fetch-response-body'
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

describe('Linear list lease lifetime', () => {
  it('removes an aborted queued waiter without admitting it later', async () => {
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    const abort = new AbortController()
    const queued = acquire(abort.signal)
    const observed = expect(queued).rejects.toBe('cancelled')
    abort.abort('cancelled')
    await observed
    release()
    release()
    release()
    release()
    await Promise.all([acquire(), acquire(), acquire(), acquire()])
    release()
    release()
    release()
    release()
  })
  it.each(['read', 'cancel'] as const)(
    'holds list reservation and provider lease until stuck %s settles',
    async (stuck) => {
      vi.useFakeTimers()
      const read = deferred<ReadableStreamReadResult<Uint8Array>>()
      const cancel = deferred<void>()
      const reader = {
        read: () => read.promise,
        cancel: () => cancel.promise,
        releaseLock: vi.fn()
      }
      const response = {
        headers: new Headers(),
        body: { getReader: () => reader }
      } as unknown as Response
      const owner = new IssueListLifetime(undefined, 10)
      const listing = owner.read('fixture', (signal) =>
        readFetchResponseBytesWithinLimit(response, 1024, signal)
      )
      const observed = expect(listing).rejects.toMatchObject({ code: 'linear_timeout' })
      await vi.advanceTimersByTimeAsync(11)
      await observed
      owner.finish()
      const rest = Array.from({ length: 27 }, () => new IssueListLifetime())
      expect(() => new IssueListLifetime()).toThrow('capacity')
      await Promise.all([acquire(), acquire(), acquire()])
      let fifthAdmitted = false
      const fifth = acquire().then(() => {
        fifthAdmitted = true
      })
      if (stuck === 'read') {
        cancel.resolve()
      } else {
        read.resolve({ done: true, value: undefined })
      }
      await vi.advanceTimersByTimeAsync(1)
      expect(fifthAdmitted).toBe(false)
      expect(() => new IssueListLifetime()).toThrow('capacity')
      read.resolve({ done: true, value: undefined })
      cancel.resolve()
      await fifth
      const recovered = new IssueListLifetime()
      recovered.finish()
      rest.forEach((item) => item.finish())
      release()
      release()
      release()
      release()
      expect(reader.releaseLock).toHaveBeenCalledOnce()
    }
  )
  it('holds a completed result until delivery handoff', async () => {
    const owners = Array.from({ length: 28 }, () => new IssueListLifetime())
    expect(await owners[0].read('fixture', async () => 'complete')).toBe('complete')
    expect(() => new IssueListLifetime()).toThrow('capacity')
    owners[0].finish()
    const next = new IssueListLifetime()
    next.finish()
    owners.forEach((owner) => owner.finish())
  })
})
