import type { OrchestrationDb } from './db'
import {
  mailboxReservations,
  type MailboxReservation,
  type MailboxReservationRegistry
} from './db/messages/mailbox-reservation-projection'
import type { PointerDeliveryDependencies } from './mailbox-pointer-delivery-contract'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { OrchestrationMailboxPointerState } from './mailbox-pointer-state'

export class MailboxPointerRecovery<TWaiter extends OrchestrationMessageWaiter> {
  private registry?: MailboxReservationRegistry
  private unsubscribe?: () => void

  constructor(
    private readonly deps: PointerDeliveryDependencies<TWaiter>,
    private readonly state: OrchestrationMailboxPointerState
  ) {}

  attach(db: OrchestrationDb | null): void {
    if (this.registry?.connection === db?.db) {
      return
    }
    this.unsubscribe?.()
    this.registry = undefined
    this.state.clear()
    if (!db) {
      return
    }
    const registry = mailboxReservations(db)
    this.registry = registry
    this.unsubscribe = registry.subscribe((rows) => {
      if (!registry.active) {
        this.state.clear()
        return
      }
      if (this.registry !== registry || this.deps.getDb()?.db !== db.db) {
        return
      }
      for (const row of rows) {
        try {
          const handle = this.deps.deliveryTarget.resolveTerminalHandle(row.to_handle)
          if (!handle) {
            continue
          }
          const leaf = this.deps.getLiveLeafForHandle(handle)
          const target = this.deps.resolveSubmitTarget(leaf, row.pointer_pty_id)
          if (
            leaf.ptyId !== row.pointer_pty_id ||
            target?.processIncarnation !== row.pointer_process_incarnation ||
            !leaf.lastAgentStatusObservedLive ||
            (leaf.lastAgentStatus !== 'working' && leaf.lastAgentStatus !== 'permission')
          ) {
            continue
          }
          if (!this.state.observeWorkingFlight(row.pointer_pty_id)) {
            this.reconcile(db, [row])
          }
        } catch {
          // Attach may precede terminal restoration; its next observation retries recovery.
        }
      }
    })
  }

  observeWorking(ptyId: string): void {
    const db = this.deps.getDb()
    this.attach(db)
    if (db) {
      this.reconcile(
        db,
        (this.registry?.forPty(ptyId) ?? []).filter((row) => {
          try {
            const handle = this.deps.deliveryTarget.resolveTerminalHandle(row.to_handle)
            if (!handle) {
              return false
            }
            const leaf = this.deps.getLiveLeafForHandle(handle)
            return (
              leaf.ptyId === ptyId &&
              this.deps.resolveSubmitTarget(leaf, ptyId)?.processIncarnation ===
                row.pointer_process_incarnation
            )
          } catch {
            return false
          }
        })
      )
    }
  }

  settle(ptyId: string, ids: readonly string[], incarnation: string): void {
    const db = this.deps.getDb()
    if (!db || this.registry?.connection !== db.db) {
      return
    }
    const selected = new Set(ids)
    this.reconcile(
      db,
      this.registry
        .forPty(ptyId)
        .filter((row) => selected.has(row.id) && row.pointer_process_incarnation === incarnation)
    )
  }

  private reconcile(db: OrchestrationDb, rows: readonly MailboxReservation[]): void {
    for (const row of rows) {
      const target = {
        ptyId: row.pointer_pty_id,
        processIncarnation: row.pointer_process_incarnation
      }
      if (row.pointer_enter_pending === 1) {
        db.releaseMailboxPointerEnter([row.id], target, [row.pointer_enter_pending])
      } else {
        db.settleMailboxPointerEnter([row.id], target, [row.pointer_enter_pending])
      }
    }
  }
}
