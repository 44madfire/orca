import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionAttachParams, AttachedJournal } from './structured-agent-session-attach'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'

// Import before publication so the first visible chat agrees with the provider's resumed context.
export async function importAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord
): Promise<void> {
  const adopt = params.adopt
  // A new journal contains only its epoch row; replay must preserve subsequent durable writes.
  if (!adopt || attached.journal.cursor().sequence > 1) {
    return
  }
  const imported = await importLegacyTranscriptIntoJournal({
    journal: attached.journal,
    agent: params.agent,
    sessionId:
      adopt.providerHandle.kind === 'claude'
        ? adopt.providerHandle.sessionId
        : adopt.providerHandle.threadId,
    fence: record.lease.runtimeFence,
    options: { filePath: adopt.transcriptPath }
  })
  if (!imported.ok) {
    throw new Error(imported.error)
  }
  // `replaced: false` means the transcript decoded to nothing. The row promised a conversation and
  // the provider resumed one, so an empty journal here is a disagreement, not an empty chat.
  if (!imported.replaced) {
    throw new Error('agent_session_identity_required')
  }
}
