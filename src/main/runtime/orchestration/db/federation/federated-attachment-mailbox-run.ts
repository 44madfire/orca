import { LEGACY_RUN_ID } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * A federated worker host holds a `remote_dispatch_attachments` row and no `dispatch_contexts`
 * row for the Dispatch it serves, so its mailbox rows had no Run to live under and fell back to
 * the legacy Run. Live rows there make every open read as version-skewed, replay the whole
 * migration chain, and let legacy adoption fence the worker's outstanding Delivery. They get
 * their own non-legacy Run instead; the Run that owns the Dispatch stays on the home.
 */
export const FEDERATED_ATTACHMENT_RUN_ID = 'run_federated_local'

const FEDERATED_ATTACHMENT_RUN_OBJECTIVE = 'Federated worker attachments hosted on this Orca server'

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
 * Repairs a database the pre-fix build already misfiled, before the version-skew probe reads it.
 * Adoption may have swept the rows into the recovered Run and fenced the Delivery on the way; both
 * are undone, because no consumer generation ever changed.
 */
export function repairFederatedAttachmentMailboxRuns(this: OrchestrationDb): void {
  if (!this.db.prepare('SELECT 1 FROM remote_dispatch_attachments LIMIT 1').get()) {
    return
  }
  // Pre-v36 databases predate federated dispatch mailboxes entirely, so there is nothing to repair.
  if (
    !this.hasColumn('deliveries', 'mailbox_handle') ||
    !this.hasColumn('messages', 'delivery_contract') ||
    !this.hasColumn('remote_dispatch_attachments', 'consumer_generation')
  ) {
    return
  }
  const sourceRunIds = [LEGACY_RUN_ID, ...adoptedRunIds.call(this)]
  const sources = sourceRunIds.map(() => '?').join(',')
  const misfiled = this.db
    .prepare(
      `SELECT 1 FROM messages
       WHERE run_id IN (${sources}) AND to_handle IN (${FEDERATED_MAILBOX_HANDLES_SQL})
       UNION ALL
       SELECT 1 FROM deliveries
       WHERE run_id IN (${sources}) AND mailbox_handle IN (${FEDERATED_MAILBOX_HANDLES_SQL})
       LIMIT 1`
    )
    .get(...sourceRunIds, ...sourceRunIds)
  if (!misfiled) {
    return
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const runId = this.ensureFederatedAttachmentRun()
    this.db
      .prepare(
        `UPDATE messages SET run_id = ?, delivery_contract = 'current_delivery'
         WHERE run_id IN (${sources}) AND to_handle IN (${FEDERATED_MAILBOX_HANDLES_SQL})`
      )
      .run(runId, ...sourceRunIds)
    this.db
      .prepare(
        `UPDATE deliveries SET run_id = ?
         WHERE run_id IN (${sources}) AND mailbox_handle IN (${FEDERATED_MAILBOX_HANDLES_SQL})`
      )
      .run(runId, ...sourceRunIds)
    restoreAdoptionFencedDeliveries.call(this, runId)
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Only adoption could have fenced these, and only by Run sweep: the attachment still carries the
 * generation the Delivery was minted at, and no message in it was ever read, so nothing consumed
 * or superseded it. The newest-fenced and no-outstanding guards keep the one-outstanding index.
 */
function restoreAdoptionFencedDeliveries(this: OrchestrationDb, runId: string): void {
  this.db
    .prepare(
      `UPDATE deliveries SET status = 'outstanding'
       WHERE status = 'fenced' AND run_id = ?
         AND EXISTS (
           SELECT 1 FROM remote_dispatch_attachments AS attachment
           WHERE 'dispatch:' || attachment.dispatch_id = deliveries.mailbox_handle
             AND attachment.consumer_generation = deliveries.consumer_generation
         )
         AND NOT EXISTS (
           SELECT 1 FROM deliveries AS other
           WHERE other.mailbox_handle = deliveries.mailbox_handle
             AND other.status = 'outstanding'
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(deliveries.message_ids) AS entry
           INNER JOIN messages AS message ON message.id = entry.value
           WHERE message.read = 1
         )
         AND deliveries.id = (
           SELECT newest.id FROM deliveries AS newest
           WHERE newest.mailbox_handle = deliveries.mailbox_handle AND newest.status = 'fenced'
           ORDER BY newest.created_at DESC, newest.rowid DESC LIMIT 1
         )`
    )
    .run(runId)
}

export type FederatedAttachmentMailboxRunMethods = {
  ensureFederatedAttachmentRun: typeof ensureFederatedAttachmentRun
  resolveFederatedMailboxRunId: typeof resolveFederatedMailboxRunId
  repairFederatedAttachmentMailboxRuns: typeof repairFederatedAttachmentMailboxRuns
}

export function attachFederatedAttachmentMailboxRun(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    ensureFederatedAttachmentRun,
    resolveFederatedMailboxRunId,
    repairFederatedAttachmentMailboxRuns
  })
}
