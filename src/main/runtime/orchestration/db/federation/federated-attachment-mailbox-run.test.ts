import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../shared/orchestration-rpc-contract'
import {
  encodeFederatedControlMessage,
  importFederatedControlMessage
} from '../../federation-control-message'
import { FEDERATED_ATTACHMENT_RUN_ID } from './federated-attachment-mailbox-run'
import type { DeliveryRow, MessageRow, RunRow } from '../../types'

/**
 * A federated worker host holds a `remote_dispatch_attachments` row and no `dispatch_contexts`
 * row, so its `dispatch:<id>` mailbox rows used to fall back to the legacy Run. Live rows there
 * made every open read as version-skewed, replay v2→v39, and let legacy adoption fence the
 * worker's outstanding Delivery and reclassify its message as inert legacy history.
 */
describe('federated worker mailbox Run', () => {
  const DISPATCH_ID = 'ctx_remote_audit_1'
  const ADDRESS = `dispatch:${DISPATCH_ID}`
  const MESSAGE_ID = 'msg_fed_control_audit_1'
  const DELIVERY_ID = 'delivery_fed_audit_1'
  let dir: string | undefined

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  function databasePath(): string {
    dir = mkdtempSync(join(tmpdir(), 'orca-federated-mailbox-run-'))
    return join(dir, 'orchestration.db')
  }

  function attachFederatedWorker(db: OrchestrationDb, dispatchId = DISPATCH_ID): void {
    db.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, runtime_epoch,
           pane_key, terminal_handle, state, consumer_generation
         ) VALUES (?, 'task_remote_audit_1', 'peer_fp', 'epoch_1',
                   'tab_1:leaf_w', 'term_w', 'ready', 0)`
      )
      .run(dispatchId)
  }

  /** The rows the pre-fix build wrote: a live federated mailbox filed under the legacy Run. */
  function seedMisfiledMailbox(db: OrchestrationDb, toHandle = ADDRESS): void {
    db.db
      .prepare(
        `INSERT INTO messages (
           id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, priority
         ) VALUES (?, ?, 'current_delivery', 'term_coord', ?, 'do the thing',
                   'please continue', 'dispatch', 'normal')`
      )
      .run(MESSAGE_ID, ORCHESTRATION_LEGACY_RUN_ID, toHandle)
    db.db
      .prepare(
        `INSERT INTO deliveries (id, run_id, mailbox_handle, consumer_generation, message_ids)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run(DELIVERY_ID, ORCHESTRATION_LEGACY_RUN_ID, toHandle, JSON.stringify([MESSAGE_ID]))
  }

  function readMessage(db: OrchestrationDb): MessageRow {
    return db.db.prepare('SELECT * FROM messages WHERE id = ?').get(MESSAGE_ID) as MessageRow
  }

  function readDelivery(db: OrchestrationDb, id = DELIVERY_ID): DeliveryRow {
    return db.db.prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as DeliveryRow
  }

  function expectDeliverableToWorker(db: OrchestrationDb, deliveryId: string): void {
    const replayed = db.getOrCreateMailboxDelivery({
      runId: FEDERATED_ATTACHMENT_RUN_ID,
      mailboxHandle: ADDRESS,
      consumerGeneration: 0
    })
    expect(replayed?.delivery.id).toBe(deliveryId)
    expect(replayed?.replayed).toBe(true)
    expect(replayed?.messages.map((entry) => entry.id)).toEqual([MESSAGE_ID])
    expect(() =>
      db.acknowledgeMailboxDelivery({
        runId: FEDERATED_ATTACHMENT_RUN_ID,
        mailboxHandle: ADDRESS,
        consumerGeneration: 0,
        deliveryId
      })
    ).not.toThrow()
  }

  it('keeps an imported control message deliverable and acknowledgeable across a restart', () => {
    const path = databasePath()
    const before = new OrchestrationDb(path)
    attachFederatedWorker(before)
    importFederatedControlMessage(before, {
      dispatchId: DISPATCH_ID,
      messageId: MESSAGE_ID,
      payload: encodeFederatedControlMessage({
        from: 'term_coord',
        subject: 'do the thing',
        body: 'please continue',
        type: 'dispatch',
        priority: 'normal',
        threadId: null,
        payload: null
      })
    })
    expect(readMessage(before).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
    const delivered = before.getOrCreateMailboxDelivery({
      runId: FEDERATED_ATTACHMENT_RUN_ID,
      mailboxHandle: ADDRESS,
      consumerGeneration: 0
    })
    expect(delivered?.messages.map((message) => message.id)).toEqual([MESSAGE_ID])
    expect(delivered?.delivery.status).toBe('outstanding')
    const deliveryId = delivered?.delivery.id as string
    before.close()

    // The worker's process outlives the app; the coordinator's instruction is still unread.
    const after = new OrchestrationDb(path)
    try {
      const message = readMessage(after)
      // Every mailbox read filters on `current_delivery`: `legacy_direct` makes the row unreachable.
      expect(message.delivery_contract).toBe('current_delivery')
      expect(message.run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      // Only a consumer-generation change may fence a Delivery. Nothing fenced this worker.
      expect(readDelivery(after, deliveryId).status).toBe('outstanding')
      expect(after.getLegacyAdoption()).toBeUndefined()
      expectDeliverableToWorker(after, deliveryId)
    } finally {
      after.close()
    }
  })

  it('repairs a database the pre-fix build filed under the legacy Run', () => {
    const path = databasePath()
    const poisoned = new OrchestrationDb(path)
    attachFederatedWorker(poisoned)
    seedMisfiledMailbox(poisoned)
    poisoned.close()

    const repaired = new OrchestrationDb(path)
    try {
      expect(readMessage(repaired).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      expect(readMessage(repaired).delivery_contract).toBe('current_delivery')
      expect(readDelivery(repaired).status).toBe('outstanding')
      expect(readDelivery(repaired).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      // The misfiled rows were the only reason the legacy Run looked live, so nothing was adopted.
      expect(repaired.getLegacyAdoption()).toBeUndefined()
      expect(
        (
          repaired.db
            .prepare('SELECT * FROM runs WHERE id = ?')
            .get(ORCHESTRATION_LEGACY_RUN_ID) as RunRow | undefined
        )?.objective
      ).toBe('Legacy orchestration state (inspect only)')
      expectDeliverableToWorker(repaired, DELIVERY_ID)
    } finally {
      repaired.close()
    }
  })

  it('restores a Delivery a legacy adoption pass already swept and fenced', () => {
    const path = databasePath()
    const poisoned = new OrchestrationDb(path)
    attachFederatedWorker(poisoned)
    seedMisfiledMailbox(poisoned)
    // Exactly what the pre-fix build's next open did to these rows.
    poisoned.classifyLegacyMessageContracts(ORCHESTRATION_LEGACY_RUN_ID, false)
    poisoned.adoptLegacyRunIfNeeded()
    expect(readMessage(poisoned).delivery_contract).toBe('legacy_direct')
    expect(readDelivery(poisoned).status).toBe('fenced')
    poisoned.close()

    const repaired = new OrchestrationDb(path)
    try {
      expect(readMessage(repaired).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      expect(readMessage(repaired).delivery_contract).toBe('current_delivery')
      expect(readDelivery(repaired).status).toBe('outstanding')
      expectDeliverableToWorker(repaired, DELIVERY_ID)
    } finally {
      repaired.close()
    }
  })

  it('leaves a genuine legacy mailbox to legacy adoption', () => {
    const path = databasePath()
    const legacy = new OrchestrationDb(path)
    attachFederatedWorker(legacy)
    // A pre-Run coordinator mailbox: no federated attachment owns this handle.
    seedMisfiledMailbox(legacy, 'term_legacy_coordinator')
    legacy.close()

    const opened = new OrchestrationDb(path)
    try {
      const adoption = opened.getLegacyAdoption()
      expect(adoption).toBeDefined()
      expect(readMessage(opened).run_id).toBe(adoption?.adopted_run_id)
      expect(readMessage(opened).delivery_contract).toBe('legacy_direct')
      expect(readDelivery(opened).status).toBe('fenced')
    } finally {
      opened.close()
    }
  })

  it('never restores a Delivery whose consumer generation the attachment has left', () => {
    const path = databasePath()
    const poisoned = new OrchestrationDb(path)
    attachFederatedWorker(poisoned)
    seedMisfiledMailbox(poisoned)
    poisoned.db.prepare("UPDATE deliveries SET status = 'fenced' WHERE id = ?").run(DELIVERY_ID)
    poisoned.db
      .prepare(
        'UPDATE remote_dispatch_attachments SET consumer_generation = 1 WHERE dispatch_id = ?'
      )
      .run(DISPATCH_ID)
    poisoned.close()

    const repaired = new OrchestrationDb(path)
    try {
      // The rows still leave the legacy Run; a real fence is evidence and survives the repair.
      expect(readMessage(repaired).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      expect(readDelivery(repaired).status).toBe('fenced')
    } finally {
      repaired.close()
    }
  })
})
