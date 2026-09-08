import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { readWorkspaceSessionResumeFences } from '../../../../shared/workspace-session-resume-fences'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolvePersistedStablePaneOwner, resolveStablePaneOwner } from './stable-owner'
import { StablePaneResumeBlockedError } from './stable-pane-resume-fence'

export function assertPtyHibernationAllowed(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  ptyId: string,
  connectionId: string | null | undefined
): void {
  const session = store?.getWorkspaceSession?.(
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
  if (!session) {
    return
  }
  for (const paneKey of Object.keys(readWorkspaceSessionResumeFences(session))) {
    const tabId = parsePaneKey(paneKey)?.tabId
    const worktreeId =
      session?.sleepingAgentSessionsByPaneKey?.[paneKey]?.worktreeId ??
      Object.entries(session?.tabsByWorktree ?? {}).find(([, tabs]) =>
        tabs.some((tab) => tab.id === tabId)
      )?.[0]
    if (!worktreeId) {
      continue
    }
    // Resolve independently: a stale persisted binding must not hide the live owner.
    const current = resolveStablePaneOwner(runtime, undefined, paneKey, worktreeId, connectionId)
    const persisted = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
    if (current?.ptyId === ptyId || persisted?.ptyId === ptyId) {
      throw new StablePaneResumeBlockedError('agent_hibernation_automatic_resume_blocked')
    }
  }
}
