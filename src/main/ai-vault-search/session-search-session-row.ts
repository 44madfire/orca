import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultSearchHit } from '../../shared/ai-vault-search-types'

export type SessionRow = {
  id: number
  agent: AiVaultAgent
  session_id: string
  file_path: string
  codex_home: string | null
  title: string
  cwd: string | null
  branch: string | null
  updated_at: string | null
  message_count: number
  resume_command: string
  content_hash: string | null
  content_hash_count: number
}

export function sessionFields(session: SessionRow): Omit<AiVaultSearchHit, 'score' | 'evidence'> {
  return {
    agent: session.agent,
    sessionId: session.session_id,
    filePath: session.file_path,
    codexHome: session.codex_home,
    title: session.title,
    cwd: session.cwd,
    branch: session.branch,
    updatedAt: session.updated_at,
    messageCount: session.message_count,
    resumeCommand: session.resume_command
  }
}
