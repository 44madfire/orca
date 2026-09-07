import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import type { RpcContext } from '../../../core'
import { OrchestrationDb } from '../../../../orchestration/db'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  encodeFederatedControlMessage,
  importFederatedControlMessage
} from '../../../../orchestration/federation-control-message'

const DISPATCH_ID = 'ctx_federated_worker_1'
const WORKER_HANDLE = 'term_federated_worker'
const WORKER_PANE = 'tab_w:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const INCARNATION = 'runtime_test:term_federated_worker:1'

type CheckResult = {
  deliveryId: string | null
  messages: { id: string; subject: string }[]
  count: number
  replayed: boolean
  acknowledged: string | null
}

/**
 * The worker host's own `check` is the second writer of a federated attachment mailbox, and it
 * has to name the same Run the import did on both sides of an app restart. Reading the mailbox
 * through the store directly would let that resolver regress unnoticed.
 */
describe('orchestration.check on a federated attachment across a restart', () => {
  let directory: string | undefined
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  function launch(path: string): RpcContext {
    db = new OrchestrationDb(path)
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === WORKER_HANDLE ? WORKER_PANE : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      handle === WORKER_HANDLE ? INCARNATION : null
    )
    return { runtime }
  }

  function check(ctx: RpcContext, params: Record<string, unknown> = {}): Promise<CheckResult> {
    const method = ORCHESTRATION_METHODS.find((entry) => entry.name === 'orchestration.check')
    if (!method) {
      throw new Error('orchestration.check is not registered')
    }
    const parsed = method.params
      ? method.params.parse({ terminal: WORKER_HANDLE, ...params })
      : undefined
    return method.handler(parsed, ctx) as Promise<CheckResult>
  }

  it('replays the coordinator instruction and takes its ack after the app restarts', async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-federated-check-'))
    const path = join(directory, 'orchestration.db')

    const first = launch(path)
    ;(db as OrchestrationDb).db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
           dispatch_id, task_id, home_peer_fingerprint, runtime_epoch,
           pane_key, process_incarnation, terminal_handle, state, consumer_generation
         ) VALUES (?, 'task_federated_1', 'peer_fp', 'epoch_1', ?, ?, ?, 'ready', 0)`
      )
      .run(DISPATCH_ID, WORKER_PANE, INCARNATION, WORKER_HANDLE)
    importFederatedControlMessage(db as OrchestrationDb, {
      dispatchId: DISPATCH_ID,
      messageId: 'msg_federated_1',
      payload: encodeFederatedControlMessage({
        from: 'term_coord',
        subject: 'continue the task',
        body: 'the plan changed',
        type: 'dispatch',
        priority: 'normal',
        threadId: null,
        payload: null
      })
    })

    const delivered = await check(first)
    expect(delivered.messages.map((message) => message.id)).toEqual(['msg_federated_1'])
    expect(delivered.replayed).toBe(false)
    const deliveryId = delivered.deliveryId as string
    expect(deliveryId).not.toBeNull()
    ;(db as OrchestrationDb).close()

    // The worker's process outlives the app; its instruction is still unacknowledged.
    const second = launch(path)
    const replayed = await check(second)
    expect(replayed.deliveryId).toBe(deliveryId)
    expect(replayed.replayed).toBe(true)
    expect(replayed.messages.map((message) => message.id)).toEqual(['msg_federated_1'])

    const acknowledged = await check(second, { ack: deliveryId })
    expect(acknowledged.acknowledged).toBe(deliveryId)
    expect(acknowledged.count).toBe(0)
  })
})
