import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { isPaneAutomaticResumeBlocked } from '../../../../shared/terminal-pane-resume-fence'
import type { Store } from '../../../persistence'

export function isStablePaneResumeBlocked(
  store: Store | undefined,
  paneKey: string | null | undefined,
  worktreeId: string | undefined,
  connectionId: string | null | undefined
): boolean {
  if (!paneKey || !worktreeId || !store?.getWorkspaceSession) {
    return false
  }
  return isPaneAutomaticResumeBlocked(
    store.getWorkspaceSession(connectionId ? toSshExecutionHostId(connectionId) : undefined),
    paneKey,
    worktreeId
  )
}

export function isSleepingAgentResumeBlocked(
  store: Store | undefined,
  args: {
    worktreeId?: string
    connectionId?: string | null
    launchAgent?: TuiAgent
    resumeProviderSession?: AgentProviderSessionMetadata
  }
): boolean {
  if (!store?.getWorkspaceSession || !args.worktreeId || !args.resumeProviderSession) {
    return false
  }
  const session = store.getWorkspaceSession(
    args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
  )
  return Object.entries(session?.sleepingAgentSessionsByPaneKey ?? {}).some(
    ([paneKey, record]) =>
      record.worktreeId === args.worktreeId &&
      (!args.launchAgent || record.agent === args.launchAgent) &&
      agentProviderSessionsEqual(
        record.agent,
        record.providerSession,
        args.resumeProviderSession
      ) &&
      isPaneAutomaticResumeBlocked(session, paneKey, args.worktreeId)
  )
}

export class StablePaneResumeBlockedError extends Error {}
