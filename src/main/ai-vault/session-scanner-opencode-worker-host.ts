import type { Worker } from 'node:worker_threads'
import type { OpenCodeSqliteWorkerResponse } from './session-scanner-opencode-sqlite-worker-protocol'
import { errorMessage } from './session-scanner-values'

export type WorkerFactory = () => Worker

export const IDLE_TEARDOWN_MS = 30_000

/**
 * Owns the lifetime of the one OpenCode SQLite worker thread: lazy spawn,
 * listener wiring, teardown, and idle expiry. It holds no request state, so
 * every decision about which call a message belongs to stays with the client.
 */
export class OpenCodeSqliteWorkerHost {
  private worker: Worker | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private cleanupListeners: (() => void) | null = null
  private loggedUnavailable = false

  constructor(
    private readonly options: {
      factory: WorkerFactory
      log: (message: string) => void
      onMessage: (response: OpenCodeSqliteWorkerResponse) => void
      onError: (error: Error) => void
      onExit: (code: number) => void
      /** Nothing active and nothing queued, checked again when the idle timer fires. */
      isIdle: () => boolean
    }
  ) {}

  get current(): Worker | null {
    return this.worker
  }

  /** The live worker, spawning one if needed; null when no worker can be had. */
  ensure(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.options.factory()
      const onMessage = (response: OpenCodeSqliteWorkerResponse): void =>
        this.options.onMessage(response)
      const onError = (error: Error): void => this.options.onError(error)
      const onExit = (code: number): void => this.options.onExit(code)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      this.cleanupListeners = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      // Never keep the app alive for a scan worker.
      worker.unref?.()
      this.worker = worker
      return worker
    } catch (err) {
      // Why (#8864): never fall back to synchronous SQLite reads here; a missing
      // bundle or resource-exhausted spawn must omit OpenCode history rather than
      // reintroduce the main-process hang this worker boundary prevents.
      if (!this.loggedUnavailable) {
        this.loggedUnavailable = true
        this.options.log(
          `OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`
        )
      }
      return null
    }
  }

  destroy(): void {
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    if (!worker) {
      return
    }
    this.cleanupListeners?.()
    this.cleanupListeners = null
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }

  scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    if (!this.worker) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // Re-checked here: a request arriving as the timer fires must never be
      // lost to a self-exiting worker.
      if (this.options.isIdle()) {
        this.destroy()
      }
    }, IDLE_TEARDOWN_MS)
    this.idleTimer.unref?.()
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
