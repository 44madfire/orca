// First-party Pi RPC session driver (SNC1.9 native Pi).
//
// Mechanical split of the session driver (see `pi-rpc-session-lifecycle.ts`).
// Owns Pi event streaming into the journal, exactly-once prompt answers,
// exact-match options, and wholesale history rebuilds. Journal rows come only
// from streamed Pi events under stable turn-scoped keys, so finals reconcile
// rather than duplicate. Failures are actionable `PI_*` errors without paths,
// prompt text, or bytes.

import { mapPiRecordToSessionEvents } from './translation/pi-record-mapping'
import { PiFamilyFactTray, type PiFamilyPromptFact } from './translation/pi-family-record-dialect'
import { applyPiSessionEvent } from './pi-event-journal'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import { PiFamilyAcquisitionGate } from './pi-family-acquisition-window'
import { qualifyPiModelRef, resolvePiModelRef, validatePiThinkingLevel } from './pi-session-options'
import { shortPiError } from './pi-driver-errors'
import { rebuildPiHistory } from './pi-rpc-session-resume'
import { PiRpcSessionTurns } from './pi-rpc-session-turns'
import type { PiSessionEvent } from './translation/pi-session-events'
import { PiRpcError } from './rpc/pi-rpc-errors'
import { PiFamilyCommandCatalog } from './pi-family-commands'
import type { AgentSessionSlashCommand } from '../../shared/agent-session-wire'

export class PiRpcSessionDriver extends PiRpcSessionTurns {
  private readonly commandCatalog = new PiFamilyCommandCatalog()
  private familyProvider: PiFamilyProvider = 'pi'
  private streamGate: PiFamilyAcquisitionGate | null = null
  private readonly factTray = new PiFamilyFactTray()
  protected beginAcquisitionWindow(): void {
    const gate = new PiFamilyAcquisitionGate(this.deps.acquisitionBufferLimits)
    this.streamGate = gate
    gate.begin(this.conn, (record) => this.handlePiRecord(record))
  }

  protected finishAcquisitionWindow(): void {
    const gate = this.streamGate
    const conn = this.conn
    if (!gate || !conn) {
      return
    }
    this.familyProvider = conn.familyProvider
    gate.finish(conn, this.sink, (record) => this.deliverPiRecord(record))
  }

  protected teardownAcquisitionState(): void {
    this.streamGate?.teardown()
    this.streamGate = null
  }

  /** Narrow #25 seam: prompt/catalog facts since the last drain. */
  drainFamilyFacts(): PiFamilyPromptFact[] {
    return this.factTray.drain()
  }

  async readResumeHistory(): Promise<{
    rows: { id: string; role: string; text: string }[]
    leafId: string
  }> {
    const conn = this.requireLive()
    const rebuilt = await rebuildPiHistory(conn, {
      timeoutMs: this.optionTimeout,
      busy: this.activeOp !== null,
      closed: false,
      provider: this.familyProvider
    })
    if (!rebuilt.ok) {
      throw new Error(`${rebuilt.code}: ${rebuilt.message}`)
    }
    this.leafId = rebuilt.history.leafId
    return {
      leafId: rebuilt.history.leafId,
      rows: rebuilt.history.rows.map((row) => ({
        id: row.id,
        role: row.role,
        text: row.text ?? ''
      }))
    }
  }

  answerPrompt(piId: string, answer: { kind: 'approval' | 'question'; optionId: string }): void {
    const conn = this.requireLive()
    const emptySubmit = answer.kind === 'question' && answer.optionId === 'submit'
    this.optionsState.answerPrompt(conn, piId, emptySubmit ? { ...answer, empty: true } : answer)
  }

