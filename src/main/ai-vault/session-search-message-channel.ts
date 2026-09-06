import type { SessionSearchCapturedMessage } from './session-search-capture'

/** Producer checkpoints after each file chunk; the consumer releases its retained messages. */
export class SessionSearchMessageChannel implements AsyncIterable<SessionSearchCapturedMessage> {
  private queued: SessionSearchCapturedMessage[] = []
  private wake: (() => void) | null = null
  private drained: (() => void) | null = null
  private ended = false
  private stopped = false
  private failure: unknown

  push(message: SessionSearchCapturedMessage): void {
    if (!this.stopped) {
      this.queued.push(message)
    }
    this.wake?.()
  }
  checkpoint(): Promise<void> {
    if (!this.queued.length || this.stopped) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.drained = resolve
    })
  }
  close(error?: unknown): void {
    this.failure = error
    this.ended = true
    this.wake?.()
  }
  stop(): void {
    this.stopped = true
    this.queued = []
    this.drained?.()
    this.wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<SessionSearchCapturedMessage> {
    while (!this.stopped) {
      const batch = this.queued
      this.queued = []
      for (const message of batch) {
        yield message
      }
      this.drained?.()
      this.drained = null
      if (this.failure) {
        throw this.failure
      }
      if (this.ended && !this.queued.length) {
        return
      }
      if (!this.queued.length) {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
      this.wake = null
    }
  }
}
