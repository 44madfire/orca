import type { AgentSessionForkTarget } from '../../shared/agent-session-fork'
import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../shared/agent-session-journal-item-key'

export function assertCodexForkedIdentities(
  threadId: string,
  fork: AgentSessionForkTarget,
  identities: readonly AgentJournalItemIdentity[]
): void {
  const actual = new Set(identities.map((identity) => agentJournalItemKey(identity)))
  const expectedTurns = new Set<string>()
  for (const itemId of fork.retainedItemIds ?? []) {
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider !== 'codex') {
      continue
    }
    expectedTurns.add(identity.turnId)
    const expectedKey = agentJournalItemKey({
      provider: 'codex',
      threadId,
      turnId: identity.turnId,
      ordinal: identity.ordinal
    })
    if (!actual.has(expectedKey)) {
      throw new Error('agent_session_fork:proof-mismatch')
    }
  }
  if (!expectedTurns.has(fork.throughId)) {
    throw new Error('agent_session_fork:proof-mismatch')
  }
  for (const identity of identities) {
    if (identity.provider === 'codex' && !expectedTurns.has(identity.turnId)) {
      throw new Error('agent_session_fork:proof-mismatch')
    }
  }
}

export function assertCodexForkedTurnIds(
  fork: AgentSessionForkTarget,
  turnIds: readonly string[]
): void {
  const expected = new Set(
    (fork.retainedItemIds ?? []).flatMap((key) => {
      const identity = parseAgentJournalItemKey(key)
      return identity?.provider === 'codex' ? [identity.turnId] : []
    })
  )
  if (
    !expected.has(fork.throughId) ||
    expected.size !== turnIds.length ||
    turnIds.some((id) => !expected.has(id))
  ) {
    throw new Error('agent_session_fork:proof-mismatch')
  }
}
