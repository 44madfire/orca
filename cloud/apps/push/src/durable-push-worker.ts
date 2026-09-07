import { summaryBody } from './coalescer.js'
import { buildPushDelivery } from './push-delivery-message.js'
import type { PushDispatcher } from './push-dispatcher.js'
import type { DurablePushStore } from './durable-push-store.js'

export class DurablePushWorker {
  private timer?: NodeJS.Timeout
  private running: Promise<void> | null = null
  private stopped = false
  constructor(
    private readonly store: DurablePushStore,
    private readonly dispatcher: PushDispatcher,
    private readonly now = Date.now
  ) {}

  pendingCount(registrationId: string): Promise<number> {
    return this.store.pendingCount(registrationId)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.run(undefined, false).catch(() => {
        console.warn(JSON.stringify({ event: 'orca_push_worker_failed' }))
      })
    }, 1000)
    this.timer.unref()
  }

  async flush(registrationId?: string): Promise<void> {
    await this.run(registrationId, true)
  }

  async flushAll(): Promise<void> {
    await this.run(undefined, true)
  }

  private async run(registrationId: string | undefined, force: boolean): Promise<void> {
    if (this.running) {
      await this.running
      return
    }
    if (this.stopped) return
    const pending = Promise.allSettled(
      Array.from({ length: 4 }, () => this.drain(registrationId, force))
    ).then((results) => {
      const failure = results.find((result) => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    })
    this.running = pending
    try {
      await pending
    } finally {
      this.running = null
    }
  }

  private async drain(registrationId: string | undefined, force: boolean): Promise<void> {
    for (let count = 0; count < 25 && !this.stopped; count++) {
      const batch = await this.store.claim(registrationId, force)
      if (!batch) return
      const latest = batch.notifications.at(-1)!
      const multiple = batch.notifications.length > 1
      const delivery = buildPushDelivery({
        registrationId: batch.registrationId,
        hostFingerprint: batch.hostFingerprint,
        notification: latest,
        title: multiple ? 'Orca' : latest.title,
        body: multiple ? summaryBody(batch.notifications) : latest.body,
        coalescedCount: batch.notifications.length,
        notifications: batch.notifications
      })
      delivery.expiresAt = batch.expiresAt
      if (this.now() >= batch.expiresAt) {
        await this.store.finish(batch)
        continue
      }
      const heartbeat = setInterval(() => {
        void this.store.renew(batch).catch(() => {})
      }, 10_000)
      heartbeat.unref()
      try {
        const outcome = await this.dispatcher.sendOnce(delivery)
        const retry =
          outcome.status === 'error' && outcome.retryable
            ? { delayMs: outcome.retryAfterMs ?? 0 }
            : undefined
        await this.store.finish(
          batch,
          retry
            ? Math.max(retry.delayMs, Math.min(30_000, 1000 * 2 ** Math.min(batch.attempts, 5)))
            : undefined,
          outcome.status
        )
      } catch {
        await this.store.finish(batch, 5000)
      } finally {
        clearInterval(heartbeat)
      }
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
