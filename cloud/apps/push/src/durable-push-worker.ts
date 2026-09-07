import { buildPushDelivery, summaryBody } from './push-delivery-message.js'
import type { PushDispatcher } from './push-dispatcher.js'
import type { DurablePushStore } from './durable-push-store.js'

export class DurablePushWorker {
  private timer?: NodeJS.Timeout
  private running: Promise<void> | null = null
  private stopped = false
  constructor(
    private readonly store: DurablePushStore,
    private readonly dispatcher: PushDispatcher,
    private readonly options: { now?: () => number; onRetry?: () => void } = {}
  ) {}

  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      void this.runDue().catch(() => {
        console.warn(JSON.stringify({ event: 'orca_push_worker_failed' }))
      })
    }, 1000)
    this.timer.unref()
  }

  async runDue(): Promise<void> {
    if (this.running) {
      await this.running
      return
    }
    if (this.stopped) return
    const pending = Promise.allSettled(Array.from({ length: 4 }, () => this.drain())).then(
      (results) => {
        const failure = results.find((result) => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
      }
    )
    this.running = pending
    try {
      await pending
    } finally {
      this.running = null
    }
  }

  private async drain(): Promise<void> {
    for (let count = 0; count < 25 && !this.stopped; count++) {
      const batch = await this.store.claim()
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
      if ((this.options.now ?? Date.now)() >= batch.expiresAt) {
        await this.store.finish(batch)
        continue
      }
      const heartbeat = setInterval(() => {
        void this.store.renew(batch).catch(() => {})
      }, 10_000)
      heartbeat.unref()
      try {
        if (batch.attempts > 1) this.options.onRetry?.()
        const outcome = await this.dispatcher.sendOnce(delivery)
        const retryAfterMs =
          outcome.status === 'error' && outcome.retryable
            ? Math.max(
                outcome.retryAfterMs ?? 0,
                Math.min(30_000, 1000 * 2 ** Math.min(batch.attempts, 5))
              )
            : undefined
        await this.store.finish(batch, retryAfterMs, outcome.status)
      } catch {
        await this.store.finish(batch, 5000)
      } finally {
        clearInterval(heartbeat)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.running
  }
}