  async applyOptions(options: Readonly<Record<string, string>>): Promise<Record<string, string>> {
    const conn = this.requireLive()
    const confirmed: Record<string, string> = {}
    if (options['model'] !== undefined) {
      const models = await this.optionsState.catalog(conn, this.optionTimeout)
      if (!models) {
        throw new Error('PI_OPTION_FAILED: model operations unavailable')
      }
      const resolved = resolvePiModelRef(options['model'], models)
      if (!resolved.ok) {
        throw new Error(`${resolved.code}: ${resolved.message}`)
      }
      try {
        const applied = await conn.setModel(resolved.provider, resolved.modelId, {
          timeoutMs: this.optionTimeout
        })
        const qualified = qualifyPiModelRef(applied) ?? `${resolved.provider}/${resolved.modelId}`
        this.optionsState.model = qualified
        this.optionsState.cachedModels = undefined
        await this.optionsState.catalog(conn, this.optionTimeout)
        confirmed['model'] = qualified
      } catch (error) {
        throw new Error(`PI_OPTION_FAILED: set_model failed (${shortPiError(error)})`)
      }
    }
    if (options['thinkingLevel'] !== undefined) {
      const wanted = options['thinkingLevel']
      let levels: readonly string[] = []
      try {
        levels = (await conn.getAvailableThinkingLevels({ timeoutMs: this.optionTimeout })).levels
      } catch (error) {
        throw new Error(
          `PI_OPTION_FAILED: thinking-level operations unavailable (${shortPiError(error)})`
        )
      }
      const valid = validatePiThinkingLevel(wanted, levels)
      if (!valid.ok) {
        throw new Error(`${valid.code}: ${valid.message}`)
      }
      try {
        await conn.setThinkingLevel(wanted, { timeoutMs: this.optionTimeout })
        this.optionsState.thinkingLevel = wanted
        confirmed['thinkingLevel'] = wanted
      } catch (error) {
        throw new Error(`PI_OPTION_FAILED: set_thinking_level failed (${shortPiError(error)})`)
      }
    }
    if (options['queueMode'] !== undefined) {
      const mode = options['queueMode']
      if (mode !== 'reject' && mode !== 'steer' && mode !== 'followUp') {
        throw new Error(`PI_OPTION_FAILED: invalid queueMode ${mode}`)
      }
      this.queueMode = mode
      confirmed['queueMode'] = mode
    }
    if (options['autoCompaction'] !== undefined) {
      const raw = options['autoCompaction']
      if (raw !== 'true' && raw !== 'false') {
        throw new Error(`PI_OPTION_FAILED: invalid autoCompaction ${raw}`)
      }
      try {
        await conn.setAutoCompaction(raw === 'true', { timeoutMs: this.optionTimeout })
        this.autoCompaction = raw === 'true'
        confirmed['autoCompaction'] = raw
      } catch (error) {
        throw new Error(`PI_OPTION_FAILED: set_auto_compaction failed (${shortPiError(error)})`)
      }
    }
    return confirmed
  }

  async readOptions(): Promise<{
    options: Record<string, string>
    model: string | undefined
    thinkingLevel: string | undefined
  }> {
    // Provider-confirmed state only: never serve optimistic local values.
    const conn = this.requireLive()
    let state: Awaited<ReturnType<typeof conn.getState>>
    try {
      state = await conn.getState({ timeoutMs: this.optionTimeout })
    } catch (error) {
      throw new Error(`PI_STATE_FAILED: option read failed (${shortPiError(error)})`)
    }
    const model = qualifyPiModelRef(state.model)
    this.optionsState.model = model === undefined ? undefined : model
    if (typeof state.thinkingLevel === 'string') {
      this.optionsState.thinkingLevel = state.thinkingLevel
    }
    if (typeof state.autoCompactionEnabled === 'boolean') {
      this.autoCompaction = state.autoCompactionEnabled
    }
    const options: Record<string, string> = {}
    if (this.optionsState.model !== undefined) {
      options['model'] = this.optionsState.model
    }
    if (this.optionsState.thinkingLevel !== undefined) {
      options['thinkingLevel'] = this.optionsState.thinkingLevel
    }
    if (this.queueMode !== undefined) {
      options['queueMode'] = this.queueMode
    }
    if (this.autoCompaction !== undefined) {
      options['autoCompaction'] = String(this.autoCompaction)
    }
    return {
      options,
      model: this.optionsState.model,
      thinkingLevel: this.optionsState.thinkingLevel
    }
  }

