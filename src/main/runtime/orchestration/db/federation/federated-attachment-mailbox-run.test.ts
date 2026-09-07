import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../shared/orchestration-rpc-contract'
import { SCHEMA_VERSION } from '../contract-constants'
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
  /** What the build that misfiled these rows stamped; v40 is the step that re-homes them. */
  const PRE_FIX_SCHEMA_VERSION = SCHEMA_VERSION - 1
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

  function attachFederatedWorker(db: OrchestrationDb, state = 'ready'): void {
    db.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, runtime_epoch,
           pane_key, terminal_handle, state, consumer_generation
         ) VALUES (?, 'task_remote_audit_1', 'peer_fp', 'epoch_1',
                   'tab_1:leaf_w', 'term_w', ?, 0)`
      )
      .run(DISPATCH_ID, state)
  }

  /**
   * The rows the pre-fix build wrote: a live federated mailbox filed under the legacy Run, left
   * behind at the schema version that build stamped, which is what makes v40 reachable.
   */
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
    db.db.exec(`PRAGMA user_version = ${PRE_FIX_SCHEMA_VERSION}`)
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

  it('redelivers an instruction a legacy adoption pass already swept and fenced', () => {
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
      // The fence stays: nothing durable proves which incarnation minted this Delivery. The
      // unread instruction is what the worker is owed, and a fresh Delivery carries it.
      expect(readDelivery(repaired).status).toBe('fenced')
      const minted = repaired.getOrCreateMailboxDelivery({
        runId: FEDERATED_ATTACHMENT_RUN_ID,
        mailboxHandle: ADDRESS,
        consumerGeneration: 0
      })
      expect(minted?.delivery.id).not.toBe(DELIVERY_ID)
      expect(minted?.messages.map((entry) => entry.id)).toEqual([MESSAGE_ID])
      expectDeliverableToWorker(repaired, minted?.delivery.id as string)
    } finally {
      repaired.close()
    }
  })

  // A populated pre-v36 host has the same misfiled rows: role mailboxes shipped at v34, and v36
  // only added the consumer-generation counters. Requiring them made the first upgraded open
  // skip the relocation, replay adoption, and fence the instruction for that whole launch.
  it('relocates a populated pre-v36 mailbox on the first upgraded open', () => {
    const path = databasePath()
    const old = new OrchestrationDb(path)
    attachFederatedWorker(old)
    seedMisfiledMailbox(old)
    old.db.exec(
      `ALTER TABLE remote_dispatch_attachments DROP COLUMN consumer_generation;
       ALTER TABLE dispatch_contexts DROP COLUMN consumer_generation;
       PRAGMA user_version = 35`
    )
    old.close()

    const upgraded = new OrchestrationDb(path)
    try {
      expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(readMessage(upgraded).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      expect(readMessage(upgraded).delivery_contract).toBe('current_delivery')
      expect(readDelivery(upgraded).status).toBe('outstanding')
      expect(readDelivery(upgraded).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      expectDeliverableToWorker(upgraded, DELIVERY_ID)
    } finally {
      upgraded.close()
    }
  })

  // A database old enough to predate `messages.delivery_contract` is genuinely version-skewed, so
  // the probe still replays the chain and adoption still sweeps by Run. v40 re-homes the rows
  // afterwards, which is the honest degraded outcome: the instruction is redelivered, not lost.
  it('redelivers a pre-contract mailbox that the replayed adoption pass swept', () => {
    const path = databasePath()
    const old = new OrchestrationDb(path)
    attachFederatedWorker(old)
    seedMisfiledMailbox(old)
    old.db.exec(
      `DROP TRIGGER IF EXISTS trg_messages_route_coordinator_mail;
       DROP INDEX IF EXISTS idx_messages_delivery_contract;
       DROP INDEX IF EXISTS idx_messages_undelivered_direct_run;
       DROP INDEX IF EXISTS idx_messages_unread_current_inbox;
       DROP INDEX IF EXISTS idx_messages_unread_current_inbox_type;
       DROP INDEX IF EXISTS idx_messages_unread_current_run_type;
       ALTER TABLE messages DROP COLUMN delivery_contract;
       PRAGMA user_version = 18`
    )
    old.close()

    const upgraded = new OrchestrationDb(path)
    try {
      expect(readMessage(upgraded).run_id).toBe(FEDERATED_ATTACHMENT_RUN_ID)
      expect(readMessage(upgraded).delivery_contract).toBe('current_delivery')
      const minted = upgraded.getOrCreateMailboxDelivery({
        runId: FEDERATED_ATTACHMENT_RUN_ID,
        mailboxHandle: ADDRESS,
        consumerGeneration: 0
      })
      expect(minted?.messages.map((entry) => entry.id)).toEqual([MESSAGE_ID])
      expectDeliverableToWorker(upgraded, minted?.delivery.id as string)
    } finally {
      upgraded.close()
    }
  })

  // A loopback home shares this database, so the Dispatch has both an attachment row and a local
  // `dispatch_contexts` row. Excluding that shape from the re-home left the one configuration the
  // resolver was written for unrepaired, and the resolver's own preference was asserted nowhere.
  it('re-homes a loopback mailbox onto the local Dispatch Run, not the federated Run', () => {
    const path = databasePath()
    const old = new OrchestrationDb(path)
    const run = old.createRun({
      objective: 'loopback home',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_c:leaf_c'
    })
    const task = old.createTask({ spec: 'loopback task', runId: run.id })
    const dispatch = createRootDispatch(old, task.id, 'term_w', 'tab_1:leaf_w')
    old.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state
         ) VALUES (?, ?, 'peer_fp', 'epoch_1', 'ready')`
      )
      .run(dispatch.id, task.id)
    expect(old.resolveFederatedMailboxRunId(dispatch.id)).toBe(run.id)
    old.db
      .prepare(
        `INSERT INTO messages (
           id, run_id, delivery_contract, from_handle, to_handle, subject, type, priority
         ) VALUES (?, ?, 'current_delivery', 'term_coord', ?, 'do the thing', 'dispatch', 'normal')`
      )
      .run(MESSAGE_ID, ORCHESTRATION_LEGACY_RUN_ID, `dispatch:${dispatch.id}`)
    old.db.exec(`PRAGMA user_version = ${PRE_FIX_SCHEMA_VERSION}`)
    old.close()

    const upgraded = new OrchestrationDb(path)
    try {
      expect(readMessage(upgraded).run_id).toBe(run.id)
      expect(readMessage(upgraded).delivery_contract).toBe('current_delivery')
      expect(upgraded.getLegacyAdoption()).toBeUndefined()
    } finally {
      upgraded.close()
    }
  })

  // The Run comparison, not attachment membership, is what keeps legacy mail legacy. A pre-Run
  // Dispatch whose id also carries an attachment row is already in the Run it belongs to, so v40
  // must not claim it and hand inert history back as current-contract mail.
  it('never re-homes mail whose Dispatch Run is the legacy Run', () => {
    const path = databasePath()
    const legacy = new OrchestrationDb(path)
    const dispatchId = 'ctx_legacy_local_1'
    legacy.db
      .prepare(
        `INSERT INTO dispatch_contexts (id, run_id, task_id, status)
         VALUES (?, ?, 'task_legacy_1', 'dispatched')`
      )
      .run(dispatchId, ORCHESTRATION_LEGACY_RUN_ID)
    legacy.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, state
         ) VALUES (?, 'task_legacy_1', 'peer_fp', 'epoch_1', 'ready')`
      )
      .run(dispatchId)
    seedMisfiledMailbox(legacy, `dispatch:${dispatchId}`)
    legacy.close()

    const opened = new OrchestrationDb(path)
    try {
      const adoption = opened.getLegacyAdoption()
      // The legacy Dispatch row is real evidence of a pre-Run graph, so adoption still runs.
      expect(adoption).toBeDefined()
      expect(readMessage(opened).run_id).toBe(adoption?.adopted_run_id)
      expect(readMessage(opened).delivery_contract).toBe('legacy_direct')
    } finally {
      opened.close()
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

  // `resetTasks` keeps deliveries while dropping attachments, so a recreated Dispatch restarts the
  // consumer counter. Current-generation equality would read that as "never fenced" and hand a real
  // authority fence back to a different process incarnation.
  it('keeps a real authority fence across a task reset and attachment recreation', () => {
    const path = databasePath()
    const host = new OrchestrationDb(path)
    attachFederatedWorker(host, 'starting')
    host.db.exec('UPDATE remote_dispatch_attachments SET consumer_generation = 1')
    seedMisfiledMailbox(host)
    host.db.prepare('UPDATE deliveries SET consumer_generation = 1 WHERE id = ?').run(DELIVERY_ID)
    host.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: 'tab_1:leaf_w',
      processIncarnation: 'proc_first',
      worktreeId: 'folder',
      terminalHandle: 'term_w',
      setupState: 'ready',
      effects: []
    })
    expect(readDelivery(host).status).toBe('fenced')
    host.resetTasks()
    host.createRemoteDispatchAttachment({
      dispatchId: DISPATCH_ID,
      taskId: 'task_remote_audit_1',
      homePeerFingerprint: 'peer_fp',
      protocolVersion: 1,
      runtimeEpoch: 'epoch_2',
      mutationReceipt: {
        callerFingerprint: 'peer_fp',
        requestId: 'req_2',
        method: 'attach',
        payloadHash: 'hash_2'
      }
    })
    host.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: 'tab_2:leaf_w',
      processIncarnation: 'proc_second',
      worktreeId: 'folder',
      terminalHandle: 'term_w2',
      setupState: 'ready',
      effects: []
    })
    host.recordRemoteAttachmentStage({ dispatchId: DISPATCH_ID, stage: 'ready', state: 'ready' })
    expect(host.getRemoteDispatchAttachment(DISPATCH_ID)?.consumer_generation).toBe(1)
    host.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(readDelivery(reopened).status).toBe('fenced')
    } finally {
      reopened.close()
    }
  })
})
