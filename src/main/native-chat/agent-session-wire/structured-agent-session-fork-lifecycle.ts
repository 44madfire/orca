import { agentSessionForkAnchor } from '../../../shared/agent-session-fork'
import type { AgentSessionForkTarget } from '../../../shared/agent-session-fork'
import { isAdmissibleAgentJournalItemBody } from '../../../shared/agent-session-journal-schemas'
import {
  agentSessionProviderHandleKey,
  appendAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { agentSessionJournalCloseRetries } from '../agent-session-journal/journal-close-retry'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { forkJournalSeed } from './structured-fork-journal-seed'

export async function beginStructuredForkAttempt(
  store: AgentSessionRecordStore,
  record: AgentSessionRecord
): Promise<AgentSessionForkTarget | undefined> {
  const fork = record.fork
  if (!fork || fork.phase === 'provider-succeeded' || fork.phase === 'completed') {
    return undefined
  }
  if (fork.phase !== 'prepared') {
    throw new Error('agent_session_operation_unknown')
  }
  await store.transitionHandoff(record.sessionId, (current) => {
    if (
      current.lease.runtimeFence !== record.lease.runtimeFence ||
      current.fork?.phase !== 'prepared'
    ) {
      throw new Error('agent_session_checkpoint_stale')
    }
    return { ...current, fork: { ...fork, phase: 'attempted' } }
  })
  return {
    source: fork.source,
    throughId: fork.throughId,
    retainedItemIds: fork.retained.map((item) => item.itemId)
  }
}

export function proveStructuredForkAcquisition(
  record: AgentSessionRecord,
  acquired: AgentSessionProviderHandleLink
): AgentSessionProviderHandleLink {
  const fork = record.fork
  if (!fork || fork.phase === 'completed' || fork.phase === 'provider-succeeded') {
    return acquired
  }
  const link: AgentSessionProviderHandleLink = {
    ...acquired,
    origin: 'forked',
    forkedFromKey: agentSessionProviderHandleKey(fork.source)
  }
  appendAgentSessionProviderHandleLink(
    [agentSessionForkAnchor(fork.source, record.lease.runtimeFence, record.createdAt)],
    link
  )
  return link
}

export async function publishStructuredForkJournal(
  store: AgentSessionRecordStore,
  record: AgentSessionRecord,
  journal: AgentSessionJournal
): Promise<void> {
  const fork = record.fork
  if (!fork || fork.phase === 'completed') {
    return
  }
  try {
    const head = record.providerHandleChain.at(-1)
    if (
      fork.phase !== 'provider-succeeded' ||
      !head ||
      !record.providerHandleChain.some((link) => link.origin === 'forked')
    ) {
      throw new Error('agent_session_operation_unknown')
    }
    const items = fork.retained.map((item) => {
      if (!isAdmissibleAgentJournalItemBody(item.body)) {
        throw new Error('agent_session_operation_invalid')
      }
      return { ...item, body: item.body }
    })
    await journal.replaceEpochItems(
      'handle_forked',
      record.lease.runtimeFence,
      forkJournalSeed(items, fork.source, head.handle)
    )
    await store.transitionHandoff(record.sessionId, (current) => {
      if (
        current.lease.runtimeFence !== record.lease.runtimeFence ||
        current.fork?.phase !== 'provider-succeeded'
      ) {
        throw new Error('agent_session_checkpoint_stale')
      }
      return { ...current, schemaVersion: 2, fork: { ...fork, phase: 'completed', retained: [] } }
    })
  } catch (error) {
    await agentSessionJournalCloseRetries.closeOrRetain(journal)
    throw error
  }
}
