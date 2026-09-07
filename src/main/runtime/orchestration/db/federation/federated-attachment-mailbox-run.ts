import type { OrchestrationDb } from '../orchestration-db'

/**
 * A federated worker host holds a `remote_dispatch_attachments` row for the Dispatch it serves,
 * and usually no `dispatch_contexts` row, so its mailbox rows had no Run to live under and fell
 * back to the legacy Run. That broke the legacy Run's one premise — that live rows there prove a
 * pre-Run database — and every open replayed the migration chain and let legacy adoption fence the
 * worker's outstanding Delivery. These mailboxes get their own non-legacy Run instead; the Run that
 * owns the Dispatch stays on the home and is never named here.
 *
 * The Run id is host-local and never crosses the wire, so mixed-version peers are unaffected. An
 * older binary reopening this database is not: its `check` addresses the legacy Run, so it cannot
 * read or acknowledge these rows, and re-poisoning from a downgrade is not repaired a second time
 * because the v40 stamp is already written. Downgrade is out of scope by decision, not oversight.
 */
export const FEDERATED_ATTACHMENT_RUN_ID = 'run_federated_local'

const FEDERATED_ATTACHMENT_RUN_OBJECTIVE = 'Federated worker attachments hosted on this Orca server'

/**
 * The Run a `dispatch:<id>` mailbox belongs to on the host that executes that worker, as SQL over
 * an arbitrary handle column. A loopback home shares this database, so a local Dispatch row still
 * outranks the federated Run — the same precedence `resolveFederatedMailboxRunId` applies.
 */
export function federatedMailboxRunIdSql(handleColumn: string): string {
  return `COALESCE(
      (SELECT dispatch.run_id FROM dispatch_contexts AS dispatch
        WHERE 'dispatch:' || dispatch.id = ${handleColumn}),
      '${FEDERATED_ATTACHMENT_RUN_ID}'
    )`
}

/**
 * A federated attachment's mailbox row that is sitting in the wrong Run.
 *
 * Membership is the attachment alone: a loopback Dispatch has both rows, and excluding it was what
 * left that configuration unrepaired. The Run comparison is what keeps this from claiming mail that
 * is already where it belongs, including a Dispatch whose own Run is the legacy one.
 *
 * Out of scope: a loopback Dispatch whose own Run is the legacy one, which adoption would sweep
 * alongside its mail, leaving the row under the right Run but still stamped `legacy_direct`. Nothing
 * can create that shape — `resolveRunScope` refuses an explicit Run whose `legacy` flag is set — so
 * widening this to re-classify by contract would guard a state no caller can reach.
 */
export function misplacedFederatedMailboxSql(handleColumn: string, runColumn: string): string {
  return `EXISTS (
      SELECT 1 FROM remote_dispatch_attachments AS attachment
       WHERE 'dispatch:' || attachment.dispatch_id = ${handleColumn}
    )
    AND ${runColumn} <> ${federatedMailboxRunIdSql(handleColumn)}`
}

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

export type FederatedAttachmentMailboxRunMethods = {
  ensureFederatedAttachmentRun: typeof ensureFederatedAttachmentRun
  resolveFederatedMailboxRunId: typeof resolveFederatedMailboxRunId
}

export function attachFederatedAttachmentMailboxRun(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    ensureFederatedAttachmentRun,
    resolveFederatedMailboxRunId
  })
}
