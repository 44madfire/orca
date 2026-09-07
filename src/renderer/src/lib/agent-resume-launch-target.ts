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
  /** The resume argv this quoting is for. Only consulted for the cold-restore
   *  race guess below; omit it and the guess never fires. */
  resumeArgv?: readonly string[] | null
  /** The raw agentArgs suffix the built command will tokenize and `^`-escape
   *  per token (unless a custom agentCommand supersedes them, in which case pass
   *  null). The race-guess gate tokenizes it the same way and vets each token,
   *  so a cmd guess can never `^`-corrupt an agentArg token in a PowerShell race
   *  pane — including an INTERIOR token ending in `\`, which a whole-string
   *  check would miss. */
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
  // Cold-restore race guess (#12320): a resume typed right after restart can run
  // before the renderer store hydrates `settings`, so terminalWindowsShell is
  // momentarily empty and we can't read which shell main actually spawned — the
  // user's configured shell if set, otherwise the powershell.exe default. We
  // still guess cmd here, but ONLY when every piece of free text the command
  // `^`-escapes is cmd-quote-safe: `"<token>"` then parses identically in cmd
  // AND PowerShell, so a configured cmd.exe pane is fixed (single quotes no
  // longer reach it literally) with no risk to a PowerShell pane. Codex/Claude
  // and every id-based agent qualify (clean flags + UUIDs). A path-carrying
  // token (pi/prime-agent/omp transcript path, or a path in agentArgs, e.g.
  // under `...\dir (x86)\...`) fails the gate and is left on the PowerShell
  // default, because cmd `^`-escaping would corrupt it in a PowerShell race
  // pane — never worse than the pre-guard behavior.
  if (shell === 'powershell' && !effectiveWindowsShell?.trim() && args.resumeArgv) {
    // Vet agentArgs as the command emits them — tokenized with cmd rules and
    // `^`-escaped per token — not as one raw string: the safety of a token
    // ending in `\` (arg-merge in cmd) is positional, so an interior token
    // would slip a whole-string check.
    const agentArgs = args.resumeAgentArgs?.trim()
      ? tokenizeStartupCommand(args.resumeAgentArgs, 'cmd')
      : null
    if (!agentArgs || agentArgs.ok) {
      const guardTokens = [...args.resumeArgv, ...(agentArgs?.tokens ?? [])]
      if (guardTokens.every((token) => isCmdQuotingPowerShellSafe(token))) {
        return { platform, shell: 'cmd' }
      }
    }
  }
  return { platform, shell }
}
