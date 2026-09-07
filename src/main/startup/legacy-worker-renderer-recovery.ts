import type { LegacyWorkerResumeFenceSnapshot } from '../../shared/agent-session-resume'
import type { LegacyWorkerTerminalRecoveryResult } from '../runtime/runtime-legacy-worker-terminal-recovery-types'

/** Generation 0 never orders ahead of a real commit, so a renderer drops this over any live push. */
const EMPTY_FENCE_SNAPSHOT: LegacyWorkerResumeFenceSnapshot = { generation: 0, blockedPaneKeys: [] }

type LegacyWorkerRendererRecoveryOptions = {
  firstWindowStartupServicesReady: Promise<void>
  managedWslCliStartupBarrierReady: Promise<void>
  localPtyProviderStartupReady: Promise<void>
  reconcile: () => Promise<LegacyWorkerTerminalRecoveryResult | undefined> | undefined
  onDeferredRecoveryError: (error: unknown) => void
}

export async function recoverLegacyWorkerTerminalsForRendererStartup(
  options: LegacyWorkerRendererRecoveryOptions
): Promise<LegacyWorkerResumeFenceSnapshot> {
  const providerStartupResult = options.localPtyProviderStartupReady.then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error })
  )
  const [providerResult] = await Promise.all([
    providerStartupResult,
    options.firstWindowStartupServicesReady,
    options.managedWslCliStartupBarrierReady
  ])
  if (!providerResult.ok) {
    options.onDeferredRecoveryError(providerResult.error)
    return EMPTY_FENCE_SNAPSHOT
  }
  try {
    return (await options.reconcile())?.fenceSnapshot ?? EMPTY_FENCE_SNAPSHOT
  } catch (error) {
    options.onDeferredRecoveryError(error)
    return EMPTY_FENCE_SNAPSHOT
  }
}
