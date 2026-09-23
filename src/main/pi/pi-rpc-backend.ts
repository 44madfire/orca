// Production Pi RPC backend (SNC1.9 native Pi).
//
// Implements `PiStructuredBackend` over first-party per-session drivers
// (`pi-rpc-session-driver`): exactly one `pi --mode rpc` child per Orca
// structured session, spawned in the Orca-selected workspaceRoot through
// Orca's child-process chokepoint. Journal-visible prompt ids are the
// driver's Pi-local ids; answers route by journal item key, so no
// cross-session namespacing is needed (unlike the external bridge, where op
// ids crossed processes). Image bytes are read host-side bounded and never
// journaled or logged; filesystem errors are mapped to path-free refusals.
//
// Provenance: the vendored transport was smoke-probed live against a real
// `pi --mode rpc` binary (read-only `get_state` / catalog / entries / stats
// plus clean close; no prompt dispatch, so live turn streaming is covered by
// the scripted-child suite only). Turn/option/history semantics follow the
// orca-pi bridge provider as reference.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import type { PiFamilyPromptFact } from './translation/pi-family-record-dialect'
import {
  PiRpcSessionDriver,
  type PiDriverAcquireResult,
  type PiDriverDeps
} from './pi-rpc-session-driver'
import { collectPiDispatchContent } from './pi-dispatch-images'
import type {
  PiStructuredAcquireResult,
  PiStructuredBackend,
  PiStructuredDispatchResult
} from './pi-structured-backend'

export type PiRpcBackendDeps = PiDriverDeps

