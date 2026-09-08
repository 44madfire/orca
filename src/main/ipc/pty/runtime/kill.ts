import type { IPtyProvider } from '../../../providers/types'
import { SSH_PROVIDER_UNREGISTERED_REASON } from '../../../../shared/pty-liveness-verdict'
import { parseAppSshPtyId } from '../../../providers/ssh-pty-id'
import { ptyOwnership, ptyIncarnationById } from '../provider/ownership-state'
import { getProvider, getProviderForPty } from '../provider/registry'
import { isPtyAlreadyGoneError, delay, verifyPtyStopped } from '../provider/liveness'
import { recordUndeliveredSshPtyKill } from './undelivered-ssh-kill'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { assertPtyHibernationAllowed } from '../pane/hibernation-admission'

export function killPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string
): boolean {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown,
    retiredRejectedPtyIds,
    reversibleStopOwnersByPtyId
  } = deps
  runtime?.markPtyStopRequested?.(ptyId)
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const recordUndelivered = (incarnationId?: string): void => {
    recordUndeliveredSshPtyKill({
      store,
      ptyId,
      connectionId,
      reversible: reversibleStopOwnersByPtyId.has(ptyId),
      incarnationId
    })
  }
  const killWithCurrentProvider = (): boolean => {
    let provider: IPtyProvider
    try {
      provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
    } catch {
      if (connectionId) {
        // Tombstone detached SSH ownership so reconnect cannot revive a closed terminal.
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
        // The relay was never asked, so the remote shell is still running. Keep the order.
        recordUndelivered(incarnationId)
        runtime?.onPtyExit(ptyId, -1, incarnationId)
        rememberSyntheticKillExit(ptyId)
        sendPtyExitToRenderer({
          id: ptyId,
          code: -1,
          ...(incarnationId ? { incarnationId } : {})
        })
        runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
        return false
      }
      return false
    }
    // Why: controller is synchronous, but keep ownership until async shutdown proves whether the provider emitted an exit.
    void shutdownProviderAndDetectExit(provider, ptyId, { immediate: false })
      .then((providerExitObserved) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
        if (!providerExitObserved && !retired) {
          runtime?.onPtyExit(ptyId, -1, incarnationId)
          rememberSyntheticKillExit(ptyId)
          sendPtyExitToRenderer({
            id: ptyId,
            code: -1,
            ...(incarnationId ? { incarnationId } : {})
          })
        }
      })
      .catch((err) => {
        const retired = retiredRejectedPtyIds.has(ptyId)
        if (isPtyAlreadyGoneError(err)) {
          const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
          if (!retired) {
            runtime?.onPtyExit(ptyId, -1, incarnationId)
            rememberSyntheticKillExit(ptyId)
            sendPtyExitToRenderer({
              id: ptyId,
              code: -1,
              ...(incarnationId ? { incarnationId } : {})
            })
          }
          return
        }
        console.warn(
          `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
        )
        // Preserve ownership so a failed shutdown can be retried.
        if (!retired) {
          if (connectionId) {
            runtime?.markPtyLivenessUnverifiable?.(
              ptyId,
              err instanceof Error ? err.message : String(err)
            )
          }
          runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
        }
        // The remote process can outlive even a retired client's bookkeeping.
        recordUndelivered()
      })
    return true
  }
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    // Why: select the provider after the daemon swap; the fallback first can report success while orphaning a daemon PTY.
    void startupPromise.then(killWithCurrentProvider).catch((err) => {
      console.warn(
        `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
      )
      if (!retiredRejectedPtyIds.has(ptyId)) {
        if (connectionId) {
          runtime?.markPtyLivenessUnverifiable?.(
            ptyId,
            err instanceof Error ? err.message : String(err)
          )
        }
        runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
      }
      recordUndelivered()
    })
    return true
  }
  return killWithCurrentProvider()
}

export function retireRejectedPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  stopConfirmed: boolean
): void {
  const {
    runtime,
    store,
    rememberRetiredRejectedPty,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown
  } = deps
  rememberRetiredRejectedPty(ptyId)
  if (!stopConfirmed) {
    runtime?.markPtyLivenessUnverifiable?.(
      ptyId,
      'a follow-up stop was issued but its outcome could not be verified'
    )
    if (!ptyOwnership.has(ptyId)) {
      return
    }
    runtime?.onPtyExit(ptyId, -1, ptyIncarnationById.get(ptyId))
    rememberSyntheticKillExit(ptyId)
    sendPtyExitToRenderer({
      id: ptyId,
      code: -1,
      ...(ptyIncarnationById.get(ptyId) ? { incarnationId: ptyIncarnationById.get(ptyId) } : {})
    })
    return
  }
  // An already completed stop needs only runtime confirmation, never a second renderer exit.
  if (!ptyOwnership.has(ptyId)) {
    runtime?.onPtyExit(ptyId, 0, ptyIncarnationById.get(ptyId))
    return
  }
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  runtime?.onPtyExit(ptyId, 0, incarnationId)
  rememberSyntheticKillExit(ptyId)
  sendPtyExitToRenderer({
    id: ptyId,
    code: 0,
    ...(incarnationId ? { incarnationId } : {})
  })
}