  async listModels(): Promise<{ id: string; provider: string }[]> {
    const conn = this.requireLive()
    const models = await this.optionsState.catalog(conn, this.optionTimeout)
    return (models ?? []).map((entry) => ({ id: entry.id, provider: entry.provider }))
  }

  async listThinkingLevels(): Promise<string[]> {
    const conn = this.requireLive()
    return [...(await conn.getAvailableThinkingLevels({ timeoutMs: this.optionTimeout })).levels]
  }

  async compact(): Promise<{ error?: string }> {
    const conn = this.requireLive()
    try {
      await conn.compact({ timeoutMs: this.optionTimeout })
      return {}
    } catch (error) {
      // Definite provider refusal maps to {error}; transport ambiguity
      // throws so the host marks the outcome unknown (never auto-resent).
      if (error instanceof PiRpcError && error.code === 'rejected' && !error.ambiguous) {
        const message = shortPiError(error)
        return { error: message === '' ? 'Compaction was not confirmed by the provider.' : message }
      }
      throw error
    }
  }

  readCommands(): AgentSessionSlashCommand[] | undefined {
    return this.commandCatalog.snapshot()
  }

  async refreshCommands(): Promise<AgentSessionSlashCommand[] | undefined> {
    return this.commandCatalog.refresh(this.requireLive(), this.optionTimeout)
  }

  protected handlePiRecord(record: Record<string, unknown>): void {
    if (this.closed || this.closing) {
      return
    }
    this.deliverPiRecord(record)
  }

  private deliverPiRecord(record: Record<string, unknown>): void {
    // Dispatch settlement observes every record here: steady-state records bypass
    // handlePiRecord via the acquisition gate. The observer must never throw.
    this.recordObserver?.(record)
    if (record['type'] === 'thinking_level_changed' && typeof record['level'] === 'string') {
      this.optionsState.thinkingLevel = record['level']
    }
    // OMP pushed catalog refresh on the normal event path (no second
    // subscription); Pi stays pull-based and ignores this frame.
    this.commandCatalog.observePush(record, this.conn?.familyProvider ?? 'pi')
    this.factTray.observe(record)
    if (this.activeOp) {
      let events: PiSessionEvent[]
      try {
        events = this.translator.applyPiRecord(record, this.familyProvider)
      } catch {
        return
      }
      const opId = this.activeOp
      for (const event of events) {
        if (event.type === 'prompt_request') {
          this.optionsState.trackPrompt(event.requestId, opId)
        }
        if (event.type === 'turn_end') {
          this.translator.drainTurnEnd()
        }
        if (event.type === 'settled') {
          this.translator.settle()
          if (this.activeOp === opId) {
            this.activeOp = null
          }
          this.optionsState.retirePromptsForOp(opId)
          void this.refreshSessionFile()
        }
        this.journalEvent(opId, event)
      }
      return
    }
    let stateless: PiSessionEvent[]
    try {
      stateless = mapPiRecordToSessionEvents(record)
    } catch {
      return
    }
    for (const event of stateless) {
      if (event.type !== 'prompt_request') {
        continue
      }
      const immediate = this.pendingImmediate
      if (immediate && !immediate.acked) {
        immediate.acked = true
        this.optionsState.trackPrompt(event.requestId, immediate.opId)
        this.journalEvent(immediate.opId, event)
        immediate.accept()
        continue
      }
      this.optionsState.trackPrompt(event.requestId, '')
      this.journalEvent(`pi-immediate-${event.requestId}`, event)
    }
  }

  protected journalEvent(opId: string, event: PiSessionEvent): void {
    const sink = this.sink
    if (!sink || this.closed || this.closing) {
      return
    }
    applyPiSessionEvent({
      sink,
      orcaSessionId: this.orcaSessionId,
      opId,
      turn: this.turn,
      event,
      promptTracker: this.promptTracker,
      provider: this.familyProvider
    })
  }
}

export type {
  PiDriverAcquireInput,
  PiDriverAcquireResult,
  PiDriverDispatchResult,
  PiDriverDeps
} from './pi-rpc-session-lifecycle'
