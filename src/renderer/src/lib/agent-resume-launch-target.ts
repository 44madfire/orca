import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  isCmdQuotingPowerShellSafe,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'

export type AgentResumeLaunchTarget = {
  platform: NodeJS.Platform
  /** undefined keeps the platform default: PowerShell on win32, POSIX elsewhere. */
  shell: AgentStartupShell | undefined
  /** Preserve persisted-command parsing when only the quoting style changes. */
  resumeCommandShell?: AgentStartupShell
}

export type AgentResumeLaunchTargetArgs = {
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  /** SSH connection owning the workspace, if any. */
  connectionId: string | null | undefined
  /** Pane/workspace execution owner; only a 'local' host is the one `terminalWindowsShell` describes. */
  executionHostId: string | null
  worktreePath: string | null | undefined
  terminalWindowsShell: string | null | undefined
  /** Per-tab Windows shell override, which beats the global setting at spawn time. */
  tabShellOverride?: string | null
  /** Omit resume argv to disable the fallback for an unknown Windows shell. */
  resumeArgv?: readonly string[] | null
  /** Raw CLI arguments; null when a persisted agentCommand supersedes them. */
  resumeAgentArgs?: string | null
}

function resolveResumeLaunchPlatform(args: AgentResumeLaunchTargetArgs): NodeJS.Platform {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (args.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

/**
 * Platform *and* live shell family a queued agent-resume command must be quoted for.
 * Why the shell half matters: resume lines are typed into a real terminal, so on a
 * cmd.exe tab the win32 PowerShell default sends literal quotes and the agent CLI
 * rejects the resume argv ("unexpected argument ''<uuid>'' found", #12320).
 */
export function resolveAgentResumeLaunchTarget(
  args: AgentResumeLaunchTargetArgs
): AgentResumeLaunchTarget {
  const platform = resolveResumeLaunchPlatform(args)
  const isRemote =
    Boolean(args.connectionId) || parseExecutionHostId(args.executionHostId)?.kind !== 'local'
  const effectiveWindowsShell = resolveWindowsShellOverride(
    args.tabShellOverride,
    args.terminalWindowsShell
  )
  const shell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: effectiveWindowsShell
  })
  // Missing settings must not change argument values or persisted-command parsing.
  if (shell === 'powershell' && !effectiveWindowsShell?.trim() && args.resumeArgv) {
    const cmdArgs = tokenizeStartupCommand(args.resumeAgentArgs?.trim() ?? '', 'cmd')
    const powershellArgs = tokenizeStartupCommand(args.resumeAgentArgs?.trim() ?? '', 'powershell')
    if (
      cmdArgs.ok &&
      powershellArgs.ok &&
      cmdArgs.tokens.length === powershellArgs.tokens.length &&
      cmdArgs.tokens.every((token, index) => token === powershellArgs.tokens[index]) &&
      [...args.resumeArgv, ...cmdArgs.tokens].every(isCmdQuotingPowerShellSafe)
    ) {
      return { platform, shell: 'cmd', resumeCommandShell: shell }
    }
  }
  return { platform, shell }
}
