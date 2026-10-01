// TUI-history import leg of the structured agent-session host handoff.
//
// Split from `structured-agent-session-host-handoff` (line budget): legacy transcript import,
// Pi provider-resume reconciliation, and the transcript-location options. The `HostHandoffAccess`
// seam lives here too so the factory and these operations share one definition without a cycle.

import { join } from 'node:path'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { LegacyImportOptions } from '../agent-session-journal/journal-legacy-import'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS, boundPayload } from '../agent-session-journal/journal-payload-bounds'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'

export type HostHandoffAccess = {
  session: (sessionId: string) => StructuredAgentSessionHostSession
  /** Non-throwing lookup, for the paths that only observe a detached session. */
  findSession: (sessionId: string) => StructuredAgentSessionHostSession | undefined
  eventSink: (sessionId: string) => DeferredStructuredAgentSessionEventSink
  flush: (sessionId: string) => Promise<void>
  serialize: (sessionId: string, task: () => Promise<void>) => Promise<void>
  subscribers: AgentSessionSubscribers
  publishStatus?: (sessionId: string) => void
  now: () => number
}

export async function importTuiHistory(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: { sessionId: string; fence: number; transcriptPath?: string }
): Promise<void> {
  const session = host.session(input.sessionId)
  const record = deps.store.getRecord(input.sessionId)
  const head = record?.providerHandleChain.at(-1)
  if (!record || !head) {
    throw new Error('agent_session_identity_required')
  }
  // Pi-family reconciles through provider-resume (session file root → leaf),
  // never the legacy row importer: rebuilt rows replace the epoch wholesale
  // with stable provider entry ids, so a retry reconciles instead of duplicating.
  if (record.provider === 'pi' || record.provider === 'omp') {
    await importPiFamilyResumeHistoryIntoJournal(deps, host, input, record)
    return
  }
  const options = structuredTuiTranscriptImportOptions(record, input.transcriptPath)
  const providerSessionId =
    head.handle.provider === 'codex' ? head.handle.threadId : head.handle.sessionId
  const imported = await importLegacyTranscriptIntoJournal({
    journal: session.journal,
    agent: head.handle.provider,
    sessionId: providerSessionId,
    fence: input.fence,
    options
  })
  if (!imported.ok) {
    throw new Error(imported.error)
  }
  host.subscribers.reset(input.sessionId, session.journal, 'epoch_changed', input.fence)
}

async function importPiFamilyResumeHistoryIntoJournal(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: { sessionId: string; fence: number },
  record: AgentSessionRecord
): Promise<void> {
  const session = host.session(input.sessionId)
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  // Same-provider resume only: the rows below carry the head discriminant,
  // so a Pi file can never land in an OMP journal and vice versa.
  if (
    !head ||
    (head.handle.provider !== 'pi' && head.handle.provider !== 'omp') ||
    head.handle.provider !== record.provider
  ) {
    throw new Error('agent_session_identity_required')
  }
  const read = deps.adapter.readResumeHistory
  if (!read) {
    throw new Error('structured_agent_session_unsupported')
  }
  const rebuilt = await read.call(deps.adapter, { sessionId: input.sessionId, fence: input.fence })
  const items: JournalReplacementItem[] = []
  for (const row of rebuilt.rows) {
    if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') {
      continue
    }
    if (row.role === 'tool') {
      items.push({
        identity: { provider: 'legacy', agent: head.handle.provider, sessionId: head.handle.sessionId, recordId: row.id },
        body: {
          kind: 'tool-call',
          name: 'tool',
          input: {},
          state: 'completed',
          output: boundPayload(row.text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
        }
      })
      continue
    }
    items.push({
      identity: { provider: 'legacy', agent: head.handle.provider, sessionId: head.handle.sessionId, recordId: row.id },
      body: { kind: 'message', role: row.role, blocks: [{ type: 'text', text: row.text }] }
    })
  }
  if (items.length === 0) {
    // The TUI leg produced no transcript rows; the journal already shows the
    // conversation so far and there is no gap to reconcile.
    return
  }
  await session.journal.replaceEpochItems('legacy_import', input.fence, items)
  host.subscribers.reset(input.sessionId, session.journal, 'epoch_changed', input.fence)
}

export function structuredTuiTranscriptImportOptions(
  record: AgentSessionRecord,
  transcriptPath?: string
): LegacyImportOptions {
  if (transcriptPath) {
    return { filePath: transcriptPath }
  }
  if (record.provider === 'claude') {
    return { claudeProjectsDir: join(record.accountHome.path, 'projects') }
  }
  if (record.provider === 'codex') {
    return { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] }
  }
  // Pi history reconciles by provider-resume (Pi session file root → leaf),
  // never by legacy row import; the legacy decoders cannot parse Pi rows.
  // The reverse flow skips this import when historySource is provider-resume;
  // reaching here for Pi means the TUI owner proved no resume source, so fail
  // closed rather than mis-attributing another provider's transcript.
  // External bridge has no TUI transcript; fail closed rather than mis-attributing.
  throw new Error('structured_agent_session_unsupported')
}
