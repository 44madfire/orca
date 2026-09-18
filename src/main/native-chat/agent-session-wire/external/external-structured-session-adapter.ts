// External structured-session adapter (SNC1.3 dev seam, provider-neutral).
//
// Implements Orca's current `StructuredAgentSessionAdapter` contract by
// delegating transport to the vendored `BridgeHost` and translating opaque
// `session_event` records into Orca journal appends + Native Chat renders.
//
// Orca remains authoritative for journal, lease/fencing, outbox/idempotency,
// rendering, and client synchronization. The bridge never creates a second
// competing state machine: it only answers "did the provider take this?"
// with honest accepted/rejected/unknown (unknown never triggers resend).
//
// Development-only: enabled via `--enable-external-structured-bridge` plus
// `ORCA_PI_BRIDGE_COMMAND` (see `external-structured-bridge-config.ts`).
// Missing/incompatible bridge fails closed to the ordinary Pi TUI path.
// Pi assumptions stay in `orca-pi`; this file knows only the generic bridge.

import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem,
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session-provider-handle'
import type { AgentSessionProcessIdentity } from '../../../../shared/agent-session-record'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAcquireInput,
  StructuredAgentSessionAdapter,
  StructuredAgentSessionSetOptionInput,
} from '../structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import type { SessionEventEnvelope } from './bridge-host'
import type { BridgeSessionOptions } from './bridge-protocol'
import { BridgeUnavailableError } from './bridge-protocol'
import { readExternalBridgeConfig } from './external-structured-bridge-config'
import { acquireExternalStructuredSession } from './external-structured-session-acquire'
import {
  readExternalOptionRestoreFailures,
  readExternalSessionOptions,
  setExternalSessionOption,
} from './external-structured-session-options'
import {
  EXTERNAL_BRIDGE_AGENT,
  extractText,
  hasImageBlocks,
  type TurnBuffer,
} from './external-structured-session-payloads'
import { applyBridgeTurnEvent } from './external-structured-turn-events'
import type {
  ExternalAdapterDeps,
  ExternalBridgeHostLike,
} from './external-structured-session-types'

export { EXTERNAL_BRIDGE_AGENT }
export type { ExternalAdapterDeps, ExternalBridgeHostLike }

