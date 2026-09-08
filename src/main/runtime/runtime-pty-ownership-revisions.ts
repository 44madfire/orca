import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type OwnershipChange = {
  revision: number
  incarnationId: string | null
}
type OwnershipObservation = {
  revision: number
  changes: Map<string, OwnershipChange>
  cleared: boolean
}

// Revisions live only as long as outstanding observations, including removed/new PTY IDs.
export class RuntimePtyOwnershipRevisions {
  private revision = 0
  private observations = new Set<OwnershipObservation>()

  async observe<T>(
    read: () => Promise<T>
  ): Promise<{ observation: OwnershipObservation; result: T }> {
    const observation = this.capture()
    try {
      return { observation, result: await read() }
    } finally {
      this.release(observation)
    }
  }

  private capture(): OwnershipObservation {
    const observation = { revision: this.revision, changes: new Map(), cleared: false }
    this.observations.add(observation)
    return observation
  }

  private release(observation: OwnershipObservation): void {
    this.observations.delete(observation)
  }

  advance(ptyId: string, incarnationId: string | null = null): void {
    const change = { revision: ++this.revision, incarnationId }
    for (const observation of this.observations) {
      observation.changes.set(ptyId, change)
    }
  }

  clear(): void {
    this.revision++
    for (const observation of this.observations) {
      observation.cleared = true
    }
  }

  admits(
    observation: OwnershipObservation,
    sessions: readonly PtyProcessInfo[],
    records: ReadonlyMap<string, RuntimePtyWorktreeRecord>,
    handles: ReadonlyMap<string, string>,
    connectionId?: string | null
  ): boolean {
    if (observation.cleared) {
      return false
    }
    const sessionsById = new Map(sessions.map((session) => [session.id, session]))
    for (const [ptyId, change] of observation.changes) {
      const current = records.get(ptyId)
      if (
        current &&
        connectionId !== undefined &&
        current.connectionId !== connectionId &&
        !sessionsById.has(ptyId)
      ) {
        continue
      }
      const observed = sessionsById.get(ptyId)
      // A newer explicit owner can corroborate a positive reply, never absence or invalidation.
      if (
        change.revision > observation.revision &&
        (!change.incarnationId ||
          !current?.connected ||
          current.incarnationId !== change.incarnationId ||
          observed?.incarnationId !== change.incarnationId ||
          observed.worktreeId !== current.worktreeId ||
          (observed.terminalHandle !== undefined && observed.terminalHandle !== handles.get(ptyId)))
      ) {
        return false
      }
    }
    return true
  }
}
