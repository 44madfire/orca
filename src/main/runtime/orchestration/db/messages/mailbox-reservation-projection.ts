import type { OrchestrationDb } from '../orchestration-db'

export type MailboxReservation = {
  id: string
  pointer_pty_id: string
  pointer_process_incarnation: string
  pointer_enter_pending: number
  to_handle: string
}

const COLUMNS = 'id, pointer_pty_id, pointer_process_incarnation, pointer_enter_pending, to_handle'
const registries = new WeakMap<OrchestrationDb['db'], MailboxReservationRegistry>()

// SQLite's temporary journal participates in the writer's transaction and savepoints.
export class MailboxReservationRegistry {
  private readonly reservations = new Map<string, MailboxReservation>()
  private readonly idsByPty = new Map<string, Set<string>>()
  readonly generation = {}
  active = true
  private dirty = false
  private publishing = false
  private retryQueued = false
  private readonly listeners = new Set<(rows: readonly MailboxReservation[]) => void>()
  private readonly stop: () => void

  constructor(readonly connection: OrchestrationDb['db']) {
    connection.function('orca_mailbox_reservation_changed', () => {
      this.dirty = true
      return 0
    })
    connection.exec(`CREATE TEMP TABLE mailbox_reservation_changes (id TEXT PRIMARY KEY);
      CREATE TEMP TRIGGER mailbox_reservation_insert AFTER INSERT ON main.messages
      BEGIN
        INSERT INTO mailbox_reservation_changes SELECT NEW.id
          WHERE NOT EXISTS (SELECT 1 FROM mailbox_reservation_changes WHERE id = NEW.id);
        SELECT orca_mailbox_reservation_changed();
      END;
      CREATE TEMP TRIGGER mailbox_reservation_update AFTER UPDATE ON main.messages
      WHEN OLD.pointer_enter_pending > 0 OR NEW.pointer_enter_pending > 0 BEGIN
        INSERT INTO mailbox_reservation_changes SELECT OLD.id
          WHERE NOT EXISTS (SELECT 1 FROM mailbox_reservation_changes WHERE id = OLD.id);
        INSERT INTO mailbox_reservation_changes SELECT NEW.id
          WHERE NOT EXISTS (SELECT 1 FROM mailbox_reservation_changes WHERE id = NEW.id);
        SELECT orca_mailbox_reservation_changed();
      END;
      CREATE TEMP TRIGGER mailbox_reservation_delete AFTER DELETE ON main.messages
      WHEN OLD.pointer_enter_pending > 0 BEGIN
        INSERT INTO mailbox_reservation_changes SELECT OLD.id
          WHERE NOT EXISTS (SELECT 1 FROM mailbox_reservation_changes WHERE id = OLD.id);
        SELECT orca_mailbox_reservation_changed();
      END;`)
    for (const row of connection
      .prepare(`SELECT ${COLUMNS} FROM messages
      WHERE pointer_enter_pending > 0`)
      .all() as MailboxReservation[]) {
      this.remember(row)
    }
    this.stop = connection.observeExecution(() => this.publishCommitted())
  }

  subscribe(listener: (rows: readonly MailboxReservation[]) => void): () => void {
    this.listeners.add(listener)
    listener([...this.reservations.values()])
    return () => this.listeners.delete(listener)
  }

  forPty(ptyId: string): MailboxReservation[] {
    return [...(this.idsByPty.get(ptyId) ?? [])].map((id) => this.reservations.get(id)!)
  }

  mayHave(ptyId: string): boolean {
    return this.dirty || this.idsByPty.has(ptyId)
  }

  private forget(id: string): void {
    const prior = this.reservations.get(id)
    if (prior) {
      const ids = this.idsByPty.get(prior.pointer_pty_id)
      ids?.delete(id)
      if (ids?.size === 0) {
        this.idsByPty.delete(prior.pointer_pty_id)
      }
    }
    this.reservations.delete(id)
  }

  private remember(row: MailboxReservation): void {
    this.reservations.set(row.id, row)
    const ids = this.idsByPty.get(row.pointer_pty_id) ?? new Set<string>()
    ids.add(row.id)
    this.idsByPty.set(row.pointer_pty_id, ids)
  }

  close(): void {
    this.active = false
    this.stop()
    for (const listener of this.listeners) {
      listener([])
    }
    this.listeners.clear()
    this.reservations.clear()
    this.idsByPty.clear()
  }

  private publishCommitted(retry = true): void {
    if (!this.active || !this.dirty || this.publishing || this.connection.isTransaction) {
      return
    }
    this.publishing = true
    try {
      while (this.dirty) {
        const changed = this.connection
          .prepare('SELECT id FROM mailbox_reservation_changes')
          .all() as { id: string }[]
        const rows = this.connection
          .prepare(`SELECT ${COLUMNS} FROM messages
          WHERE id IN (SELECT id FROM mailbox_reservation_changes)
            AND pointer_enter_pending > 0`)
          .all() as MailboxReservation[]
        this.connection.exec('DELETE FROM mailbox_reservation_changes')
        this.dirty = false
        const relevant = rows.length > 0 || changed.some(({ id }) => this.reservations.has(id))
        for (const { id } of changed) {
          this.forget(id)
        }
        for (const row of rows) {
          this.remember(row)
        }
        if (relevant) {
          for (const listener of this.listeners) {
            listener(rows)
          }
        }
      }
    } catch {
      // A committed writer must not report failure because a disposable observer failed.
      this.dirty = true
      if (retry && !this.retryQueued) {
        this.retryQueued = true
        queueMicrotask(() => {
          this.retryQueued = false
          this.publishCommitted(false)
        })
      }
    } finally {
      this.publishing = false
    }
  }
}

export function mailboxReservations(db: OrchestrationDb): MailboxReservationRegistry {
  let registry = registries.get(db.db)
  if (!registry) {
    registry = new MailboxReservationRegistry(db.db)
    registries.set(db.db, registry)
  }
  return registry
}

export function hasMailboxReservation(db: OrchestrationDb, ptyId: string): boolean {
  // Transactional callers may see uncommitted rows; never use committed absence there.
  return db.db.isTransaction || mailboxReservations(db).mayHave(ptyId)
}