export class ExternalStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly hosts = new Map<string, ExternalBridgeHostLike>()
  private readonly sinks = new Map<string, StructuredAgentSessionEventSink>()
  private readonly bridgeSessionByOrca = new Map<string, string>()
  private readonly orcaSessionByBridge = new Map<string, string>()
  private readonly opSession = new Map<string, string>()
  private readonly turns = new Map<string, TurnBuffer>()
  private readonly promptRequestByItemId = new Map<
    string,
    { sessionId: string; requestId: string }
  >()
  private readonly sessionOptions = new Map<string, BridgeSessionOptions>()
  private readonly optionRestoreFailures = new Map<string, Set<string>>()
  // Sessions whose helper exit is unproven (possibly-live child retained).
  // Acquire refuses to spawn a second helper beside one of these; only a
  // settled teardown/force-close clears the entry.
  private readonly unprovenSessions = new Set<string>()
  private readonly generations = new Map<string, string>()

  constructor(private readonly deps: ExternalAdapterDeps) {}

  supportsCreate = (_location: unknown, agent: string): boolean => {
    const config = readExternalBridgeConfig(this.deps.env, this.deps.argv)
    if (!config.enabled || config.command === '') {return false}
    return agent === EXTERNAL_BRIDGE_AGENT
  }

  supportsLocation = (_location: unknown): boolean => {
    const config = readExternalBridgeConfig(this.deps.env, this.deps.argv)
    return config.enabled && config.command !== ''
  }

  async acquire(input: StructuredAgentSessionAcquireInput): Promise<{
    process: AgentSessionProcessIdentity
    link: AgentSessionProviderHandleLink
    acquisitionGeneration?: string
  }> {
    return acquireExternalStructuredSession({
      deps: this.deps,
      hosts: this.hosts,
      unprovenSessions: this.unprovenSessions,
      bridgeSessionByOrca: this.bridgeSessionByOrca,
      orcaSessionByBridge: this.orcaSessionByBridge,
      sessionOptions: this.sessionOptions,
      sinks: this.sinks,
      generations: this.generations,
      teardown: (sessionId) => this.teardown(sessionId),
      bindSessionEvents: (host, orcaSessionId) =>
        host.onSessionEvent((envelope) => this.routeSessionEvent(orcaSessionId, envelope)),
      input,
    })
  }

  async releaseAcquisition(input: { sessionId: string }): Promise<boolean> {
    return this.teardown(input.sessionId)
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
  }): Promise<AgentSessionDispatchOutcome> {
    const host = this.hosts.get(input.sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(input.sessionId)
    if (!host || !bridgeSessionId) {
      return { state: 'rejected', reason: 'bridge-unavailable: no live external session' }
    }
    if (hasImageBlocks(input.body)) {
      // SNC1.6 owns path/url → base64 mapping; SNC1.3 stays text-only fail-closed.
      return { state: 'rejected', reason: 'external-bridge-dev: image blocks unsupported (SNC1.6)' }
    }
    const text = extractText(input.body)
    if (text.trim() === '') {
      return { state: 'rejected', reason: 'external-bridge-dev: empty text dispatch' }
    }
    const outcome = await host.dispatch({ sessionId: bridgeSessionId, text })
    if (outcome.status === 'accepted') {
      this.opSession.set(outcome.opId, input.sessionId)
      this.turns.set(outcome.opId, {
        sessionId: input.sessionId,
        textByIndex: new Map(),
        thinkingByIndex: new Map(),
        tools: new Map(),
      })
      const providerIdentity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: input.sessionId,
        recordId: outcome.opId,
      }
      return { state: 'accepted', providerIdentity }
    }
    if (outcome.status === 'rejected') {
      return { state: 'rejected', reason: outcome.reason ?? 'bridge-rejected' }
    }
    return { state: 'unknown', reason: outcome.reason ?? 'bridge-unknown (reconcile via history)' }
  }

  async cancelTurn(input: {
    sessionId: string
    turnId: string
    fence: number
  }): Promise<{ cancelled: boolean }> {
    const host = this.hosts.get(input.sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(input.sessionId)
    if (!host || !bridgeSessionId) {return { cancelled: false }}
    try {
      const result = await host.cancel(bridgeSessionId, input.turnId)
      return { cancelled: !result.settled }
    } catch {
      return { cancelled: false }
    }
  }

  async answerPrompt(input: {
    sessionId: string
    itemId: string
    kind: 'approval' | 'question'
    optionId: string
    fence: number
  }): Promise<void> {
    const host = this.hosts.get(input.sessionId)
    if (!host) {throw new Error(`no live external session ${input.sessionId}`)}
    const pending = this.promptRequestByItemId.get(input.itemId)
    if (!pending || pending.sessionId !== input.sessionId) {
      throw new Error(`unknown prompt item ${input.itemId}`)
    }
    await host.answerPrompt(pending.requestId, input.optionId, false)
    this.promptRequestByItemId.delete(input.itemId)
  }

  private optionsState() {
    return {
      hosts: this.hosts,
      bridgeSessionByOrca: this.bridgeSessionByOrca,
      sessionOptions: this.sessionOptions,
      failures: this.optionRestoreFailures,
    }
  }

  async setOption(input: StructuredAgentSessionSetOptionInput) {
    return setExternalSessionOption(this.optionsState(), input)
  }

  async readOptions(input: { sessionId: string; fence: number }) {
    return readExternalSessionOptions(this.optionsState(), input)
  }

  readOptionRestoreFailures(sessionId: string): readonly string[] {
    return readExternalOptionRestoreFailures(this.optionRestoreFailures, sessionId)
  }

  async historyFilePath(): Promise<string | null> {
    return null
  }

  readCommands(): undefined {
    return undefined
  }

  async closeSession(sessionId: string): Promise<boolean> {
    return this.teardown(sessionId)
  }

  async forceCloseSession(sessionId: string): Promise<boolean> {
    return this.teardown(sessionId)
  }

  async disposeSession(sessionId: string): Promise<boolean> {
    return this.teardown(sessionId)
  }

  async closeAll(): Promise<void> {
    const ids = [...this.hosts.keys()]
    await Promise.all(ids.map((id) => this.teardown(id)))
  }

  private async teardown(sessionId: string): Promise<boolean> {
    const host = this.hosts.get(sessionId)
    const bridgeSessionId = this.bridgeSessionByOrca.get(sessionId)
    if (!host) {return false}
    let exitUnproven = false
    try {
      if (bridgeSessionId) {
        try {
          await host.release(bridgeSessionId)
        } catch {
          // Release is best-effort; dispose still proves child exit.
        }
      }
      await host.dispose()
    } catch (error) {
      // An unproven helper exit must not yield a stop receipt: the router
      // would spend it by releasing the durable lease while the helper may
      // still be alive, allowing a second owner for the same session.
      if (error instanceof BridgeUnavailableError && error.code === 'BRIDGE_EXIT_UNPROVEN') {
        exitUnproven = true
        this.unprovenSessions.add(sessionId)
      } else {
        this.unprovenSessions.delete(sessionId)
        return false
      }
    } finally {
      // Retain the host on an unproven exit so a later force-close retries
      // the kill against the same handle instead of orphaning the helper.
      if (!exitUnproven) {
        this.hosts.delete(sessionId)
      }
      this.sinks.delete(sessionId)
      const bridgeId = this.bridgeSessionByOrca.get(sessionId)
      if (bridgeId) {this.orcaSessionByBridge.delete(bridgeId)}
      this.bridgeSessionByOrca.delete(sessionId)
      this.sessionOptions.delete(sessionId)
      this.generations.delete(sessionId)
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: entries are deleted during iteration
      for (const [opId, owner] of [...this.opSession.entries()]) {
        if (owner === sessionId) {
          this.opSession.delete(opId)
          this.turns.delete(opId)
        }
      }
      // oxlint-disable-next-line unicorn/no-useless-spread -- copy-safe: entries are deleted during iteration
      for (const [itemId, pending] of [...this.promptRequestByItemId.entries()]) {
        if (pending.sessionId === sessionId) {this.promptRequestByItemId.delete(itemId)}
      }
    }
    // An unproven exit is unsettled: no stop receipt, so the durable lease
    // is never released for a helper that may still be alive.
    if (exitUnproven) {return false}
    this.unprovenSessions.delete(sessionId)
    return true
  }

  private routeSessionEvent(orcaSessionId: string, envelope: SessionEventEnvelope): void {
    const sink = this.sinks.get(orcaSessionId)
    if (!sink) {return}
    const opId = envelope.opId ?? this.latestOpFor(orcaSessionId)
    const event = envelope.event
    const turnKey = opId ?? `session:${orcaSessionId}`
    let turn = this.turns.get(turnKey)
    if (!turn) {
      turn = {
        sessionId: orcaSessionId,
        textByIndex: new Map(),
        thinkingByIndex: new Map(),
        tools: new Map(),
      }
      this.turns.set(turnKey, turn)
    }
    applyBridgeTurnEvent({
      sink,
      orcaSessionId,
      opId: turnKey,
      turn,
      event,
      promptRequests: this.promptRequestByItemId,
    })
  }

  private latestOpFor(sessionId: string): string | undefined {
    let latest: string | undefined
    for (const [opId, owner] of this.opSession.entries()) {
      if (owner === sessionId) {latest = opId}
    }
    return latest
  }

}