export function createPiRpcBackend(deps: PiRpcBackendDeps = {}): PiStructuredBackend {
  const drivers = new Map<string, PiRpcSessionDriver>()

  const requireDriver = (orcaSessionId: string): PiRpcSessionDriver => {
    const driver = drivers.get(orcaSessionId)
    if (!driver) {
      throw new Error(`no live pi structured session for ${orcaSessionId}`)
    }
    return driver
  }

  return {
    async acquire(input: {
      orcaSessionId: string
      workspaceRoot: string
      provider?: PiFamilyProvider
      resumePiSessionId?: string
      resumeSessionFile?: string
      options?: Readonly<Record<string, string>>
      spawnToken: string
      sink?: StructuredAgentSessionEventSink | null
      /** Per-session provider-record observer for dispatch settlement (PIF-4, #25). */
      onRecord?: (record: Record<string, unknown>) => void
    }): Promise<PiStructuredAcquireResult> {
      const stale = drivers.get(input.orcaSessionId)
      if (stale) {
        let closed = false
        try {
          closed = await stale.close()
        } catch {
          throw new Error('PI_STALE_SESSION_UNCLOSED: previous Pi session teardown failed')
        }
        if (!closed) {
          throw new Error('PI_STALE_SESSION_UNCLOSED: previous Pi session exit was not proven')
        }
        drivers.delete(input.orcaSessionId)
      }
      // Generation fencing: a superseded driver's late exit must not publish
      // against its replacement. Only the indexed driver (or one racing an
      // empty slot mid-acquire) may forward unexpected exits.
      let driver: PiRpcSessionDriver
      const driverDeps: PiDriverDeps = {
        ...deps,
        onUnexpectedExit: (sessionId) => {
          const current = drivers.get(sessionId)
          if (current === driver || current === undefined) {
            deps.onUnexpectedExit?.(sessionId)
          }
        }
      }
      driver = new PiRpcSessionDriver(input.orcaSessionId, driverDeps)
      // Bound before the first prompt can land so no settle/prompt_result frame is missed.
      driver.recordObserver = input.onRecord ?? null
      let acquired: PiDriverAcquireResult
      try {
        acquired = await driver.acquire({
          workspaceRoot: input.workspaceRoot,
          ...(input.provider !== undefined ? { provider: input.provider } : {}),
          ...(input.resumeSessionFile !== undefined
            ? { resumeSessionFile: input.resumeSessionFile }
            : {}),
          ...(input.resumePiSessionId !== undefined
            ? { resumePiSessionId: input.resumePiSessionId }
            : {}),
          ...(input.options !== undefined ? { options: input.options } : {}),
          spawnToken: input.spawnToken,
          ...(input.sink !== undefined ? { sink: input.sink } : {})
        })
      } catch (error) {
        let closed = false
        try {
          closed = await driver.close()
        } catch {
          // Keep the failed driver registered below so a retry must reconcile it.
        }
        if (!closed) {
          drivers.set(input.orcaSessionId, driver)
          throw new Error('PI_ACQUIRE_UNCLOSED: failed Pi session teardown was not proven')
        }
        throw error
      }
      drivers.set(input.orcaSessionId, driver)
      // Best-effort dialect command pull; failures leave the catalog absent (never fabricated).
      await driver.refreshCommands()
      return {
        piSessionId: acquired.piSessionId,
        leafId: acquired.leafId,
        pid: acquired.pid,
        ...(acquired.sessionFile ? { sessionFilePath: acquired.sessionFile } : {}),
        ...(acquired.model !== undefined ? { model: acquired.model } : {}),
        ...(acquired.thinkingLevel !== undefined ? { thinkingLevel: acquired.thinkingLevel } : {})
      }
    },

    async dispatch(input: {
      orcaSessionId: string
      body: AgentJournalMessageItem
    }): Promise<PiStructuredDispatchResult> {
      // A dead/unknown session never reached Pi, so the turn is honestly
      // `rejected` (safe to retry on a fresh session), never `unknown`
      // (which would force history reconciliation first). Mirrors the
      // proven bridge provider's `unknown-session` / `pi-exited` verdicts.
      let driver: PiRpcSessionDriver
      try {
        driver = requireDriver(input.orcaSessionId)
      } catch {
        return { status: 'rejected', reason: 'unknown-session' }
      }
      let text: string
      let images: { data: string; mimeType: string }[] | undefined
      try {
        const content = await collectPiDispatchContent(input.body)
        text = content.text
        images = content.images.length > 0 ? content.images : undefined
      } catch (error) {
        return { status: 'rejected', reason: sanitizeImageError(error) }
      }
      try {
        return await driver.dispatch({
          text,
          ...(images ? { images } : {})
        })
      } catch (error) {
        return { status: 'rejected', reason: sanitizeDispatchError(error) }
      }
    },

    async cancel(input: { orcaSessionId: string }): Promise<{ cancelled: boolean }> {
      return requireDriver(input.orcaSessionId).cancel()
    },

    drainPromptFacts(input: { orcaSessionId: string }): PiFamilyPromptFact[] {
      const driver = drivers.get(input.orcaSessionId)
      return driver ? driver.drainFamilyFacts() : []
    },

    async readEntries(input: {
      orcaSessionId: string
      since?: string
    }): Promise<{ entries: readonly unknown[]; leafId: string }> {
      return requireDriver(input.orcaSessionId).readHistoryEntries(input.since)
    },

    async close(input: { orcaSessionId: string }): Promise<boolean> {
      const driver = drivers.get(input.orcaSessionId)
      if (!driver) {
        return true
      }
      const proven = await driver.close()
      if (proven) {
        drivers.delete(input.orcaSessionId)
      }
      return proven
    },

    async sessionFilePath(input: { orcaSessionId: string }): Promise<string | null> {
      const driver = drivers.get(input.orcaSessionId)
      return driver ? driver.getSessionFile() : null
    },

    async answerPrompt(input: {
      itemKey: string
      kind: 'approval' | 'question'
      optionId: string
    }): Promise<void> {
      for (const driver of drivers.values()) {
        const tracked = driver.promptTracker.get(input.itemKey)
        if (tracked) {
          driver.answerPrompt(tracked.requestId, { kind: input.kind, optionId: input.optionId })
          return
        }
      }
      throw new Error('UNKNOWN_REQUEST: unknown prompt request (already answered or retired)')
    },

    async setOption(input: {
      orcaSessionId: string
      key: string
      value: string
    }): Promise<Record<string, string>> {
      return requireDriver(input.orcaSessionId).applyOptions({ [input.key]: input.value })
    },

    async readOptions(input: { orcaSessionId: string }): Promise<{
      options: Record<string, string>
      model: string | undefined
      thinkingLevel: string | undefined
    }> {
      return requireDriver(input.orcaSessionId).readOptions()
    },

    async listModels(input: {
      orcaSessionId: string
    }): Promise<{ id: string; provider: string }[]> {
      return requireDriver(input.orcaSessionId).listModels()
    },

    async listThinkingLevels(input: { orcaSessionId: string }): Promise<string[]> {
      return requireDriver(input.orcaSessionId).listThinkingLevels()
    },

    readCommands(input: { orcaSessionId: string }) {
      return drivers.get(input.orcaSessionId)?.readCommands()
    },

    async refreshCommands(input: { orcaSessionId: string }) {
      return requireDriver(input.orcaSessionId).refreshCommands()
    },

    async compact(input: { orcaSessionId: string }): Promise<{ error?: string }> {
      return requireDriver(input.orcaSessionId).compact()
    },

    async readResumeHistory(input: { orcaSessionId: string }): Promise<{
      rows: { id: string; role: string; text: string }[]
      leafId: string
    }> {
      return requireDriver(input.orcaSessionId).readResumeHistory()
    }
  }
}

function sanitizeDispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const singleLine = message
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 220)
  if (/^(pi-exited|no live pi structured session)/.test(singleLine)) {
    return singleLine
  }
  return 'pi-dispatch-failed (reacquire the session and retry)'
}

function sanitizeImageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /^Pi (image|messages) /.test(message) ||
    message === 'image reference has neither a path nor a URL'
  ) {
    return message
  }
  return 'Pi image could not be read (missing or unreadable file)'
}
