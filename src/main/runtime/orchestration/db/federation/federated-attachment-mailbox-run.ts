import { LEGACY_RUN_ID } from '../contract-constants'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * A federated worker host holds a `remote_dispatch_attachments` row and no `dispatch_contexts`
 * row for the Dispatch it serves, so its mailbox rows had no Run to live under and fell back to
 * the legacy Run. Live rows there make every open read as version-skewed, replay the whole
 * migration chain, and let legacy adoption fence the worker's outstanding Delivery. They get
 * their own non-legacy Run instead; the Run that owns the Dispatch stays on the home.
 *
 * The Run id is host-local and never crosses the wire, so mixed-version peers are unaffected.
 * An older binary reopening this database is not: its `check` addresses the legacy Run, so it
 * cannot read or acknowledge these rows. Downgrade is out of scope by decision, not oversight.
 */
export const FEDERATED_ATTACHMENT_RUN_ID = 'run_federated_local'

const FEDERATED_ATTACHMENT_RUN_OBJECTIVE = 'Federated worker attachments hosted on this Orca server'

const RELOCATE_SAVEPOINT = 'federated_attachment_mailbox_relocate'

// Mailboxes whose only possible writer is a federated attachment: no local Dispatch row owns them.
const FEDERATED_MAILBOX_HANDLES_SQL = `
    SELECT 'dispatch:' || attachment.dispatch_id
    FROM remote_dispatch_attachments AS attachment
    WHERE NOT EXISTS (
      SELECT 1 FROM dispatch_contexts AS dispatch WHERE dispatch.id = attachment.dispatch_id
    )`

export function ensureFederatedAttachmentRun(this: OrchestrationDb): string {
  if (!this.getRunRaw(FEDERATED_ATTACHMENT_RUN_ID)) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (id, objective, home_database, consumer_generation, legacy)
         VALUES (?, ?, 'this_database', 0, 0)`
      )
      .run(FEDERATED_ATTACHMENT_RUN_ID, FEDERATED_ATTACHMENT_RUN_OBJECTIVE)
  }
  return FEDERATED_ATTACHMENT_RUN_ID
}

/** The one Run that scopes a `dispatch:<id>` mailbox on the host executing that worker. */
export function resolveFederatedMailboxRunId(this: OrchestrationDb, dispatchId: string): string {
  // A loopback home shares this database; there the local Dispatch's Run already owns the mail.
  return this.getDispatchContextById(dispatchId)?.run_id ?? this.ensureFederatedAttachmentRun()
}

function adoptedRunIds(this: OrchestrationDb): string[] {
  if (!this.hasColumn('legacy_adoptions', 'adopted_run_id')) {
    return []
  }
  return (
    this.db.prepare('SELECT adopted_run_id FROM legacy_adoptions').all() as {
      adopted_run_id: string
    }[]
  ).map((row) => row.adopted_run_id)
}

/**
 * Moves mailbox rows the pre-fix build misfiled onto the federated Run.
 *
 * Runs twice per open, and both are load-bearing: before `migrate` so the version-skew probe
 * cannot read these rows as a live legacy graph, and again inside the legacy-contract migration
 * so a replay from any start version cannot classify or fence them. Neither pass needs a schema
 * version — it degrades to whatever columns the stored shape actually has, because a populated
 * database at any version back to the first role mailbox can hold the misfiled rows.
 */
export function relocateFederatedAttachmentMailboxes(this: OrchestrationDb): void {
  if (!this.db.prepare('SELECT 1 FROM remote_dispatch_attachments LIMIT 1').get()) {
    return
  }
  if (!this.hasColumn('messages', 'run_id') || !this.hasColumn('messages', 'delivery_contract')) {
    return
  }
  const sourceRunIds = [LEGACY_RUN_ID, ...adoptedRunIds.call(this)]
  const sources = sourceRunIds.map(() => '?').join(',')
  const messageFilter = `run_id IN (${sources}) AND to_handle IN (${FEDERATED_MAILBOX_HANDLES_SQL})`
  // Pre-v34 deliveries are addressed by Run alone, so only their messages can be relocated.
  const deliveryFilter = this.hasColumn('deliveries', 'mailbox_handle')
    ? `run_id IN (${sources}) AND mailbox_handle IN (${FEDERATED_MAILBOX_HANDLES_SQL})`
    : undefined
  const deliveryProbe = deliveryFilter
    ? ` UNION ALL SELECT 1 FROM deliveries WHERE ${deliveryFilter}`
    : ''
  const misfiled = this.db
    .prepare(`SELECT 1 FROM messages WHERE ${messageFilter}${deliveryProbe} LIMIT 1`)
    .get(...sourceRunIds, ...(deliveryFilter ? sourceRunIds : []))
  if (!misfiled) {
    return
  }
  runLifecycleWriteTransaction(this.db, RELOCATE_SAVEPOINT, () => {
    const runId = this.ensureFederatedAttachmentRun()
    this.db
      .prepare(
        `UPDATE messages SET run_id = ?, delivery_contract = 'current_delivery'
         WHERE ${messageFilter}`
      )
      .run(runId, ...sourceRunIds)
    if (deliveryFilter) {
      this.db
        .prepare(`UPDATE deliveries SET run_id = ? WHERE ${deliveryFilter}`)
        .run(runId, ...sourceRunIds)
    }
  })
  // Why no un-fence: a fence is a safety state, and nothing durable records which incarnation
  // minted a Delivery or why it was fenced. Current-generation equality is not that provenance —
  // `resetTasks` keeps deliveries while dropping attachments, so a recreated Dispatch restarts the
  // counter and a real authority fence would match. The message stays unread under the federated
  // Run, so the worker's next check mints a fresh Delivery carrying the same instruction.
}

export type FederatedAttachmentMailboxRunMethods = {
  ensureFederatedAttachmentRun: typeof ensureFederatedAttachmentRun
  resolveFederatedMailboxRunId: typeof resolveFederatedMailboxRunId
  relocateFederatedAttachmentMailboxes: typeof relocateFederatedAttachmentMailboxes
}

export function attachFederatedAttachmentMailboxRun(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    ensureFederatedAttachmentRun,
    resolveFederatedMailboxRunId,
    relocateFederatedAttachmentMailboxes
  })
}
