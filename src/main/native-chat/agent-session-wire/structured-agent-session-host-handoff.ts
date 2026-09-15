import { join } from 'node:path'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { LegacyImportOptions } from '../agent-session-journal/journal-legacy-import'
import { importLegacyTranscriptIntoJournal } from '../agent-session-journal/journal-legacy-import'
import { journalIdentityFor } from './structured-agent-session-attach'
import { rethrowAfterAgentSessionAcquisitionCleanup } from './structured-agent-session-adapter'
import { canRestoreLiveTuiOwner } from './structured-agent-session-handoff-restart'
import type { DeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import { recoverDeadTuiHandoffStatus } from './structured-agent-session-dead-tui-recovery'
import { readNativeSessionOptions } from './structured-agent-session-option-restoration'
import type { AgentSessionSubscribers } from './structured-agent-session-subscribers'
import { StructuredTuiTranscriptCatchup } from './structured-tui-transcript-catchup'
import { adapterSupportsCreateIfDeclared } from './structured-agent-session-provider-support'
import { retryLoadedStructuredAgentSessionSettlement } from './structured-agent-session-settlement-retry'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS, boundPayload } from '../agent-session-journal/journal-payload-bounds'
import type { JournalReplacementItem } from '../agent-session-journal/journal-epoch-replacement'

