import { isDeepStrictEqual } from 'node:util'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AttachFlowInput } from './structured-agent-session-attach-flow'
import { journalIdentityFor } from './structured-agent-session-attach'
import {
  AgentSessionPreSpawnError,
  isAgentSessionPreSpawnError,
  rethrowAfterAgentSessionAcquisitionCleanup
} from './structured-agent-session-adapter'
import {
  beginStructuredForkAttempt,
  proveStructuredForkAcquisition
} from './structured-agent-session-fork-lifecycle'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'

/** A reservation with no process behind it is only a promise to spawn; the
 *  adapter makes it real and the store then grants the writer. */
export async function acquireStructuredAgentSessionOwner(
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
    const fork = await beginStructuredForkAttempt(input.store, record)
    const acquired = await input.adapter.acquire({
      ...(fork ? { fork } : {}),
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
      link: proveStructuredForkAcquisition(record, acquired.link),
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
