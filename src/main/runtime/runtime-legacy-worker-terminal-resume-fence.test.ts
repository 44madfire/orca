import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'
import { ORCHESTRATION_METHODS } from './rpc/methods/orchestration'
import { RuntimeLegacyWorkerTerminalRecoveryPersistence } from './runtime-legacy-worker-terminal-recovery-persistence'
import type { RuntimeStore } from './runtime-store-contract'

const PANE_KEY = 'tab_worker:33333333-3333-4333-8333-333333333333'
const WORKTREE_ID = 'repo::worktree'

function sessionWithSleepingWorker(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: 'tab_worker',
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'codex-session-1' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  } as WorkspaceSessionState
}

describe('settled worker automatic-resume fence persistence', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  function harness(
    onFencesChanged?: () => void,
    /** False models a worker that settles while its tab is still open: no sleeping record. */
    withSleepingRecord = true
  ): {
    db: OrchestrationDb
    taskId: string
    dispatchId: string
    persistence: RuntimeLegacyWorkerTerminalRecoveryPersistence
    fences: () => Record<string, true>
    recordFlag: () => string | undefined
  } {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    let session = withSleepingRecord
      ? sessionWithSleepingWorker()
      : (getDefaultWorkspaceSession() as WorkspaceSessionState)
    const store = {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      flushOrThrow: vi.fn()
    } as unknown as RuntimeStore
    const task = orchestrationDb.createTask({ spec: 'fence me' })
    const started = orchestrationDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    orchestrationDb.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    orchestrationDb.markWorkerDispatchReady(started.dispatch.id)
    return {
      db: orchestrationDb,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      persistence: new RuntimeLegacyWorkerTerminalRecoveryPersistence(
        () => store,
        () => orchestrationDb,
        () => LOCAL_EXECUTION_HOST_ID,
        onFencesChanged
      ),
      fences: () => session.legacyWorkerResumeFencesByPaneKey ?? {},
      recordFlag: () => session.sleepingAgentSessionsByPaneKey?.[PANE_KEY]?.automaticResumeBlockedBy
    }
  }

  function settle(d: OrchestrationDb, taskId: string, dispatchId: string): void {
    expect(
      d.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' }).action
    ).toBe('settled')
  }

  // The STA-4577 repro: worker_done, no release, restart, open the worktree — the pane still holds
  // a resumable provider session and must not respawn `codex resume`.
  it('fences a settled worker pane whose terminal was never released', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()

    expect(h.fences()).toEqual({ [PANE_KEY]: true })
  })

  // A pane with no sleeping record is the whole reason the fence cannot live on the record.
  it('fences a pane that has no sleeping record to hang a flag on', () => {
    const h = harness(undefined, false)
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()

    expect(h.fences()).toEqual({ [PANE_KEY]: true })
  })

  // Main never writes the record flag: it is the renderer's outbound projection for old clients.
  it('leaves the sleeping record untouched', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()

    expect(h.recordFlag()).toBeUndefined()
  })

  // Level-triggered: every pass writes the whole set, so there is no announcement to consume and
  // no bookkeeping to keep in step. A renderer that reloads simply reads the field again.
  it('rewrites the same set on every pass', () => {
    const h = harness(undefined, false)
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()
    h.persistence.prepare()

    expect(h.fences()).toEqual({ [PANE_KEY]: true })
  })

  it('lifts the fence once release retires the terminal resource', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fences()).toEqual({ [PANE_KEY]: true })

    const requested = h.db.requestWorkerTerminalRelease(h.dispatchId)
    expect(requested.disposition).toBe('requested')
    h.db.settleWorkerTerminalRelease((requested as { resource: { id: string } }).resource.id)
    h.persistence.prepare()

    expect(h.fences()).toEqual({})
  })

  // A pane with no record is retired the same way, because the set is rewritten whole rather than
  // swept out of the records that happen to exist.
  it('lifts a record-less fence on release', () => {
    const h = harness(undefined, false)
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fences()).toEqual({ [PANE_KEY]: true })

    const requested = h.db.requestWorkerTerminalRelease(h.dispatchId)
    h.db.settleWorkerTerminalRelease((requested as { resource: { id: string } }).resource.id)
    h.persistence.prepare()

    expect(h.fences()).toEqual({})
  })

  it('lifts the fence when the user takes the pane over', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fences()).toEqual({ [PANE_KEY]: true })

    expect(h.db.markWorkerTerminalUserOwned(PANE_KEY)).toBe(1)
    h.persistence.prepare()

    expect(h.fences()).toEqual({})
  })

  // An unreadable plan is not evidence a pane stopped needing its fence.
  it('keeps the fence when the recovery plan cannot be read', () => {
    const h = harness()
    settle(h.db, h.taskId, h.dispatchId)
    h.persistence.prepare()
    expect(h.fences()).toEqual({ [PANE_KEY]: true })

    vi.spyOn(h.db, 'listLegacyWorkerTerminalRecoveryRows').mockImplementation(() => {
      throw new Error('orchestration_db_unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(h.persistence.prepare()).toEqual({
        blockedPanes: [],
        candidates: [],
        ambiguousDispatchIds: []
      })
    } finally {
      warn.mockRestore()
    }

    expect(h.fences()).toEqual({ [PANE_KEY]: true })
  })

  // A failed write publishes nothing and pins nothing: the next pass rewrites the same level.
  it('recovers from a failed session write on the next pass', () => {
    const pings: number[] = []
    let failWrite = true
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    let session = sessionWithSleepingWorker()
    const store = {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        if (failWrite) {
          throw new Error('workspace_session_write_failed')
        }
        session = next
      },
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      flushOrThrow: vi.fn()
    } as unknown as RuntimeStore
    const task = orchestrationDb.createTask({ spec: 'fence me' })
    const started = orchestrationDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    orchestrationDb.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    orchestrationDb.markWorkerDispatchReady(started.dispatch.id)
    settle(orchestrationDb, task.id, started.dispatch.id)
    const persistence = new RuntimeLegacyWorkerTerminalRecoveryPersistence(
      () => store,
      () => orchestrationDb,
      () => LOCAL_EXECUTION_HOST_ID,
      () => pings.push(1)
    )

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      persistence.prepare()
    } finally {
      warn.mockRestore()
    }
    expect(session.legacyWorkerResumeFencesByPaneKey).toBeUndefined()
    expect(pings).toEqual([])

    failWrite = false
    persistence.prepare()

    expect(session.legacyWorkerResumeFencesByPaneKey).toEqual({ [PANE_KEY]: true })
    expect(pings).toEqual([1])
  })

  // The ping is invalidation only, and an unchanged level must not wake every session subscriber.
  it('pings only when the set actually changes', () => {
    const pings: number[] = []
    const h = harness(() => pings.push(1))
    settle(h.db, h.taskId, h.dispatchId)

    h.persistence.prepare()
    h.persistence.prepare()

    expect(pings).toEqual([1])
  })

  // A live worker's pane is fenced while main reconciles it against PTY inventory; the settled arm
  // must not disturb that, and the plan must still name it as unsettled.
  it('keeps a live worker pane fenced and marked unsettled', () => {
    const h = harness()

    const plan = h.persistence.prepare()

    expect(h.fences()).toEqual({ [PANE_KEY]: true })
    expect(plan.blockedPanes).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, settled: false })
    ])
    expect(plan.candidates).toEqual([expect.objectContaining({ dispatchId: h.dispatchId })])
  })
})

