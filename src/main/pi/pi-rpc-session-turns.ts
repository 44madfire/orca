// Pi RPC turn dispatch and cancellation (SNC1.9).
//
// Mechanical split of the session driver (see `pi-rpc-session-lifecycle.ts`).
// Owns single-turn honesty: at most one live turn; busy dispatches refuse
// without touching Pi; cancels abort fire-and-forget with an aborted fallback.

import type { PiRpcConnection } from './rpc/pi-rpc-connection'
import { PiRpcError } from './rpc/pi-rpc-errors'
import { validatePiDispatch } from './translation/pi-record-mapping'
import { piModelSupportsImages } from './pi-session-options'
import { createPiTurnBuffer } from './pi-event-journal'
import { PiRpcSessionLifecycle, type PiDriverDispatchResult } from './pi-rpc-session-lifecycle'
import { shortPiError } from './pi-driver-errors'

export abstract class PiRpcSessionTurns extends PiRpcSessionLifecycle {
  protected abstract synthesizeAbort(opId: string): void;

  protected static readonly catalogLookupTimeoutMs = 3_000;
  protected sessionOptions(): Record<string, string> {
    const options: Record<string, string> = {}
    if (this.optionsState.model !== undefined) {
      options['model'] = this.optionsState.model
    }
    if (this.optionsState.thinkingLevel !== undefined) {
      options['thinkingLevel'] = this.optionsState.thinkingLevel
    }
    return options
  }

  async dispatch(input: {
    text: string
    images?: { data: string; mimeType: string }[]
  }): Promise<PiDriverDispatchResult> {
    const conn = this.requireLive()
    const imageCount = input.images?.length ?? 0
    if (imageCount > 0 && this.optionsState.cachedModels === undefined) {
      await this.optionsState.catalog(conn, PiRpcSessionTurns.catalogLookupTimeoutMs)
    }
    const liveSupports =
      imageCount > 0 ? piModelSupportsImages(this.optionsState.model, this.optionsState.cachedModels) : null
    if (liveSupports === false) {
      return { status: 'rejected', reason: `model-rejects-images: ${this.optionsState.model ?? 'unknown-model'}` }
    }
    const validation = validatePiDispatch(
      { text: input.text, ...(input.images ? { images: input.images } : {}) },
      this.sessionOptions(),
      liveSupports === true ? undefined : this.optionsState.model
    )
    if (!validation.ok) {
      return { status: 'rejected', reason: validation.reason ?? 'invalid-dispatch' }
    }
    if (input.text.trimStart().startsWith('/')) {
      return this.dispatchImmediate(conn, input.text)
    }
    if (this.activeOp) {
      return { status: 'rejected', reason: 'already-streaming (wait for idle or cancel)' }
    }
    const opId = `pi-turn-${(this.opSeq += 1)}`
    this.activeOp = opId
    this.turn = createPiTurnBuffer()
    try {
      await conn.prompt(input.text, {
        ...(input.images && input.images.length > 0
          ? { images: input.images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })) }
          : {}),
        ...(this.queueMode === 'steer' || this.queueMode === 'followUp'
          ? { streamingBehavior: this.queueMode === 'steer' ? ('steer' as const) : ('followUp' as const) }
          : {})
      })
    } catch (error) {
      if (error instanceof PiRpcError && error.code === 'rejected' && !error.ambiguous) {
        this.activeOp = null
        return { status: 'rejected', reason: error.piError ? shortPiError(error) : 'pi-rejected-prompt' }
      }
      return { status: 'unknown', reason: 'pi-prompt-ambiguous (reconcile via history; do not auto-resend)' }
    }
    return { status: 'accepted' }
  }

  protected async dispatchImmediate(conn: PiRpcConnection, text: string): Promise<PiDriverDispatchResult> {
    if (this.activeOp) {
      return { status: 'rejected', reason: 'already-streaming (immediate / commands need an idle session; wait for idle or cancel)' }
    }
    const opId = `pi-immediate-${(this.opSeq += 1)}`
    this.turn = createPiTurnBuffer()
    let acceptEarly: () => void = () => undefined
    const early = new Promise<void>((resolve) => {
      acceptEarly = resolve
    })
    this.pendingImmediate = {
      opId,
      acked: false,
      accept: () => {
        if (this.pendingImmediate?.opId === opId) {
          this.pendingImmediate.acked = true
        }
        acceptEarly()
      }
    }
    const prompted = conn
      .prompt(text)
      .then((): PiDriverDispatchResult => ({ status: 'accepted' }))
      .catch((error: unknown): PiDriverDispatchResult => {
        if (error instanceof PiRpcError && error.code === 'rejected' && !error.ambiguous) {
          return { status: 'rejected', reason: error.piError ? shortPiError(error) : 'pi-rejected-prompt' }
        }
        return { status: 'unknown', reason: 'pi-prompt-ambiguous (reconcile via history; do not auto-resend)' }
      })
    const raced = await Promise.race([
      prompted,
      early.then((): PiDriverDispatchResult => ({ status: 'accepted' }))
    ])
    if (this.pendingImmediate?.opId === opId) {
      this.pendingImmediate = null
    }
    return raced
  }

  async cancel(): Promise<{ cancelled: boolean }> {
    const conn = this.conn
    if (!conn || conn.isClosed || !this.activeOp) {
      return { cancelled: false }
    }
    const opId = this.activeOp
    this.optionsState.retirePromptsForOp(opId)
    try {
      await conn.abort()
    } catch {
      this.synthesizeAbort(opId)
    }
    return { cancelled: true }
  }
}
