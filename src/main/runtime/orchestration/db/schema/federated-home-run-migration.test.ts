import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../shared/protocol-version'
import { OrchestrationDb } from '../orchestration-db'
import { federatedStubHomeRunId } from '../contract-constants'
import { migrateV40 } from './migrate-v40'
import { importFederatedControlMessage } from '../../federation-control-message'

describe('federated home Run migration', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function importInstruction(dispatchId: string, messageId: string): void {
    expect(
      importFederatedControlMessage(db, {
        dispatchId,
        messageId,
        payload: JSON.stringify({ from: 'home', subject: 'Instruction', body: '', type: 'status' })
      })
    ).toEqual({ imported: true, type: 'status' })
  }

  it('backfills a pre-upgrade attachment with a stub home Run that keeps its mailbox', () => {
    db.db.exec('ALTER TABLE remote_dispatch_attachments DROP COLUMN home_run_id')
    db.db.exec(`INSERT INTO remote_dispatch_attachments
      (dispatch_id, task_id, home_peer_fingerprint, runtime_epoch)
      VALUES ('ctx_old', 'task_old', 'home', 'epoch')`)
    migrateV40.call(db, 39)
    const stubRunId = federatedStubHomeRunId('ctx_old')
    expect(db.getRemoteDispatchAttachment('ctx_old')?.home_run_id).toBe(stubRunId)
    expect(db.getRunRaw(stubRunId)).toMatchObject({ home_database: 'remote', legacy: 0 })
    importInstruction('ctx_old', 'message_old')
    expect(db.getMessageById('message_old')?.run_id).toBe(stubRunId)
  })

  it('mints a stub home Run when a v1.4.198 coordinator attaches without a Run id', () => {
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_legacy_home',
      taskId: 'task_legacy_home',
      homePeerFingerprint: 'home',
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: 'epoch',
      mutationReceipt: {
        callerFingerprint: 'home',
        requestId: 'request_legacy_home',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'legacy_home_payload'
      }
    })
    const stubRunId = federatedStubHomeRunId('ctx_legacy_home')
    expect(db.getRemoteDispatchAttachment('ctx_legacy_home')?.home_run_id).toBe(stubRunId)
    importInstruction('ctx_legacy_home', 'message_legacy_home')
    expect(db.getMessageById('message_legacy_home')?.run_id).toBe(stubRunId)
  })
})