// STA-4577's other half: settlement with no release and no restart. The stamp only ran at startup
// and after release/retain/takeover, so reopening the pane in the same session respawned the agent.
describe('worker_done without a release', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('fences the pane in the same session', async () => {
    const orchestrationDb = new OrchestrationDb(':memory:')
    db = orchestrationDb
    let session = sessionWithSleepingWorker()
    const store = {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      flushOrThrow: vi.fn()
    } as unknown as RuntimeStore
    const runtime = new OrcaRuntimeService(store)
    runtime.setOrchestrationDb(orchestrationDb)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_worker' ? PANE_KEY : 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime:pty:1')
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    const run = orchestrationDb.createRun({
      objective: 'settle without release',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = orchestrationDb.createTask({ spec: 'settle without release', runId: run.id })
    const started = orchestrationDb.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    orchestrationDb.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1',
      worktreeId: WORKTREE_ID,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    orchestrationDb.markWorkerDispatchReady(started.dispatch.id)
    const capability = orchestrationDb.mintDispatchCapability({
      dispatchId: started.dispatch.id,
      paneKey: PANE_KEY,
      processIncarnation: 'runtime:pty:1'
    })
    expect(session.legacyWorkerResumeFencesByPaneKey).toBeUndefined()

    const send = ORCHESTRATION_METHODS.find((method) => method.name === 'orchestration.send')!
    await send.handler(
      send.params!.parse({
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: started.dispatch.id,
          outcome: 'succeeded'
        })
      }),
      { runtime, orchestrationCapability: capability }
    )

    expect(orchestrationDb.getWorkerDispatch(started.dispatch.id)?.state).toBe('succeeded')
    expect(session.legacyWorkerResumeFencesByPaneKey).toEqual({ [PANE_KEY]: true })
  })
})