type HostHandoffAccess = {
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

export type StructuredAgentSessionHostHandoff = StructuredAgentSessionHandoffCoordinator & {
  stopTuiHistoryCatchup: () => void
  recoverDeadTuiOwner: (
    sessionId: string,
    expectedFence: number,
    probe: AgentSessionOwnerProbe
  ) => Promise<void>
}

export async function refreshRecoverableStructuredHandoffStatus(
  handoff: StructuredAgentSessionHostHandoff,
  store: StructuredAgentSessionHostDeps['store'],
  sessionId: string
) {
  const record = store.getRecord(sessionId)
  if (record && canRestoreLiveTuiOwner(record)) {
    await handoff.restore(sessionId)
  }
  return handoff.status(sessionId)
}

export function createStructuredAgentSessionHostHandoff(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess
): StructuredAgentSessionHostHandoff {
  const tuiHistoryCatchup = new StructuredTuiTranscriptCatchup({
    store: deps.store,
    session: host.session,
    schedule: host.serialize,
    publish: (sessionId) => {
      const session = host.session(sessionId)
      host.subscribers.publish(sessionId, session.journal)
    },
    reset: (sessionId, fence) => {
      const session = host.session(sessionId)
      host.subscribers.reset(sessionId, session.journal, 'epoch_changed', fence)
    },
    ...(deps.onEventSinkError ? { onError: deps.onEventSinkError } : {})
  })
  const coordinator = new StructuredAgentSessionHandoffCoordinator({
    store: deps.store,
    claimKeyId: deps.claimKeyId,
    ...(deps.handoffTransport ? { transport: deps.handoffTransport } : {}),
    session: host.session,
    suspendNative: async (sessionId) => {
      if (!deps.adapter.closeSession) {
        return { state: 'live' }
      }
      const exited = await deps.adapter.closeSession(sessionId)
      if (exited !== true) {
        // Report the unproven exit; the forward handoff refuses on it.
        return { state: 'live' }
      }
      host.session(sessionId).hasProviderChild = false
      host.publishStatus?.(sessionId)
      try {
        await host.flush(sessionId)
        const session = host.session(sessionId)
        await session.journal.markPendingSubmissionsUnknown(
          session.fence,
          'provider_exited_before_acknowledgement'
        )
        host.subscribers.publish(sessionId, session.journal)
        host.publishStatus?.(sessionId)
        host.eventSink(sessionId).unbind()
        return { state: 'stopped' }
      } catch (error) {
        return { state: 'stopped-cleanup-failed', error }
      }
    },
    acknowledgeNativeRelease: (sessionId) => deps.adapter.acknowledgeSessionRelease?.(sessionId),
    acquireNative: (input) => acquireNativeHandoffOwner(deps, host, input),
    acquireNativeStop: async (sessionId, turnId, fence) =>
      (await deps.adapter.cancelTurn({ sessionId, turnId, fence })).cancelled,
    importTuiHistory: (input) => importTuiHistory(deps, host, input),
    retryPendingSettlement: (sessionId) =>
      retryLoadedStructuredAgentSessionSettlement({
        deps,
        sessionId,
        session: host.session(sessionId),
        now: host.now
      }),
    prepareTuiHistoryCatchup: (sessionId, fence) => tuiHistoryCatchup.prepare(sessionId, fence),
    recoverTuiHistoryCatchup: (sessionId, fence) => tuiHistoryCatchup.recover(sessionId, fence),
    activateTuiHistoryCatchup: (sessionId) => tuiHistoryCatchup.activate(sessionId),
    stopTuiHistoryCatchup: (sessionId) => tuiHistoryCatchup.stop(sessionId),
    publish: (sessionId, status) => {
      // A status publish is a notification, not a mutation. Eviction and host teardown both drop
      // the session while a handoff flow is still settling, and `requireSession` would turn that
      // last publish — usually the FAILED one — into an unhandled rejection nothing can catch.
      const fence =
        deps.store.getRecord(sessionId)?.lease.runtimeFence ?? host.findSession(sessionId)?.fence
      if (fence === undefined) {
        return
      }
      host.subscribers.handoff(sessionId, fence, status)
    },
    schedule: host.serialize,
    now: host.now,
    ...(deps.persistTuiProviderHandle
      ? { persistTuiProviderHandle: deps.persistTuiProviderHandle }
      : {})
  })
  return Object.assign(coordinator, {
    stopTuiHistoryCatchup: () => tuiHistoryCatchup.stopAll(),
    recoverDeadTuiOwner: async (
      sessionId: string,
      expectedFence: number,
      probe: AgentSessionOwnerProbe
    ) => {
      const record = deps.store.getRecord(sessionId)
      if (!record) {
        return
      }
      const status = await recoverDeadTuiHandoffStatus({
        store: deps.store,
        now: host.now,
        record,
        expectedFence,
        probe
      })
      if (status) {
        coordinator.setStatus(sessionId, status)
      }
    }
  })
}

async function importTuiHistory(
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
  // Pi reconciles through provider-resume (session file root → leaf), never
  // the legacy row importer: rebuilt rows replace the epoch wholesale with
  // stable Pi entry ids, so a retry reconciles instead of duplicating.
  if (record.provider === 'pi') {
    await importPiResumeHistoryIntoJournal(deps, host, input, record)
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

async function importPiResumeHistoryIntoJournal(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: { sessionId: string; fence: number },
  record: AgentSessionRecord
): Promise<void> {
  const session = host.session(input.sessionId)
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (head?.handle.provider !== 'pi') {
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
        identity: { provider: 'legacy', agent: 'pi', sessionId: head.handle.sessionId, recordId: row.id },
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
      identity: { provider: 'legacy', agent: 'pi', sessionId: head.handle.sessionId, recordId: row.id },
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

export async function acquireNativeHandoffOwner(
  deps: StructuredAgentSessionHostDeps,
  host: HostHandoffAccess,
  input: { sessionId: string; fence: number; spawnToken: string }
): Promise<AgentSessionRecord> {
  const session = host.session(input.sessionId)
  const record = deps.store.getRecord(input.sessionId)
  if (!record) {
    throw new Error('agent_session_identity_required')
  }
  // Native handoff bypasses attach admission; reject before unbinding TUI ownership.
  if (!adapterSupportsCreateIfDeclared(deps.adapter, record.location, record.provider)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const eventSink = host.eventSink(input.sessionId)
  const priorBarrier = await eventSink.drained()
  if (!priorBarrier.ok) {
    throw priorBarrier.error
  }
  eventSink.unbind()
  // Recheck immediately before acquisition; capability probes may drift while
  // the old TUI event sink is draining.
  if (!adapterSupportsCreateIfDeclared(deps.adapter, record.location, record.provider)) {
    throw new Error('structured_agent_session_unsupported')
  }
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  const acquired = await deps.adapter.acquire({
    identity: journalIdentityFor(record, session.params),
    fence: input.fence,
    spawnToken: input.spawnToken,
    ...(record.options ? { options: record.options } : {}),
    events: eventSink.sink,
    // Pi resumes by exact session file carried on the durable chain head.
    ...(head?.handle.provider === 'pi' && head.handle.sessionFile
      ? { resumeSessionFile: head.handle.sessionFile }
      : {})
  })
  let proved: AgentSessionRecord
  try {
    const options = await readNativeSessionOptions({
      adapter: deps.adapter,
      sessionId: input.sessionId,
      fence: input.fence,
      ...(record.options ? { priorOptions: record.options } : {})
    })
    await deps.store.commitProcessIdentity({
      sessionId: input.sessionId,
      fence: input.fence,
      process: acquired.process,
      now: host.now()
    })
    proved = await deps.store.proveOwner({
      sessionId: input.sessionId,
      fence: input.fence,
      link: acquired.link,
      now: host.now(),
      ...(options ? { options } : {})
    })
  } catch (error) {
    return rethrowAfterAgentSessionAcquisitionCleanup(deps.adapter, input.sessionId, error)
  }
  session.hasProviderChild = true
  host.publishStatus?.(input.sessionId)
  session.fence = proved.lease.runtimeFence
  session.acquisitionGeneration = acquired.acquisitionGeneration ?? null
  eventSink.bind({
    journal: session.journal,
    fence: proved.lease.runtimeFence,
    publish: (activity) => host.subscribers.publish(input.sessionId, session.journal, activity)
  })
  const acquiredBarrier = await eventSink.drained()
  if (!acquiredBarrier.ok) {
    throw acquiredBarrier.error
  }
  host.subscribers.snapshot(input.sessionId, session.journal, proved.lease.runtimeFence)
  return proved
}
