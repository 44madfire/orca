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
  return {
    signal: controller.signal,
    dispose: () => {
      active.delete(controller)
      if (active.size === 0) {
        reads.delete(workspaceId)
      }
    }
  }
}

export function invalidateLinearAccountReads(workspaceId: string): void {
  for (const controller of reads.get(workspaceId) ?? []) {
    controller.abort(new Error('Linear account changed during the read.'))
  }
}
