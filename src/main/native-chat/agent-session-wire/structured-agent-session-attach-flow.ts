// The attach transition end to end: reserve the lease, make the reservation
// real, open the journal.
//
// Split out of the host so the sequence reads in one place. The host still owns
// the decisions that must not be client-supplied — the spawn token, the claim
// key, the owner probe — and passes them in.

import { isDeepStrictEqual } from 'node:util'
import type {
  AgentSessionAttachResult,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import { agentSessionLeaseAdmitsWriter } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  admitAttachOrRefuse,
  attachJournal,
  classifyStoreFailure,
  journalIdentityFor,
  reserveRequestFor,
  type AgentSessionAttachAuthority,
  type AgentSessionAttachParams,
  type AttachedJournal
} from './structured-agent-session-attach'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionRefusal,
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import { resolveAgentSessionReplayOutcome } from './structured-agent-session-replay-outcome'
import { readAgentSessionHydrationPage } from './agent-session-history-page'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'

export type AttachFlowInput = {
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  /** Registers the opened journal and fans out to subscribers before the caller
   *  sees the result, so no client can send against a session the host has not
   *  finished publishing. */
  onAttached: (
    attached: AttachedJournal,
    acquisitionGeneration: string | null
  ) => Promise<void> | void
  /** Handed to the adapter so it can journal what the provider streams. The
   *  host owns it and binds it to the journal inside `onAttached`. */
  eventSink?: StructuredAgentSessionEventSink
  /** Stops acquisition-window events targeting the superseded journal. */
  onAcquiring?: () => Promise<void> | void
  /** Settles writes already captured by the superseded journal before opening another. */
  beforeJournalOpen?: () => Promise<void> | void
  /** Removes any partial host publication after journal attachment fails, and
   *  closes the journal handle of the map entry it drops. Awaited: see eviction. */
  onAttachFailed?: () => Promise<void>
}

export async function performAttach(
  input: AttachFlowInput
): Promise<AgentSessionMutationResult<AgentSessionAttachResult>> {
  const { params, store } = input
  const sessionId = params.envelope.sessionId
  const admitted = admitAttachOrRefuse(params)
  if (!admitted.ok) {
    return admitted
  }

  let record: AgentSessionRecord
  let acquisitionGeneration: string | null = null
  let reservedRecord: AgentSessionRecord | null = null
  let replayed = false
  try {
    const reserved = await store.reserveOwner(
      reserveRequestFor({
        sessionId,
        params,
        authority: input.authority,
        callerKey: input.callerKey,
        fingerprint: admitted.fingerprint,
        now: input.now()
      })
    )
    record = reserved.record
    replayed = reserved.disposition === 'replayed'
    if (
      replayed &&
      reserved.operationRow.outcome.status !== 'pending' &&
      reserved.operationRow.outcome.status !== 'succeeded'
    ) {
      const replay = resolveAgentSessionReplayOutcome({
        operationId: params.envelope.clientOperationId,
        outcome: reserved.operationRow.outcome,
        reconstruct: () => null
      })
      if (replay.decision === 'refuse') {
        return { ok: false, refusal: replay.refusal }
      }
    }
    reservedRecord = record
    if (!agentSessionLeaseAdmitsWriter(record.lease)) {
      const acquired = await acquireOwner(input, record)
      record = acquired.record
      acquisitionGeneration = acquired.acquisitionGeneration
    }
  } catch (error) {
    const spawnToken = reservedRecord?.lease.reservedSpawnToken
    if (reservedRecord && spawnToken) {
      // A pre-spawn failure is its own processless proof; the settlement records the
      // evidence and the failed operation in one durable transaction.
      const exitProof = isAgentSessionPreSpawnError(error)
        ? 'processless'
        : error instanceof AgentSessionAcquisitionExitUnprovenError
          ? 'unproven'
          : error instanceof AgentSessionAcquisitionRootExitObservedError
            ? 'root-exit-observed'
            : 'exit-proven'
      const outcome =
        error instanceof AgentSessionAcquisitionExitUnprovenError
          ? {
              status: 'failed' as const,
              code: 'agent_session_ownership_unknown',
              message: error.message
            }
          : error instanceof AgentSessionAcquisitionRefusal
            ? {
                status: 'failed' as const,
                code: error.code,
                message: error.message
              }
            : {
                status: 'failed' as const,
                code: 'agent_session_operation_invalid',
                message: error instanceof Error ? error.message : String(error)
              }
      try {
        await store.settleFailedAcquisition({
          sessionId,
          fence: reservedRecord.lease.runtimeFence,
          spawnToken,
          callerKey: input.callerKey,
          operationId: params.envelope.clientOperationId,
          outcome,
          exitProof,
          now: input.now()
        })
      } catch (settlementError) {
        throw new AggregateError(
          [error, settlementError],
          'agent session acquisition failure settlement failed'
        )
      }
    }
    if (error instanceof AgentSessionAcquisitionRefusal) {
      return { ok: false, refusal: { code: error.code, message: error.message } }
    }
    return {
      ok: false,
      refusal: classifyStoreFailure(
        error,
        store.getRecord(sessionId)?.lease.runtimeFence ?? null,
        store.getRecord(sessionId)
      )
    }
  }

  let attached: AttachedJournal
  try {
    await input.beforeJournalOpen?.()
    attached = await attachJournal({
      record,
      params,
      journalRoot: input.journalRoot,
      adapter: input.adapter
    })
    await importAdoptedTranscript(params, attached, record)
    await input.onAttached(attached, acquisitionGeneration)
    await store.recordOperationOutcome({
      callerKey: input.callerKey,
      operationId: params.envelope.clientOperationId,
      outcome: { status: 'succeeded', sessionId }
    })
  } catch (error) {
    return settlePostAcquisitionAttachFailure(input, record, error)
  }

  const fence = record.lease.runtimeFence
  return {
    ok: true,
    replayed,
    fence,
    cursor: attached.journal.cursor(),
    value: {
      sessionId,
      fence,
      page: readAgentSessionHydrationPage(attached.journal, fence),
      unconfirmedClientMessageIds: attached.unconfirmedClientMessageIds
    }
  }
}

