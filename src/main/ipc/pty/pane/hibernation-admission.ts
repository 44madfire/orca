import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { ptyOwnership } from '../provider/ownership-state'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { readWorkspaceSessionResumeFences } from '../../../../shared/workspace-session-resume-fences'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { resolvePersistedStablePaneOwner } from './stable-owner'
import { StablePaneResumeBlockedError } from './stable-pane-resume-fence'

export function assertPtyHibernationAllowed(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  ptyId: string,
  connectionId: string | null | undefined
): void {
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const session = store?.getWorkspaceSession?.(hostId)
  if (!session) {
    return
  }
  for (const paneKey of Object.keys(readWorkspaceSessionResumeFences(session))) {
    try {
      const current = runtime?.resolveTerminalPane?.(paneKey)
      if (current?.ptyId === ptyId) {
        const ownerConnection = ptyOwnership.get(ptyId) ?? parseAppSshPtyId(ptyId)?.connectionId
        const ownerHost =
          current.executionHostId ??
          (ownerConnection ? toSshExecutionHostId(ownerConnection) : LOCAL_EXECUTION_HOST_ID)
        if (ownerHost !== (hostId ?? LOCAL_EXECUTION_HOST_ID)) {
          throw new Error('terminal_pane_owner_host_mismatch')
        }
        throw new StablePaneResumeBlockedError('agent_hibernation_automatic_resume_blocked')
      }
    } catch (error) {
      if (!(error instanceof Error && error.message === 'terminal_not_found')) {
        throw error
      }
    }
    const tabId = parsePaneKey(paneKey)?.tabId
    const worktreeId =
      session?.sleepingAgentSessionsByPaneKey?.[paneKey]?.worktreeId ??
      Object.entries(session?.tabsByWorktree ?? {}).find(([, tabs]) =>
        tabs.some((tab) => tab.id === tabId)
      )?.[0]
    if (!worktreeId) {
      continue
    }
    const persisted = resolvePersistedStablePaneOwner(store, paneKey, worktreeId, connectionId)
    if (persisted?.ptyId === ptyId) {
      throw new StablePaneResumeBlockedError('agent_hibernation_automatic_resume_blocked')
    }
  }
}
