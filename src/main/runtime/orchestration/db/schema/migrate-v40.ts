import { LEGACY_RUN_ID } from '../contract-constants'
import {
  ensureFederatedAttachmentRun,
  federatedMailboxRunIdSql,
  misplacedFederatedMailboxSql
} from '../federation/federated-attachment-mailbox-run'
import type { OrchestrationDb } from '../orchestration-db'

/**
 * Re-homes federated attachment mailboxes that an earlier build filed under the legacy Run, and
 * that legacy adoption may since have swept into the recovered Run and stamped `legacy_direct`.
 *
 * No Delivery is un-fenced. Nothing durable records why a Delivery was fenced, and a fence is a
 * safety state, so an ambiguous one stays fenced; the instruction is not lost, because its message
 * returns unread under the right Run and the worker's next check mints a fresh Delivery for it.
 */
export function migrateV40(this: OrchestrationDb, current: number): void {
  if (current >= 40) {
    return
  }
  const sourceRuns = `(SELECT ? UNION SELECT adopted_run_id FROM legacy_adoptions)`
  const misplacedMessages = `run_id IN ${sourceRuns} AND ${misplacedFederatedMailboxSql('to_handle', 'run_id')}`
  const misplacedDeliveries = `run_id IN ${sourceRuns} AND ${misplacedFederatedMailboxSql('mailbox_handle', 'run_id')}`
  // Why guarded: a host that never federated must not gain the Run, and this is its only chance.
  const misplaced = this.db
    .prepare(
      `SELECT 1 FROM messages WHERE ${misplacedMessages}
       UNION ALL SELECT 1 FROM deliveries WHERE ${misplacedDeliveries} LIMIT 1`
    )
    .get(LEGACY_RUN_ID, LEGACY_RUN_ID)
  if (!misplaced) {
    return
  }
  ensureFederatedAttachmentRun.call(this)
  this.db
    .prepare(
      `UPDATE messages
          SET run_id = ${federatedMailboxRunIdSql('to_handle')},
              delivery_contract = 'current_delivery'
        WHERE ${misplacedMessages}`
    )
    .run(LEGACY_RUN_ID)
  this.db
    .prepare(
      `UPDATE deliveries
          SET run_id = ${federatedMailboxRunIdSql('mailbox_handle')}
        WHERE ${misplacedDeliveries}`
    )
    .run(LEGACY_RUN_ID)
}

export type SchemaMigrateV40Methods = {
  migrateV40: typeof migrateV40
}
