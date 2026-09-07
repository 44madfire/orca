import { z } from 'zod'
import {
  MOBILE_WEB_AGENT_HISTORY_CURSOR_MAX_LENGTH,
  MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT,
  MOBILE_WEB_AGENT_HISTORY_QUERY_MAX_LENGTH
} from '../../../../shared/mobile-web/agent-history-operation-contract'
import { deriveMobileAiVaultScopePaths } from '../../../../shared/mobile-ai-vault-scope-paths'
import { defineMethod, type RpcContext } from '../core'
import { mobileWebAgentHistoryRpc } from './mobile-web-agent-history-rpc'
import {
  boundedCount,
  filterMobileWebAgentHistorySessions,
  projectMobileWebAgentHistory,
  projectMobileWebAgentHistoryPreview
} from './mobile-web-agent-history-projection'
import { resumeMobileWebAgentHistorySession } from './mobile-web-agent-history-resume'
import { MobileWebAgentHistoryStore } from './mobile-web-agent-history-store'

const history = new MobileWebAgentHistoryStore()
const SessionHandle = z.string().min(1).max(160)
const Scope = z.object({ worktree: z.string().min(1).max(4096) })

export const MOBILE_WEB_AGENT_HISTORY_METHODS = [
  defineMethod({
    name: 'mobileWeb.agentHistory.snapshot',
    params: Scope.extend({
      scope: z.enum(['workspace', 'project', 'all']),
      query: z.string().max(MOBILE_WEB_AGENT_HISTORY_QUERY_MAX_LENGTH),
      force: z.boolean(),
      cursor: z.string().min(1).max(MOBILE_WEB_AGENT_HISTORY_CURSOR_MAX_LENGTH).optional()
    }),
    handler: async (params, context) => {
      const connectionId = requireConnection(context)
      const page = params.cursor
        ? history.consume(connectionId, params.cursor)
        : await scanHistory(params, connectionId, context)
      const sessions = page.sessions.slice(
        page.offset,
        page.offset + MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT
      )
      const nextOffset = page.offset + sessions.length
      return {
        // The desktop serving a hybrid page always has the scanner; the field stays for the page.
        supported: true,
        sessions,
        skippedTranscriptCount: page.skippedTranscriptCount,
        nextCursor:
          nextOffset < page.sessions.length
            ? history.retain(connectionId, { ...page, offset: nextOffset })
            : null
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.agentHistory.preview',
    params: z.object({ sessionHandle: SessionHandle }),
    handler: async (params, context) =>
      projectMobileWebAgentHistoryPreview(
        history.session(requireConnection(context), params.sessionHandle)
      )
  }),
  defineMethod({
    name: 'mobileWeb.agentHistory.resume',
    params: Scope.extend({ sessionHandle: SessionHandle }),
    handler: async (params, context) => {
      const connectionId = requireConnection(context)
      const session = history.session(connectionId, params.sessionHandle)
      const result = await resumeMobileWebAgentHistorySession({
        session,
        activeWorktreeId: worktreeIdFromSelector(params.worktree),
        clientMutationId: history.claimResumeMutationId(connectionId, session.id),
        context
      })
      if (result.status === 'queued') {
        history.releaseResumeMutationId(connectionId, session.id)
      }
      return result
    }
  })
]

async function scanHistory(
  params: {
    worktree: string
    scope: 'workspace' | 'project' | 'all'
    query: string
    force: boolean
  },
  connectionId: string,
  context: RpcContext
) {
  history.clearContinuation(connectionId)
  const rpc = mobileWebAgentHistoryRpc(context)
  const worktrees = await rpc.worktrees()
  const activeWorktreeId = worktreeIdFromSelector(params.worktree)
  const activeWorktree = worktrees.find((worktree) => worktree.worktreeId === activeWorktreeId)
  const scopePaths = deriveMobileAiVaultScopePaths(params.scope, activeWorktree ?? null, worktrees)
  const scanned = await rpc.sessions({ force: params.force, scopePaths })
  const filtered = filterMobileWebAgentHistorySessions(scanned.sessions, {
    scope: params.scope,
    query: params.query,
    scopePaths
  })
  const handles = history.synchronize(connectionId, filtered)
  return {
    sessions: projectMobileWebAgentHistory({
      sessions: filtered,
      activeWorktreePath: activeWorktree?.path ?? null,
      handleFor: (session) => handles.get(session.id) ?? ''
    }),
    skippedTranscriptCount: boundedCount(scanned.issues.length, 10_000),
    offset: 0
  }
}

/** The shell always addresses a worktree by id, so a selector of any other shape is not ours. */
function worktreeIdFromSelector(worktree: string): string {
  if (!worktree.startsWith('id:')) {
    throw new Error('selector_not_found')
  }
  return worktree.slice('id:'.length)
}

function requireConnection(context: RpcContext): string {
  if (!context.connectionId) {
    throw new Error('runtime_unavailable')
  }
  return context.connectionId
}
