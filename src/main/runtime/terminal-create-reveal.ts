import type { RuntimeTerminalCreate, RuntimeTerminalPresentation } from '../../shared/runtime-types'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { RuntimeNotifier } from './runtime-notifier-contract'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { createTerminalRevealWarning, ownerSurfacing } from './orca-runtime-core'

export async function revealCreatedTerminal(args: {
  notifier?: RuntimeNotifier | null
  worktreeId: string
  workspacePath: string
  handle: string
  ptyId: string
  tabId: string
  leafId: string
  cwd: string
  presentation: RuntimeTerminalPresentation | undefined
  launchOpts: TerminalCreateOptions
  launchConfig?: SleepingAgentLaunchConfig | null
  launchToken?: string
  surfaceOwner?: boolean
}): Promise<Pick<RuntimeTerminalCreate, 'surface' | 'warning'>> {
  if (args.presentation === 'background') {
    return { surface: 'background' }
  }
  if (!args.notifier?.revealTerminalSession) {
    return { surface: 'background', warning: createTerminalRevealWarning(args.handle) }
  }
  try {
    await args.notifier.revealTerminalSession(args.worktreeId, {
      ptyId: args.ptyId,
      title: args.launchOpts.title ?? null,
      ...(args.cwd !== args.workspacePath ? { cwd: args.cwd } : {}),
      ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
      ...(args.launchToken ? { launchToken: args.launchToken } : {}),
      ...(args.launchOpts.launchAgent ? { launchAgent: args.launchOpts.launchAgent } : {}),
      ...(args.launchOpts.viewMode ? { viewMode: args.launchOpts.viewMode } : {}),
      activate: args.presentation === 'focused',
      ...(args.presentation ? { presentation: args.presentation } : {}),
      ...ownerSurfacing(args.surfaceOwner !== false),
      tabId: args.tabId,
      leafId: args.leafId
    })
    return { surface: 'visible' }
  } catch (error) {
    console.warn(`[terminal-create] failed to create inactive tab for ${args.ptyId}:`, error)
    return { surface: 'background', warning: createTerminalRevealWarning(args.handle, error) }
  }
}
