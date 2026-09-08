import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
import { shouldHandoffDaemonHistory } from './daemon-history-handoff'
import { serializeSessionOperation } from './session-operation-serialization'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

export class DaemonRouterSessionCustody {
  private readonly operations = new Map<string, Promise<void>>()
  readonly releasing = new Map<DaemonPtyAdapter, number>()
  readonly releasingIds = new Set<string>()

  constructor(
    private readonly current: DaemonPtyAdapter,
    private readonly ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
    private readonly adapterFor: (id: string) => DaemonPtyAdapter
  ) {}

  // Select the owner inside the queue; a preceding sleep may transfer it to current.
  run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    return serializeSessionOperation(this.operations, id, operation)
  }

  shutdown(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<DaemonPtyAdapter> {
    return this.run(id, () => this.releaseWithCustody(id, opts))
  }

  private async releaseWithCustody(
    id: string,
    opts: { immediate?: boolean; keepHistory?: boolean; deadlineMs?: number }
  ): Promise<DaemonPtyAdapter> {
    const adapter = this.adapterFor(id)
    this.releasing.set(adapter, (this.releasing.get(adapter) ?? 0) + 1)
    this.releasingIds.add(id)
    try {
      await adapter.shutdown(id, opts)
      const migrateHistory =
        shouldHandoffDaemonHistory(opts.keepHistory, adapter, this.current) &&
        (adapter.protocolVersion < CLEAN_DISCONNECT_PROTOCOL_VERSION ||
          (await adapter.canHandoffHistoryTo(this.current, id)))
      if (!opts.keepHistory || migrateHistory) {
        if (migrateHistory) {
          adapter.ackColdRestore(id)
        }
        this.ownerResolver.forgetRoute(id, adapter)
      } else {
        this.ownerResolver.recordRoute(id, adapter)
      }
    } finally {
      this.releasingIds.delete(id)
      const remaining = this.releasing.get(adapter)! - 1
      if (remaining === 0) {
        this.releasing.delete(adapter)
      } else {
        this.releasing.set(adapter, remaining)
      }
    }
    return adapter
  }
}
