import type { OrchestrationDb } from '../orchestration-db'
import { FEDERATED_STUB_HOME_RUN_ID_PREFIX } from '../contract-constants'

export function migrateV40(this: OrchestrationDb, current: number): void {
  if (current >= 40) {
    return
  }
  if (!this.hasColumn('remote_dispatch_attachments', 'home_run_id')) {
    this.db.exec(
      "ALTER TABLE remote_dispatch_attachments ADD COLUMN home_run_id TEXT NOT NULL DEFAULT ''"
    )
  }
  // Why: workers attached by v1.4.198 keep a mailbox; without a Run their control mail is refused.
  this.db.exec(`
    INSERT OR IGNORE INTO runs (id, objective, home_database, consumer_generation, legacy)
    SELECT '${FEDERATED_STUB_HOME_RUN_ID_PREFIX}' || dispatch_id,
           'Coordinated from ' || home_peer_fingerprint, 'remote', 0, 0
    FROM remote_dispatch_attachments WHERE home_run_id = '';
    UPDATE remote_dispatch_attachments
    SET home_run_id = '${FEDERATED_STUB_HOME_RUN_ID_PREFIX}' || dispatch_id
    WHERE home_run_id = '';
  `)
}
