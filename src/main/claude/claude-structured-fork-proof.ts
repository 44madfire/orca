import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from '../native-chat/agent-session-wire/agent-session-history-page-bounds'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { proveClaudeTranscriptBranchFromJsonl } from './claude-transcript-branch-proof'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'

export function verifyClaudeForkTranscript(
  contents: string,
  targetSessionId: string,
  fork: AgentSessionForkTarget
): void {
  if (fork.source.provider !== 'claude') {
    throw new Error('agent_session_fork:proof-mismatch')
  }
  const inheritedRoots = new Set([fork.source.sessionId])
  const retainedUuids: string[] = []
  for (const key of fork.retainedItemIds ?? []) {
    const identity = parseAgentJournalItemKey(key)
    if (identity?.provider === 'claude') {
      inheritedRoots.add(identity.sessionId)
      retainedUuids.push(identity.uuid)
    }
  }
  // Normalize only the proof view; copied transcript and journal identities stay verbatim.
  const proofView = `${contents
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const row: unknown = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('agent_session_fork:proof-mismatch')
      }
      const record = row as Record<string, unknown>
      return JSON.stringify(
        typeof record.sessionId === 'string' && inheritedRoots.has(record.sessionId)
          ? { ...record, sessionId: targetSessionId }
          : record
      )
    })
    .join('\n')}\n`
  const proof = proveClaudeTranscriptBranchFromJsonl({
    contents: proofView,
    providerSessionId: targetSessionId,
    previousLeafUuid: fork.throughId,
    requiredAncestorUuids: retainedUuids
  })
  if (proof.leafUuid !== fork.throughId) {
    throw new Error('agent_session_fork:proof-mismatch')
  }
}

export async function proveClaudeStructuredFork(
  launch: ClaudeStructuredLaunch,
  fork: AgentSessionForkTarget
): Promise<void> {
  const transcriptPath = await resolveSessionFilePath('claude', launch.providerSessionId, {
    claudeProjectsDir: join(launch.claudeConfigDir, 'projects')
  })
  if (!transcriptPath) {
    throw new Error('agent_session_fork:proof-mismatch')
  }
  const file = await open(transcriptPath, 'r')
  try {
    const buffer = Buffer.alloc(AGENT_SESSION_HISTORY_MAX_PAGE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) {
        break
      }
      length += bytesRead
    }
    if (length > AGENT_SESSION_HISTORY_MAX_PAGE_BYTES) {
      throw new Error('agent_session_fork:history-limit')
    }
    verifyClaudeForkTranscript(
      buffer.subarray(0, length).toString('utf8'),
      launch.providerSessionId,
      fork
    )
  } finally {
    await file.close()
  }
}
