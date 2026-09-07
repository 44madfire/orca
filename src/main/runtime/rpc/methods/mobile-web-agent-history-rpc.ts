import { z } from 'zod'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { MobileAiVaultResumeLaunch } from '../../../../shared/mobile-ai-vault-resume-launch-plan'
import { isStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import { AI_VAULT_METHODS } from './ai-vault'
import { CLIENT_UI_METHODS } from './client-ui'
import { FOLDER_WORKSPACE_METHODS } from './folder-workspace'
import { REPO_METHODS } from './repo'
import { SESSION_TAB_METHODS } from './session-tabs'
import { TERMINAL_SEND_METHODS } from './terminal/terminal-send-method'
import { WORKTREE_CATALOG_METHODS } from './worktree-catalog-methods'

const RESUME_WORKTREE_LIMIT = 10_000
const AI_VAULT_SESSION_LIMIT = 500

export type MobileWebAgentHistoryWorktree = {
  worktreeId: string
  repoId: string
  path: string
  displayName?: string
  isArchived?: boolean
  workspaceKind?: 'git' | 'folder-workspace'
  hostId?: string
  terminalPlatform?: NodeJS.Platform
  priorWorktreeIds?: readonly string[]
}

const WorktreeList = z.object({ worktrees: z.array(z.unknown()) })
const CreatedTerminal = z.object({ tab: z.object({ terminal: z.string().min(1) }) })
const TerminalSendResult = z.object({ send: z.object({ accepted: z.boolean() }) })

function method(methods: readonly RpcAnyMethod[], name: string) {
  const found = methods.find((entry) => entry.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing method: ${name}`)
  }
  return found
}

const worktreePs = method(WORKTREE_CATALOG_METHODS, 'worktree.ps')
const repoList = method(REPO_METHODS, 'repo.list')
const projectGroupList = method(REPO_METHODS, 'projectGroup.list')
const folderWorkspaceList = method(FOLDER_WORKSPACE_METHODS, 'folderWorkspace.list')
const settingsGet = method(CLIENT_UI_METHODS, 'settings.get')
const listSessions = method(AI_VAULT_METHODS, 'aiVault.listSessions')
const prepareSessionResume = method(AI_VAULT_METHODS, 'aiVault.prepareSessionResume')
const createTerminal = method(SESSION_TAB_METHODS, 'session.tabs.createTerminal')
const terminalSend = method(TERMINAL_SEND_METHODS, 'terminal.send')

/** One place naming every host call the agent-history methods make. */
export function mobileWebAgentHistoryRpc(context: RpcContext) {
  const call = async (entry: ReturnType<typeof method>, params: unknown) =>
    entry.handler(entry.params ? entry.params.parse(params) : (params as never), context)
  return {
    async worktrees(): Promise<MobileWebAgentHistoryWorktree[]> {
      const result = WorktreeList.parse(await call(worktreePs, { limit: RESUME_WORKTREE_LIMIT }))
      return result.worktrees as MobileWebAgentHistoryWorktree[]
    },
    async repos(): Promise<unknown[]> {
      return listOf(await call(repoList, null), 'repos')
    },
    async projectGroups(): Promise<unknown[]> {
      return listOf(await call(projectGroupList, null), 'groups')
    },
    async folderWorkspaces(): Promise<unknown[]> {
      return listOf(await call(folderWorkspaceList, null), 'folderWorkspaces')
    },
    async settings(): Promise<unknown> {
      const result = await call(settingsGet, null)
      return isRecord(result) ? (result.settings ?? null) : null
    },
    status(): { platform: NodeJS.Platform | null; terminalWindowsShell: string | null } {
      const status = context.runtime.getStatus() as Record<string, unknown>
      return {
        platform:
          typeof status.hostPlatform === 'string' ? (status.hostPlatform as NodeJS.Platform) : null,
        terminalWindowsShell:
          typeof status.terminalWindowsShell === 'string' && status.terminalWindowsShell.trim()
            ? status.terminalWindowsShell
            : null
      }
    },
    async sessions(args: {
      force: boolean
      scopePaths: readonly string[]
    }): Promise<{ sessions: AiVaultSession[]; issues: unknown[] }> {
      const result = await call(listSessions, {
        limit: AI_VAULT_SESSION_LIMIT,
        force: args.force,
        scopePaths: [...args.scopePaths]
      })
      if (!isRecord(result) || !Array.isArray(result.sessions) || !Array.isArray(result.issues)) {
        throw new Error('runtime_unavailable')
      }
      return { sessions: result.sessions as AiVaultSession[], issues: result.issues }
    },
    async prepareResume(session: AiVaultSession): Promise<Record<string, unknown> | null> {
      const result = await call(prepareSessionResume, {
        agent: session.agent,
        filePath: session.filePath,
        codexHome: session.codexHome,
        ...(session.executionHostId ? { executionHostId: session.executionHostId } : {})
      })
      return isRecord(result) ? result : null
    },
    async createTerminal(
      worktreeId: string,
      launch: MobileAiVaultResumeLaunch & { clientMutationId: string }
    ): Promise<string> {
      const created = CreatedTerminal.parse(
        await call(createTerminal, {
          worktree: `id:${worktreeId}`,
          ...(launch.env ? { env: launch.env } : {}),
          ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
          ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
          ...(launch.launchAgent ? { launchAgent: launch.launchAgent } : {}),
          clientMutationId: launch.clientMutationId,
          activate: false,
          select: true,
          navigation: 'caller'
        })
      )
      return created.tab.terminal
    },
    async sendResumeCommand(terminal: string, command: string): Promise<void> {
      const result = TerminalSendResult.parse(
        // Clientless like the resume path it replaces: the command is not floor-taking input.
        await call(terminalSend, { terminal, text: command, enter: true })
      )
      if (!result.send.accepted) {
        throw new Error('conflict')
      }
    }
  }
}

function listOf(result: unknown, key: string): unknown[] {
  const value = isRecord(result) ? result[key] : undefined
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
