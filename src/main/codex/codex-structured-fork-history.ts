import { assertCodexForkedIdentities } from './codex-structured-fork-identity'
import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { verifyCodexRevertedHistory } from './codex-structured-rewind'

export async function verifyCodexForkedHistory(
  connection: CodexAppServerConnection,
  threadId: string,
  fork: AgentSessionForkTarget,
  timeoutMs?: number
): Promise<void> {
  const items = await verifyCodexRevertedHistory(
    { connection, threadId },
    { turnsBackwardsCursor: null, itemsBackwardsCursor: null },
    '',
    timeoutMs
  )
  assertCodexForkedIdentities(
    threadId,
    fork,
    items.map((item) => item.identity)
  )
}
