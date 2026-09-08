import type { OrchestrationDb } from '../orchestration-db'

export function migrateV41(this: OrchestrationDb, current: number): void {
  if (current >= 41) {
    return
  }
  this.db.exec('ALTER TABLE runs ADD COLUMN coordinator_agent_session_id TEXT')
  this.db.exec('ALTER TABLE dispatch_contexts ADD COLUMN assignee_agent_session_id TEXT')
}
