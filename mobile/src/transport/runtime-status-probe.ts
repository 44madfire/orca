import type { RpcClient } from './rpc-client'
import type { RpcSuccess } from './types'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay→direct cutover or request timeout can reject an in-flight
// status.get without ever changing connState, so a one-shot probe would latch
// capability-gated UI hidden until the screen remounts; retry until one lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

export type RuntimeStatusProbeHandlers = {
  onStatus: (status: Record<string, unknown>) => void
  // Fires once per attempt that produced no status, with a retry always armed: an unanswered
  // request backs off from 1 s, an answered error re-asks at the 15 s ceiling. Either way a
  // caller that must not stay blocked can fail open on the first miss and be upgraded later.
  onUnavailable?: (retrying: true) => void
}

// Single status.get producer for a connected client: one request, retried until it
// lands. Callers share the answer instead of each issuing their own status.get.
export function startRuntimeStatusProbe(
  client: Pick<RpcClient, 'sendRequest'>,
  handlers: RuntimeStatusProbeHandlers
): () => void {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0

  function attempt(): void {
    void client.sendRequest('status.get').then(
      (response) => {
        if (cancelled) {
          return
        }
        if (!response.ok) {
          // Why retry: an error reply is a definitive answer for this attempt, not for the
          // connection. A transient host failure or an error frame surfaced by the relay must
          // not withhold worktree.activate and every capability until the socket is replaced.
          // Backed off to the 15 s ceiling so a host that keeps saying no is not hammered.
          scheduleRetry(false, true)
          return
        }
        const result = (response as RpcSuccess).result
        handlers.onStatus(
          result && typeof result === 'object' ? (result as Record<string, unknown>) : {}
        )
      },
      (error: unknown) => {
        if (cancelled) {
          return
        }
        scheduleRetry(isLogicalClientCutoverError(error))
      }
    )
  }

  function scheduleRetry(cutover: boolean, answered = false): void {
    // Why: cutover means the replacement transport is already authenticated —
    // re-ask promptly; other failures back off so a wedged host isn't hammered.
    // An answered error skips straight to the ceiling: the host is reachable and
    // said no, so only a slow re-ask is worth anything.
    const delay = cutover
      ? CUTOVER_RETRY_DELAY_MS
      : answered
        ? FAILURE_RETRY_MAX_DELAY_MS
        : Math.min(FAILURE_RETRY_BASE_DELAY_MS * 2 ** failureRetries++, FAILURE_RETRY_MAX_DELAY_MS)
    retryTimer = setTimeout(attempt, delay)
    handlers.onUnavailable?.(true)
  }

  attempt()
  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
  }
}

export function readRuntimeCapabilities(status: Record<string, unknown>): readonly string[] {
  const raw = status.capabilities
  return Array.isArray(raw) && raw.every((value) => typeof value === 'string') ? raw : []
}

export function startRuntimeCapabilityProbe(
  client: Pick<RpcClient, 'sendRequest'>,
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  return startRuntimeStatusProbe(client, {
    onStatus: (status) => onCapabilities(readRuntimeCapabilities(status))
  })
}