export function markReversibleStopsFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyIds: readonly string[]
): () => void {
  const { reversibleStopOwnersByPtyId } = deps
  for (const ptyId of ptyIds) {
    reversibleStopOwnersByPtyId.set(ptyId, (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) + 1)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const ptyId of ptyIds) {
      const owners = (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) - 1
      if (owners > 0) {
        reversibleStopOwnersByPtyId.set(ptyId, owners)
      } else {
        reversibleStopOwnersByPtyId.delete(ptyId)
      }
    }
  }
}

// Failed reversible stops leave the pane live, so they must never persist a replayable kill.
export async function stopAndWaitPtyFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyId: string,
  opts?: { keepHistory?: boolean; deadlineMs?: number }
): Promise<boolean> {
  const {
    runtime,
    store,
    getLocalPtyProviderStartupPromise,
    shutdownProviderAndDetectExit,
    rememberSyntheticKillExit,
    sendPtyExitToRenderer,
    finishPtyShutdown
  } = deps
  let connectionId: string | null | undefined = ptyOwnership.get(ptyId)
  const parsedSshId = connectionId === undefined ? parseAppSshPtyId(ptyId) : null
  connectionId ??= parsedSshId?.connectionId
  // One absolute deadline bounds every sequential teardown RPC.
  const deadlineMs = opts?.deadlineMs
  const startupPromise = getLocalPtyProviderStartupPromise(connectionId)
  if (startupPromise) {
    // Select the provider after daemon startup to avoid false fallback confirmation.
    if (deadlineMs !== undefined) {
      // Fail closed when startup exceeds the teardown deadline.
      const won = await Promise.race([
        // Handle rejection even when the deadline wins.
        startupPromise.then(
          () => true,
          () => false
        ),
        delay(Math.max(1, deadlineMs - Date.now())).then(() => false)
      ])
      if (!won) {
        return false
      }
    } else {
      await startupPromise
    }
  }
  if (opts?.keepHistory) {
    assertPtyHibernationAllowed(store, ptyId, connectionId)
  }
  runtime?.markPtyStopRequested?.(ptyId)
  let provider: IPtyProvider
  try {
    provider = connectionId ? getProvider(connectionId) : getProviderForPty(ptyId)
  } catch {
    if (connectionId) {
      // An unavailable SSH provider leaves the remote process unverifiable.
      const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
      runtime?.onPtyExit(ptyId, -1, incarnationId)
      rememberSyntheticKillExit(ptyId)
      sendPtyExitToRenderer({
        id: ptyId,
        code: -1,
        ...(incarnationId ? { incarnationId } : {})
      })
      runtime?.markPtyLivenessUnverifiable?.(ptyId, SSH_PROVIDER_UNREGISTERED_REASON)
    }
    return false
  }
  let providerExitObserved = false
  try {
    providerExitObserved = await shutdownProviderAndDetectExit(provider, ptyId, {
      immediate: true,
      keepHistory: opts?.keepHistory ?? false,
      deadlineMs
    })
  } catch (err) {
    if (!isPtyAlreadyGoneError(err)) {
      if (connectionId) {
        runtime?.markPtyLivenessUnverifiable?.(
          ptyId,
          err instanceof Error ? err.message : String(err)
        )
      }
      console.warn(
        `[pty] Failed to stop PTY ${ptyId}: ${err instanceof Error ? err.message : String(err)}`
      )
      return false
    }
  }
  try {
    if (!(await verifyPtyStopped(provider, ptyId, opts))) {
      runtime?.markPtyLivenessLive?.(ptyId)
      return false
    }
  } catch (err) {
    if (connectionId) {
      runtime?.markPtyLivenessUnverifiable?.(
        ptyId,
        err instanceof Error ? err.message : String(err)
      )
    }
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[pty] Failed to verify PTY ${ptyId} stopped: ${message}`)
    return false
  }
  const incarnationId = finishPtyShutdown(ptyId, connectionId, store)
  if (!providerExitObserved) {
    // Fresh host inventory certifies exit even when its event was missed.
    runtime?.onPtyExit(ptyId, 0, incarnationId)
    rememberSyntheticKillExit(ptyId)
    sendPtyExitToRenderer({
      id: ptyId,
      code: 0,
      ...(incarnationId ? { incarnationId } : {})
    })
  }
  return true
}
