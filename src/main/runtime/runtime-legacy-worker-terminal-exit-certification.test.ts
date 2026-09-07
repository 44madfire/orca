import { describe, expect, it, vi } from 'vitest'
import { reconcileLegacyWorkerCandidate } from './runtime-legacy-worker-terminal-recovery-candidate'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'

const CONNECTION_ID = 'conn-1'
// A parseable SSH id, so the population this suite reasons about is the one it drives.
const PTY_ID = toAppSshPtyId(CONNECTION_ID, 'pty-42')
const OTHER_PTY_ID = toAppSshPtyId(CONNECTION_ID, 'pty-43')

const candidate = {
  dispatchId: 'dispatch_1',
  dispatchStatus: 'dispatched',
  contractVersion: 3,
  taskId: 'task_1',
  worktreeId: 'repo::worktree',
  terminalHandle: 'term_worker',
  paneKey: 'tab_a:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  tabId: 'tab_a',
  leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  processIncarnation: `${PTY_ID}:inc-1`,
  ptyId: PTY_ID,
  incarnationId: 'inc-1'
} as unknown as LegacyWorkerRecoveryCandidate

function inventory(options: {
  ptyIds: string[]
  identity?: { handle: string; incarnationId: string }
}): LegacyWorkerRecoveryInventory {
  return {
    livePtyIds: new Set(options.ptyIds),
    allLivePtyIds: new Set(options.ptyIds),
    terminalIdentityByPtyId: new Map(options.identity ? [[PTY_ID, options.identity]] : []),
    queriedHostIds: new Set(['ssh:conn-1'])
  } as unknown as LegacyWorkerRecoveryInventory
}

const listingWithoutThePty = inventory({ ptyIds: [OTHER_PTY_ID] })
const listingWithThePty = inventory({
  ptyIds: [PTY_ID],
  identity: { handle: 'term_worker', incarnationId: 'inc-1' }
})

function reconcile(options: {
  inventory: LegacyWorkerRecoveryInventory
  isPtyProvenAbsent: () => Promise<boolean>
  refreshInventory?: LegacyWorkerRecoveryPorts['refreshInventory']
}) {
  const pendingResolutions: LegacyWorkerRecoveryResolution[] = []
  const deferredDispatchIds = new Set<string>()
  const onPtyExit = vi.fn()
  const ports = {
    refreshInventory: options.refreshInventory ?? vi.fn(async () => options.inventory),
    runMutation: async <T>(_worktreeId: string, operation: () => Promise<T>) => operation(),
    isPtyProvenAbsent: vi.fn(options.isPtyProvenAbsent),
    hasExactPersistedSurface: () => true,
    hasExactSurface: () => true,
    adopt: vi.fn(),
    getRendererEpoch: () => 1,
    reveal: vi.fn(),
    onPtyExit,
    getActivation: () => ({})
  } as unknown as LegacyWorkerRecoveryPorts

  return reconcileLegacyWorkerCandidate({
    controller: { hasReceipt: () => true, setReceipt: vi.fn(), deleteReceipt: vi.fn() } as never,
    ports,
    options: { connectionId: 'conn-1' },
    candidate,
    workspace: { scope: { connectionId: 'conn-1' }, resolved: { id: 'repo::worktree' } } as never,
    resolvedWorktrees: [],
    inventory: options.inventory,
    deferredDispatchIds,
    pendingResolutions
  }).then(() => ({ pendingResolutions, deferredDispatchIds, ports, onPtyExit }))
}

describe('legacy worker recovery: certifying that a worker PTY exited', () => {
  it('defers when a listing omits the PTY and no owner proved it absent', async () => {
    const { pendingResolutions, deferredDispatchIds, ports } = await reconcile({
      inventory: listingWithoutThePty,
      isPtyProvenAbsent: async () => false
    })

    // Abandoning the worker here would dispatch the same Task twice while its agent still runs.
    expect(pendingResolutions).toEqual([])
    expect([...deferredDispatchIds]).toEqual(['dispatch_1'])
    expect(ports.isPtyProvenAbsent).toHaveBeenCalledWith(PTY_ID)
  })

  it('certifies the exit once the owning provider answers absent', async () => {
    const { pendingResolutions, deferredDispatchIds } = await reconcile({
      inventory: listingWithoutThePty,
      isPtyProvenAbsent: async () => true
    })

    expect(pendingResolutions).toEqual([{ candidate, resolution: 'exited' }])
    expect(deferredDispatchIds.size).toBe(0)
  })

  it('defers when the pre-adoption refresh loses the PTY without an absence proof', async () => {
    // A relay that restarts between the plan's inventory and the adoption re-list omits every id
    // the previous one minted; adopting or retiring on that omission is the same unsound step.
    const refreshInventory = vi.fn().mockResolvedValue(listingWithoutThePty)
    const { pendingResolutions, deferredDispatchIds, ports, onPtyExit } = await reconcile({
      inventory: listingWithThePty,
      isPtyProvenAbsent: async () => false,
      refreshInventory: refreshInventory as never
    })

    expect(pendingResolutions).toEqual([])
    expect([...deferredDispatchIds]).toEqual(['dispatch_1'])
    expect(ports.adopt).not.toHaveBeenCalled()
    expect(onPtyExit).not.toHaveBeenCalled()
  })

  it('defers when the PTY leaves the listing after adoption without an absence proof', async () => {
    const refreshInventory = vi
      .fn()
      .mockResolvedValueOnce(listingWithThePty)
      .mockResolvedValueOnce(listingWithoutThePty)
    const { pendingResolutions, deferredDispatchIds, onPtyExit } = await reconcile({
      inventory: listingWithThePty,
      isPtyProvenAbsent: async () => false,
      refreshInventory: refreshInventory as never
    })

    expect(pendingResolutions).toEqual([])
    expect([...deferredDispatchIds]).toEqual(['dispatch_1'])
    expect(onPtyExit).not.toHaveBeenCalled()
  })

  it('control: still certifies the exit when the listed PTY carries another process', async () => {
    const { pendingResolutions, ports } = await reconcile({
      inventory: inventory({
        ptyIds: [PTY_ID],
        identity: { handle: 'term_worker', incarnationId: 'inc-2' }
      }),
      isPtyProvenAbsent: async () => false
    })

    // A different incarnation on the id is a positive observation, not an omission.
    expect(pendingResolutions).toEqual([{ candidate, resolution: 'exited' }])
    expect(ports.isPtyProvenAbsent).not.toHaveBeenCalled()
  })

  // No SSH provider implements the owner readback, so `isPtyProvenAbsent` is false for every SSH
  // candidate and the worker defers forever rather than being retired on a listing omission. That
  // is the honest verdict under the execution boundary and the deliberate cost of this change: the
  // operator clears such a worker with worker-stop, stop_unknown, then worker-abandon.
  it('defers an SSH candidate no owner can certify', async () => {
    const { pendingResolutions, deferredDispatchIds } = await reconcile({
      inventory: listingWithoutThePty,
      isPtyProvenAbsent: async () => false
    })

    expect(pendingResolutions).toEqual([])
    expect([...deferredDispatchIds]).toEqual(['dispatch_1'])
  })

  it('control: still adopts a PTY the listing names with the recorded identity', async () => {
    const { pendingResolutions, deferredDispatchIds, ports } = await reconcile({
      inventory: listingWithThePty,
      isPtyProvenAbsent: async () => true
    })

    expect(pendingResolutions).toEqual([{ candidate, resolution: 'adopted' }])
    expect(deferredDispatchIds.size).toBe(0)
    expect(ports.isPtyProvenAbsent).not.toHaveBeenCalled()
  })
})
