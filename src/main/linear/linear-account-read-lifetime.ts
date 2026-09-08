import { linearError } from './issue-context-errors'
const reads = new Map<string, Set<AbortController>>()

export function registerLinearAccountRead(workspaceId: string): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  let active = reads.get(workspaceId)
  if (!active) {
    active = new Set()
    reads.set(workspaceId, active)
  }
  active.add(controller)
  let disposed = false
  return {
    signal: controller.signal,
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      active.delete(controller)
      if (active.size === 0 && reads.get(workspaceId) === active) {
        reads.delete(workspaceId)
      }
    }
  }
}

export function invalidateLinearAccountReads(workspaceId: string): void {
  for (const controller of reads.get(workspaceId) ?? []) {
    controller.abort(
      linearError(
        'linear_list_stale_recovery',
        'Linear account changed during the read; restart and reconcile.'
      )
    )
  }
}
