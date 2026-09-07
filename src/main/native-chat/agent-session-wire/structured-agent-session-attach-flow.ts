import { settlePostAcquisitionAttachFailure } from './structured-agent-session-attach-failure'
import { rewindRefusal } from './structured-rewind-refusal'
import type { StructuredAgentSessionAcquireInput } from './structured-agent-session-adapter'
import { AgentSessionRewindRefusal } from './structured-agent-session-adapter'
// The host supplies owner authority; this flow reserves, proves, and publishes the session.

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
import { claudeRewindAcquisitionProofs } from './structured-rewind-claude-proof'
import {
  importAdoptedTranscript,
  prepareAdoptedTranscript
} from './structured-agent-session-adopted-import'

export type AttachFlowInput = {
  rewind?: StructuredAgentSessionAcquireInput['rewind']
  store: AgentSessionRecordStore
  adapter: StructuredAgentSessionAdapter
  journalRoot: string
  authority: AgentSessionAttachAuthority
  callerKey: string
  params: AgentSessionAttachParams
  now: () => number
  /** Publishes the journal before clients can send against the new owner. */
  onAttached: (
    attached: AttachedJournal,
    acquisitionGeneration: string | null
  ) => Promise<void> | void
  /** Host-owned provider sink, bound to the journal inside `onAttached`. */
  eventSink?: StructuredAgentSessionEventSink
  /** Stops acquisition-window events targeting the superseded journal. */
  onAcquiring?: () => Promise<void> | void
  /** Settles writes already captured by the superseded journal before opening another. */
  beforeJournalOpen?: () => Promise<void> | void
  /** Closes and removes partial publication after journal attachment fails. */
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
  const preparedTranscript = store.getRecord(sessionId)
    ? { ok: true as const, items: null }
    : await prepareAdoptedTranscript(params)
  if (!preparedTranscript.ok) {
    return preparedTranscript
  }
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
      // Settle processless proof and failed operation atomically.
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
    if (error instanceof AgentSessionRewindRefusal) {
      return rewindRefusal(error.rewindReason)
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
    await importAdoptedTranscript(params, attached, record, preparedTranscript.items)
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

/** Grant the writer only after the adapter proves a process behind the reservation. */
async function acquireOwner(
  input: AttachFlowInput,
  record: AgentSessionRecord
): Promise<{ record: AgentSessionRecord; acquisitionGeneration: string | null }> {
  const { store, rewind, now } = input
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
      ...claudeRewindAcquisitionProofs({ store, record, rewind, now }),
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
