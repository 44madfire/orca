import { describe, expect, it, vi } from 'vitest'
import { reconcileLegacyWorkerCandidate } from './runtime-legacy-worker-terminal-recovery-candidate'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'

const PTY_ID = 'app-ssh:conn-1:pty-42'

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

const listingWithoutThePty = inventory({ ptyIds: ['app-ssh:conn-1:pty-other'] })
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
