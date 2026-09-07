import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const PANE = 'tab_w:11111111-1111-4111-8111-111111111111'

/**
 * A worker report arrives inside a federated relay import and inside the coordinator's message
 * sweep, and a throw rolls both back — the relay cursor never advances again and the run is
 * marked failed with its batch unread (#16904). So `settleWorkerReport` must answer every
 * reachable (Dispatch, Task, worker) triple with a settlement or a structured rejection.
 *
 * The search drives the real public operations and memoizes on the resulting triple, so it stays
 * a state-space proof rather than a list of cases someone remembered to write down.
 */
const OPERATIONS = [
  'prepareAuthority',
  'markReady',
  'markStartUnknown',
  'failStart',
  'beginStop',
  'settleStop',
  'markStopUnknown',
  'resumeFedRelay',
  'abandon',
  'reconcileMissing',
  'fedStart:ready',
  'fedStart:start_unknown',
  'fedStart:failed',
  'fedStart:stopped',
  'fedStop',
  'failDispatch',
  'failDispatch:exited',
  'completeDispatch',
  'taskUpdate:ready',
  'taskUpdate:blocked',
  'taskUpdate:dispatched',
  'taskUpdate:completed',
  'taskUpdate:failed',
  'mintCap',
  'revokeCap',
  'report:succeeded',
  'report:failed'
] as const

type Probe = {
  db: OrchestrationDb
  taskId: string
  dispatchId: string
}

function replay(sequence: readonly string[]): Probe {
  const db = new OrchestrationDb(':memory:')
  const task = db.createTask({ spec: 'state space' })
  const { dispatch } = db.createStartingWorkerDispatch({
    taskId: task.id,
    startOptions: {},
    creator: { kind: 'system' },
    maxDepth: 99,
    federation: {
      environmentId: 'e',
      environmentName: 'n',
      peerFingerprint: 'p',
      protocolVersion: 12
    }
  })
  const id = dispatch.id
  const apply = (name: string): void => {
    switch (name) {
      case 'prepareAuthority':
        db.prepareStartingWorkerAuthority({
          dispatchId: id,
          handle: 'term_w',
          paneKey: PANE,
          processIncarnation: 'inc1',
          worktreeId: 'wt',
          effects: [],
          setupState: 'not_configured'
        })
        return
      case 'markReady':
        db.markWorkerDispatchReady(id)
        return
      case 'markStartUnknown':
        db.markWorkerStartUnknown(id, 's', 'w')
        return
      case 'failStart':
        db.failWorkerStart(id, 's', 'w')
        return
      case 'beginStop':
        db.beginWorkerStop(id, 'ep')
        return
      case 'settleStop':
        db.settleWorkerStop(id)
        return
      case 'markStopUnknown':
        db.markWorkerStopUnknown(id, 'w')
        return
      case 'resumeFedRelay':
        db.resumeFederatedWorkerForTerminalRelay(id)
        return
      case 'abandon':
        db.abandonWorkerDispatch(id)
        return
      case 'reconcileMissing':
        db.reconcileMissingWorkerTerminal(id, 'gone')
        return
      case 'fedStart:ready':
        db.reconcileFederatedWorkerStart({ dispatchId: id, state: 'ready', stage: 's' })
        return
      case 'fedStart:start_unknown':
        db.reconcileFederatedWorkerStart({ dispatchId: id, state: 'start_unknown', stage: 's' })
        return
      case 'fedStart:failed':
        db.reconcileFederatedWorkerStart({ dispatchId: id, state: 'failed', stage: 's' })
        return
      case 'fedStart:stopped':
        db.reconcileFederatedWorkerStart({ dispatchId: id, state: 'stopped', stage: 's' })
        return
      case 'fedStop':
        db.reconcileFederatedWorkerStop(id)
        return
      case 'failDispatch':
        db.failDispatch(id, 'x')
        return
      case 'failDispatch:exited':
        db.failDispatch(id, 'x', { workerProcessExited: true })
        return
      case 'completeDispatch':
        db.completeDispatch(id)
        return
      case 'taskUpdate:ready':
        db.updateTaskStatus(task.id, 'ready')
        return
      case 'taskUpdate:blocked':
        db.updateTaskStatus(task.id, 'blocked')
        return
      case 'taskUpdate:dispatched':
        db.updateTaskStatus(task.id, 'dispatched')
        return
      case 'taskUpdate:completed':
        db.updateTaskStatus(task.id, 'completed', 'r')
        return
      case 'taskUpdate:failed':
        db.updateTaskStatus(task.id, 'failed', 'r')
        return
      case 'mintCap':
        db.mintDispatchCapability({ dispatchId: id, paneKey: PANE, processIncarnation: 'inc2' })
        return
      case 'revokeCap':
        db.revokeDispatchCapability(id)
        return
      case 'report:succeeded':
        db.settleWorkerReport({
          taskId: task.id,
          dispatchId: id,
          outcome: 'succeeded',
          result: 'r'
        })
        return
      case 'report:failed':
        db.settleWorkerReport({ taskId: task.id, dispatchId: id, outcome: 'failed', result: 'r' })
    }
  }
  for (const name of sequence) {
    try {
      apply(name)
    } catch {
      // A refused operation is a legal outcome; the state it did not reach is simply not explored.
    }
  }
  return { db, taskId: task.id, dispatchId: id }
}

function tripleOf(probe: Probe): string {
  const dispatch = probe.db.getDispatchContextById(probe.dispatchId)
  const task = probe.db.getTask(probe.taskId)
  const worker = probe.db.getWorkerDispatch(probe.dispatchId)
  return `${dispatch?.status}/${task?.status}/${worker?.state}`
}

function reachableTriples(maxDepth: number): Map<string, string[]> {
  const seen = new Map<string, string[]>()
  const initial = replay([])
  seen.set(tripleOf(initial), [])
  initial.db.close()
  let frontier: string[][] = [[]]
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: string[][] = []
    for (const sequence of frontier) {
      for (const operation of OPERATIONS) {
        const probe = replay([...sequence, operation])
        const triple = tripleOf(probe)
        probe.db.close()
        if (seen.has(triple)) {
          continue
        }
        seen.set(triple, [...sequence, operation])
        next.push([...sequence, operation])
      }
    }
    frontier = next
  }
  return seen
}

describe('worker report settlement over the reachable lifecycle state space', () => {
  it('answers every reachable state without throwing', () => {
    // Five is where the triple set saturates: a sixth round of all 27 operations adds none.
    const reachable = reachableTriples(5)
    const throwing: string[] = []

    for (const [triple, sequence] of reachable) {
      for (const outcome of ['succeeded', 'failed'] as const) {
        const probe = replay(sequence)
        try {
          const settlement = probe.db.settleWorkerReport({
            taskId: probe.taskId,
            dispatchId: probe.dispatchId,
            outcome,
            result: 'r'
          })
          expect(settlement.action === 'settled' || settlement.action === 'rejected').toBe(true)
        } catch (error) {
          throwing.push(
            `${triple}/${outcome} after ${sequence.join(' -> ') || '(initial)'}: ${(error as Error).message}`
          )
        } finally {
          probe.db.close()
        }
      }
    }

    expect(throwing).toEqual([])
    // Guards the search itself: a harness that stopped exploring would also report zero throws.
    expect(reachable.size).toBeGreaterThan(50)
  }, 300_000)
})
