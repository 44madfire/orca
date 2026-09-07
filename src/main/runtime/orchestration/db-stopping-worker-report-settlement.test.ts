import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { Coordinator } from './coordinator'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import type { MessagePriority, MessageType } from './types'

const PANE_W = 'tab_w:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('a Task whose supervised worker is stopping', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function localWorker() {
    const task = db.createTask({ spec: 'local work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_w',
      paneKey: PANE_W,
      processIncarnation: 'inc1',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return { task, dispatch }
  }

  function federatedWorker() {
    const task = db.createTask({ spec: 'remote work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 99,
      federation: {
        environmentId: 'env_remote',
        environmentName: 'remote',
        peerFingerprint: 'peer_fp',
        protocolVersion: 12
      }
    })
    db.reconcileFederatedWorkerStart({
      dispatchId: dispatch.id,
      state: 'ready',
      stage: 'input_accepted',
      worktreeId: 'wt_remote',
      terminalHandle: 'term_remote'
    })
    return { task, dispatch }
  }

  function relayItem(
    taskId: string,
    runId: string,
    dispatchId: string,
    sequence: number,
    kind: 'status' | 'done',
    outcome: 'succeeded' | 'failed' = 'succeeded'
  ) {
    return {
      dispatchId,
      sequence,
      message: {
        id: `msg_${sequence}`,
        runId,
        from: `dispatch:${dispatchId}`,
        to: `run:${runId}`,
        subject: kind === 'done' ? 'Worker done' : `Update ${sequence}`,
        body: 'b',
        type: 'status' as MessageType,
        priority: 'normal' as MessagePriority
      },
      lifecycle:
        kind === 'done'
          ? { kind: 'worker_report' as const, taskId, outcome, result: 'the real answer' }
          : { kind: 'none' as const }
    }
  }

  describe('task-update', () => {
    it('refuses to re-open the Task while the worker is stopping', () => {
      const { task, dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_home')
      expect(db.getTask(task.id)?.status).toBe('blocked')

      expect(() => db.updateTaskStatus(task.id, 'dispatched')).toThrowError(
        expect.objectContaining({
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: dispatch.id }
        })
      )
      expect(db.getTask(task.id)?.status).toBe('blocked')
    })

    it('refuses to re-open the Task while the stop outcome is unknown', () => {
      const { task, dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_home')
      db.markWorkerStopUnknown(dispatch.id, 'the execution host did not answer')

      expect(() => db.updateTaskStatus(task.id, 'dispatched')).toThrowError(
        expect.objectContaining({ code: 'task_not_startable' })
      )
      expect(db.getTask(task.id)?.status).toBe('blocked')
    })

    it('control: still accepts dispatched for an active Dispatch with no supervised worker', () => {
      const task = db.createTask({ spec: 'unsupervised work' })
      createRootDispatch(db, task.id, 'term_worker')

      expect(db.updateTaskStatus(task.id, 'dispatched')?.status).toBe('dispatched')
    })

    it('control: still accepts dispatched while the supervised worker is ready', () => {
      const { task } = localWorker()

      expect(db.updateTaskStatus(task.id, 'dispatched')?.status).toBe('dispatched')
    })
  })

  describe('a worker report the lifecycle graph cannot settle', () => {
    // Rows an older binary already wrote: it let task-update re-open the Task under a stopping
    // worker, so a shipped database can hold this triple even though nothing can reach it now.
    function wedgeTaskDispatchedUnderStoppingWorker(taskId: string, dispatchId: string): void {
      db.beginWorkerStop(dispatchId, 'epoch_home')
      db.db.prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ?").run(taskId)
    }

    it('rejects the federated report and still advances the relay cursor', () => {
      const { task, dispatch } = federatedWorker()
      wedgeTaskDispatchedUnderStoppingWorker(task.id, dispatch.id)

      const imported = db.importFederatedRelayItem(
        relayItem(task.id, task.run_id, dispatch.id, 1, 'done')
      )

      expect(imported.lifecycle).toMatchObject({
        action: 'rejected',
        code: 'worker_not_settleable'
      })
      expect(db.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(1)
      expect(db.getMessageById('msg_1')).toBeDefined()
      // The stream is not wedged behind the report it could not apply.
      expect(
        db.importFederatedRelayItem(relayItem(task.id, task.run_id, dispatch.id, 2, 'status'))
          .message.id
      ).toBe('msg_2')
      expect(db.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(2)
    })

    it('rejects the local report instead of throwing out of reconciliation', () => {
      const { task, dispatch } = localWorker()
      wedgeTaskDispatchedUnderStoppingWorker(task.id, dispatch.id)
      const msg = workerDoneMessage(task.id, task.run_id, dispatch.id)

      expect(reconcileLifecycleMessage(db, msg)).toMatchObject({
        action: 'rejected',
        code: 'worker_not_settleable'
      })
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopping')
    })

    it('lets the coordinator loop finish its batch and mark the report read', async () => {
      const { task, dispatch } = localWorker()
      wedgeTaskDispatchedUnderStoppingWorker(task.id, dispatch.id)
      workerDoneMessage(task.id, task.run_id, dispatch.id)
      const coordinator = new Coordinator(db, stubCoordinatorRuntime(), {
        spec: 'stop-wedge',
        coordinatorHandle: `run:${task.run_id}`,
        pollIntervalMs: 0,
        onLog: (line) => {
          if (line.includes('rejected')) {
            coordinator.stop()
          }
        }
      })

      const run = await coordinator.runFromExistingRun(task.run_id)

      expect(run.failedTasks).toEqual([])
      expect(db.getUnreadMessages(`run:${task.run_id}`)).toEqual([])
    })

    // The graph accepts stopping -> failed, so this report is the other half of the guard: it
    // must settle from the state the worker is actually in. A hardcoded `ready` precondition
    // throws here and wedges the very relay batch the success case proves is safe.
    it('settles a failed report the graph does accept from a stopping worker', () => {
      const { task, dispatch } = federatedWorker()
      wedgeTaskDispatchedUnderStoppingWorker(task.id, dispatch.id)

      const imported = db.importFederatedRelayItem(
        relayItem(task.id, task.run_id, dispatch.id, 1, 'done', 'failed')
      )

      expect(imported.lifecycle).toMatchObject({ action: 'settled', outcome: 'failed' })
      expect(db.getFederatedDispatch(dispatch.id)?.to_home_imported_sequence).toBe(1)
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('failed')
      expect(db.getTask(task.id)?.status).toBe('failed')
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('failed')
    })

    it('control: a ready worker still settles its Task', () => {
      const { task, dispatch } = localWorker()

      expect(
        db.settleWorkerReport({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded',
          result: 'done'
        })
      ).toMatchObject({ action: 'settled', outcome: 'succeeded' })
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('succeeded')
    })
  })

  describe('operator escape', () => {
    it('accepts a re-issued worker-stop and reaches an honest stop_unknown outcome', () => {
      const { task, dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_dead_runtime')

      // The runtime that owned the first stop died mid-flight; the re-issue is the way out.
      const reissued = db.beginWorkerStop(dispatch.id, 'epoch_new_runtime')
      expect(reissued).toMatchObject({ disposition: 'stopping' })
      expect(db.getWorkerDispatch(dispatch.id)?.runtime_epoch).toBe('epoch_new_runtime')

      db.markWorkerStopUnknown(dispatch.id, 'the execution host did not answer')
      expect(db.abandonWorkerDispatch(dispatch.id)).toMatchObject({ disposition: 'abandoned' })
      expect(db.getTask(task.id)?.status).toBe('blocked')
    })

    it('refuses a re-issue from the runtime whose own stop is still in flight', () => {
      const { dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_this_runtime')

      // The terminal is closing and its exit event has not landed yet. Letting this second pass
      // record stop_unknown would make the exit read as a crash instead of this stop succeeding.
      expect(() => db.beginWorkerStop(dispatch.id, 'epoch_this_runtime')).toThrowError(
        /cannot stop from stopping/
      )

      // The row is still the one the exit path claims a clean stop from: stopping, same epoch.
      expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'stopping',
        runtime_epoch: 'epoch_this_runtime'
      })
      expect(db.settleWorkerStop(dispatch.id).state).toBe('stopped')
      expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
        status: 'failed',
        last_failure: 'stopped'
      })
    })
  })

  function workerDoneMessage(taskId: string, runId: string, dispatchId: string) {
    return db.insertMessage({
      runId,
      from: 'term_w',
      to: `run:${runId}`,
      subject: 'Worker done',
      body: 'finished the work',
      type: 'worker_done',
      priority: 'normal',
      senderPaneKey: PANE_W,
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    })
  }
})

/** The coordinator's message sweep touches none of these; a dispatched Task creates no worker. */
function stubCoordinatorRuntime(): CoordinatorRuntime {
  return {
    sendTerminalAgentPrompt: async () => ({}),
    listTerminals: async () => ({ terminals: [] }),
    createTerminal: async () => ({ handle: 'term_unused', worktreeId: 'wt' }),
    waitForTerminal: async (handle: string) => ({ handle, condition: 'idle' }),
    probeWorktreeDrift: async () => null
  }
}
