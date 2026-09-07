import { randomBytes } from 'node:crypto'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { MobileWebAgentHistorySession } from '../../../../shared/mobile-web/agent-history-operation-contract'

export type MobileWebAgentHistoryPage = {
  sessions: MobileWebAgentHistorySession[]
  skippedTranscriptCount: number
  offset: number
}

/** Page-facing session handles and the one page cursor a connection may hold. The page never sees
 *  a transcript path, a cwd or a provider session id. */
export class MobileWebAgentHistoryStore {
  private readonly sessionsByHandle = new Map<string, AiVaultSession>()
  private readonly handleByConnection = new Map<string, Set<string>>()
  private readonly continuations = new Map<string, MobileWebAgentHistoryPage & { cursor: string }>()
  private readonly resumeMutationIds = new Map<string, string>()

  /** Replaces every handle this connection holds, so a stale handle cannot outlive its listing. */
  synchronize(connectionId: string, sessions: readonly AiVaultSession[]): Map<string, string> {
    for (const handle of this.handleByConnection.get(connectionId) ?? []) {
      this.sessionsByHandle.delete(handle)
    }
    const handles = new Set<string>()
    const bySessionId = new Map<string, string>()
    for (const session of sessions) {
      const handle = `agent_session_${randomBytes(16).toString('hex')}`
      this.sessionsByHandle.set(handle, session)
      handles.add(handle)
      bySessionId.set(session.id, handle)
    }
    this.handleByConnection.set(connectionId, handles)
    return bySessionId
  }

  session(connectionId: string, handle: string): AiVaultSession {
    const session = this.sessionsByHandle.get(handle)
    if (!session || !this.handleByConnection.get(connectionId)?.has(handle)) {
      throw new Error('selector_not_found')
    }
    return session
  }

  retain(connectionId: string, page: MobileWebAgentHistoryPage): string {
    const cursor = `agent_history_page_${randomBytes(16).toString('hex')}`
    this.continuations.set(connectionId, { ...page, cursor })
    return cursor
  }

  consume(connectionId: string, cursor: string): MobileWebAgentHistoryPage {
    const continuation = this.continuations.get(connectionId)
    this.continuations.delete(connectionId)
    if (!continuation || continuation.cursor !== cursor) {
      throw new Error('invalid_argument')
    }
    return continuation
  }

  clearContinuation(connectionId: string): void {
    this.continuations.delete(connectionId)
  }

  /** A retry after an interrupted resume must reuse the key so the host dedups the create;
   *  a resume after success mints a fresh one so the user can fork the session on purpose. */
  claimResumeMutationId(connectionId: string, sessionId: string): string {
    const key = `${connectionId}\u0000${sessionId}`
    const existing = this.resumeMutationIds.get(key)
    if (existing) {
      return existing
    }
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64) || 'session'
    const minted = `mobile-web-ai-vault:${safeSession}:${randomBytes(12).toString('hex')}`
    this.resumeMutationIds.set(key, minted)
    return minted
  }

  releaseResumeMutationId(connectionId: string, sessionId: string): void {
    this.resumeMutationIds.delete(`${connectionId}\u0000${sessionId}`)
  }
}
