// Pi model/thinking/prompt/image controls over live Pi RPC (SNC1.9).
//
// Mirrors the proven orca-pi `pi-provider.ts` SNC1.6 semantics: model refs are
// exact `provider/modelId` or exact unique bare `modelId` (no fuzzy/prefix);
// thinking levels must exactly match Pi's live list (Pi itself would silently
// fall back to `minimal`, so this fails closed instead); image support reads
// the live catalog when cached with static hints as the floor; prompt answers
// are exactly-once with stale/late `UNKNOWN_REQUEST` refusal and retirement
// on settle/cancel/exit/close. Error text is secret-safe (codes and safe
// summaries only, never prompt text, paths, or image bytes).

import type { PiModel } from './rpc/pi-wire-protocol'
import { PI_KNOWN_THINKING_LEVELS } from './translation/pi-record-mapping'

export type PiOptionConnection = {
  getAvailableModels(opts?: { timeoutMs?: number }): Promise<{ models: PiModel[] }>
  setModel(provider: string, modelId: string, opts?: { timeoutMs?: number }): Promise<PiModel>
  getAvailableThinkingLevels(opts?: { timeoutMs?: number }): Promise<{ levels: string[] }>
  setThinkingLevel(level: string, opts?: { timeoutMs?: number }): Promise<void>
  setAutoCompaction?(enabled: boolean, opts?: { timeoutMs?: number }): Promise<void>
  respondToExtensionUi(response: {
    type: 'extension_ui_response'
    id: string
    value?: unknown
    confirmed?: boolean
    cancelled?: boolean
  }): void
}

/** Pi models known to accept image input (prefix hint; live catalog wins). */
const PI_IMAGE_CAPABLE_HINTS = ['glm', 'gpt', 'claude', 'gemini', 'vision'] as const

export function piModelSupportsImages(
  model: string | undefined,
  cachedModels: readonly PiModel[] | undefined
): boolean | null {
  if (cachedModels !== undefined) {
    const match = cachedModels.find(
      (entry) =>
        entry.id === model ||
        (typeof model === 'string' && `${entry.provider}/${entry.id}` === model)
    )
    if (match) {
      const supports = (match as { supportsImages?: unknown }).supportsImages
      if (typeof supports === 'boolean') {
        return supports
      }
      return null
    }
    return null
  }
  if (model === undefined) {
    return null
  }
  return PI_IMAGE_CAPABLE_HINTS.some((hint) => model.toLowerCase().includes(hint))
}

export type PiModelRef = { ok: true; provider: string; modelId: string } | { ok: false; code: string; message: string }

/** Exact model resolution: qualified `provider/modelId`, or a bare id unique in the catalog. */
export function resolvePiModelRef(requested: string, models: readonly PiModel[]): PiModelRef {
  const trimmed = requested.trim()
  if (trimmed === '') {
    return { ok: false, code: 'UNKNOWN_MODEL', message: 'unknown model: empty model ref (use provider/modelId or exact model id)' }
  }
  const slash = trimmed.indexOf('/')
  if (slash !== -1) {
    const providerPart = trimmed.slice(0, slash)
    const idPart = trimmed.slice(slash + 1)
    if (providerPart === '' || idPart === '') {
      return { ok: false, code: 'UNKNOWN_MODEL', message: 'unknown model: use provider/modelId or exact model id' }
    }
    const matched = models.find((entry) => entry.provider === providerPart && entry.id === idPart)
    if (!matched) {
      return { ok: false, code: 'UNKNOWN_MODEL', message: 'unknown model: no exact provider/modelId match' }
    }
    return { ok: true, provider: matched.provider, modelId: matched.id }
  }
  const hits = models.filter((entry) => entry.id === trimmed)
  if (hits.length === 0) {
    return { ok: false, code: 'UNKNOWN_MODEL', message: 'unknown model: no exact model id match' }
  }
  if (hits.length > 1) {
    return { ok: false, code: 'AMBIGUOUS_MODEL', message: `ambiguous model: ${trimmed} matches ${hits.length} providers; use provider/modelId` }
  }
  const only = hits[0]!
  return { ok: true, provider: only.provider, modelId: only.id }
}

