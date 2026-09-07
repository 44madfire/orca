import type { AgentStartupShell } from './tui-agent-startup-shell'

export const WINDOWS_GIT_BASH_SHELL = 'git-bash'

export type BuiltInWindowsTerminalShell =
  | 'powershell.exe'
  | 'cmd.exe'
  | 'wsl.exe'
  | typeof WINDOWS_GIT_BASH_SHELL

/**
 * Classifies a configured `terminalWindowsShell` value into the startup-shell
 * family used to quote queued commands. Git Bash / wsl.exe run a POSIX shell;
 * cmd.exe needs cmd quoting; everything else (PowerShell, pwsh, unknown) is
 * treated as PowerShell, matching the Windows default.
 */
export function resolveWindowsShellStartupFamily(
  shell: string | null | undefined
): AgentStartupShell {
  const trimmed = shell?.trim()
  if (!trimmed) {
    return 'powershell'
  }
  if (trimmed === WINDOWS_GIT_BASH_SHELL) {
    return 'posix'
  }
  const basename = trimmed.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  if (basename === 'cmd.exe') {
    return 'cmd'
  }
  // Why: wsl.exe and bash.exe (Git for Windows) launch POSIX shells, so queued
  // commands must use POSIX quoting and `cd '<cwd>'` rather than cmd/PowerShell.
  // Extension-less forms reach the same executables through PATHEXT.
  if (
    basename === 'wsl.exe' ||
    basename === 'wsl' ||
    basename === 'bash.exe' ||
    basename === 'bash'
  ) {
    return 'posix'
  }
  return 'powershell'
}

export function resolveLocalWindowsAgentStartupShell(args: {
  platform: NodeJS.Platform
  isRemote: boolean
  terminalWindowsShell?: string | null
}): AgentStartupShell | undefined {
  // Why: terminalWindowsShell describes the local host shell; SSH/remote
  // targets need their own shell signal before we can safely override quoting.
  if (args.platform !== 'win32' || args.isRemote) {
    return undefined
  }
  // Why cmd, not the PowerShell default: with no configured shell the spawn side
  // falls back to %COMSPEC% (cmd.exe) — local-pty-launch-plan.ts and
  // local-pty-session-operations.ts both `... || process.env.COMSPEC || 'powershell.exe'`.
  // A cold restore right after restart can run before the renderer store hydrates
  // `settings`, so terminalWindowsShell is momentarily empty; predicting PowerShell
  // then quotes the resume argv in single quotes that cmd.exe passes through
  // literally, breaking the resume (#12320 residual: codex "unrecognized subcommand
  // ''resume''", claude reads '--dangerously-skip-permissions' as a prompt).
  if (!args.terminalWindowsShell?.trim()) {
    return 'cmd'
  }
  return resolveWindowsShellStartupFamily(args.terminalWindowsShell)
}