/**
 * Fill an adopting session's journal with the conversation so far.
 *
 * Runs here, and only here, because for a create there is no earlier moment: the provider is
 * acquired before the journal exists. It must still land before `onAttached`, which binds the event
 * sink and publishes the session — after that, streamed rows and client sends would race the import.
 *
 * A failure throws, and that is deliberate. By this point the provider has already resumed and holds
 * the conversation in context; leaving the user an empty journal beside a context-carrying agent is
 * the exact "claims continuity the provider never gave" inversion this feature must not produce.
 * The throw reaches `settlePostAcquisitionAttachFailure`, which tears the child down, settles the
 * operation failed, and publishes no tab.
 */
async function importAdoptedTranscript(
  params: AgentSessionAttachParams,
  attached: AttachedJournal,
  record: AgentSessionRecord
): Promise<void> {
  const adopt = params.adopt
  if (!adopt) {
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

async function settlePostAcquisitionAttachFailure(
  input: AttachFlowInput,
  record: AgentSessionRecord,
  cause: unknown
): Promise<never> {
  let cleanupError: unknown = cause
  let exitProof: 'exit-proven' | 'root-exit-observed' | 'unproven' = 'unproven'
  try {
    await rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, cause)
  } catch (error) {
    cleanupError = error
    exitProof =
      error instanceof AgentSessionAcquisitionExitUnprovenError
        ? 'unproven'
        : error instanceof AgentSessionAcquisitionRootExitObservedError
          ? 'root-exit-observed'
          : 'exit-proven'
  }
  // Why: the close is awaited so the map entry is gone only once its handle is
  // released, but a failed close must not also cost the store settlement below.
  await Promise.resolve(input.onAttachFailed?.()).catch(() => undefined)
  try {
    await input.store.settleFailedPostAcquisitionAttachment({
      sessionId: record.sessionId,
      fence: record.lease.runtimeFence,
      spawnToken: record.lease.reservedSpawnToken ?? '',
      callerKey: input.callerKey,
      operationId: input.params.envelope.clientOperationId,
      outcome: {
        status: 'failed',
        code: 'agent_session_operation_invalid',
        message: cause instanceof Error ? cause.message : String(cause)
      },
      exitProof,
      now: input.now()
    })
  } catch (settlementError) {
    throw new AggregateError(
      [cleanupError, settlementError],
      'agent session post-acquisition attachment failure settlement failed'
    )
  }
  throw cleanupError
}

/** A reservation with no process behind it is only a promise to spawn; the
 *  adapter makes it real and the store then grants the writer. */
async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{ record: AgentSessionRecord; acquisitionGeneration: string | null }> {
  const fence = record.lease.runtimeFence
  const spawnToken = record.lease.reservedSpawnToken
  if (!spawnToken) {
    throw new Error('agent_session_ownership_unknown')
  }
  // Pre-spawn proof is single-use: this retry may create a child after the durable clear.
  try {
    try {
      record = await input.store.setReservationProcesslessProof({
        sessionId: record.sessionId,
        fence,
        spawnToken,
        processlessAt: null,
        now: input.now()
      })
      await input.onAcquiring?.()
    } catch (error) {
      throw new AgentSessionPreSpawnError(error)
    }
    const acquired = await input.adapter.acquire({
      identity: journalIdentityFor(record, input.params),
      fence,
      // Retries must recover the original reservation, not mint a second child.
      spawnToken,
      ...(record.options ? { options: record.options } : {}),
      ...(input.eventSink ? { events: input.eventSink } : {})
    })
    const options = await readNativeSessionOptions({
      adapter: input.adapter,
      sessionId: record.sessionId,
      fence,
      ...(record.options ? { priorOptions: record.options } : {})
    })
    if (record.lease.ownerProcess === null) {
      await input.store.commitProcessIdentity({
        sessionId: record.sessionId,
        fence,
        process: acquired.process,
        now: input.now()
      })
    } else if (!isDeepStrictEqual(record.lease.ownerProcess, acquired.process)) {
      throw new Error('agent_session_ownership_unknown')
    }
    const proved = await input.store.proveOwner({
      sessionId: record.sessionId,
      fence,
      link: acquired.link,
      now: input.now(),
      ...(options ? { options } : {})
    })
    return {
      record: proved,
      acquisitionGeneration: acquired.acquisitionGeneration ?? null
    }
  } catch (error) {
    if (isAgentSessionPreSpawnError(error)) {
      throw error
    }
    return rethrowAfterAgentSessionAcquisitionCleanup(input.adapter, record.sessionId, error)
  }
}