export function validatePiThinkingLevel(
  level: string,
  liveLevels: readonly string[]
): { ok: true } | { ok: false; code: string; message: string } {
  if (liveLevels.includes(level)) {
    return { ok: true }
  }
  if ((PI_KNOWN_THINKING_LEVELS as readonly string[]).includes(level)) {
    return {
      ok: false,
      code: 'UNKNOWN_THINKING_LEVEL',
      message: `unknown thinking level for this model: ${level}`
    }
  }
  return { ok: false, code: 'UNKNOWN_THINKING_LEVEL', message: `unknown thinking level: ${level}` }
}

export function qualifyPiModelRef(model: PiModel | undefined): string | undefined {
  if (typeof model?.id !== 'string' || model.id === '') {
    return undefined
  }
  if (typeof model?.provider === 'string' && model.provider !== '') {
    return `${model.provider}/${model.id}`
  }
  return model.id
}

/**
 * Per-session Pi option/prompt state. One instance per Pi child: prompt ids
 * are child-local, so no cross-session namespacing is needed inside; the
 * backend namespaces journal-visible ids per Orca session.
 */
export class PiSessionOptionState {
  readonly pendingPrompts = new Map<string, string>()
  cachedModels: PiModel[] | undefined
  private catalogInflight: Promise<PiModel[] | null> | null = null
  model: string | undefined
  thinkingLevel: string | undefined
  autoCompaction: boolean | undefined

  /** Bounded shared catalog lookup; failures leave the cache absent (hint floor). */
  async catalog(conn: PiOptionConnection, timeoutMs: number): Promise<PiModel[] | null> {
    if (this.cachedModels !== undefined) {
      return this.cachedModels
    }
    if (!this.catalogInflight) {
      this.catalogInflight = conn
        .getAvailableModels({ timeoutMs })
        .then((result) => {
          this.cachedModels = [...result.models]
          return this.cachedModels
        })
        .catch(() => null)
        .finally(() => {
          this.catalogInflight = null
        })
    }
    return this.catalogInflight
  }

  /** Track a Pi dialog for exactly-once answers; duplicate Pi ids stay ignored. */
  trackPrompt(piId: string, opId: string): boolean {
    if (piId === '' || this.pendingPrompts.has(piId)) {
      return false
    }
    this.pendingPrompts.set(piId, opId)
    return true
  }

  /**
   * Consume one pending dialog and forward a single `extension_ui_response`.
   * Unknown/answered/retired ids throw `UNKNOWN_REQUEST` without touching Pi.
   */
  answerPrompt(
    conn: PiOptionConnection,
    piId: string,
    answer: { kind: 'approval' | 'question'; optionId: string; empty?: true }
  ): void {
    if (!this.pendingPrompts.has(piId)) {
      throw new Error('UNKNOWN_REQUEST: unknown prompt request (already answered or retired)')
    }
    this.pendingPrompts.delete(piId)
    const response = toExtensionUiResponse(piId, answer)
    try {
      conn.respondToExtensionUi(response)
    } catch {
      // Pi is gone; the turn settles via exit handling. The answer stays
      // consumed so a retry after reacquire is a fresh id, never a duplicate.
    }
  }

  /** Retire every dialog for one op (settle/cancel); late answers turn stale. */
  retirePromptsForOp(opId: string): void {
    for (const [piId, owner] of Array.from(this.pendingPrompts)) {
      if (owner === opId) {
        this.pendingPrompts.delete(piId)
      }
    }
  }

  retireAllPrompts(): void {
    this.pendingPrompts.clear()
  }
}

function toExtensionUiResponse(
  piId: string,
  answer: { kind: 'approval' | 'question'; optionId: string; empty?: true }
): { type: 'extension_ui_response'; id: string; value?: unknown; confirmed?: boolean; cancelled?: boolean } {
  // Free-text dialogs have no text channel in the structured contract: answer
  // with an unset value (unblocks Pi) rather than fabricating prompt text.
  if (answer.empty === true) {
    return { type: 'extension_ui_response', id: piId }
  }
  if (answer.kind === 'approval') {
    if (answer.optionId === 'cancel') {
      return { type: 'extension_ui_response', id: piId, cancelled: true }
    }
    if (answer.optionId === 'confirm') {
      return { type: 'extension_ui_response', id: piId, confirmed: true }
    }
    return { type: 'extension_ui_response', id: piId, value: answer.optionId }
  }
  return { type: 'extension_ui_response', id: piId, value: answer.optionId }
}
