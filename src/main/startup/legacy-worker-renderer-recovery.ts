import type { LegacyWorkerResumeFenceSnapshot } from '../../shared/agent-session-resume'
import type { LegacyWorkerTerminalRecoveryResult } from '../runtime/runtime-legacy-worker-terminal-recovery-types'

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
    return { blockedPaneKeys: [] }
  }
  try {
    return { blockedPaneKeys: (await options.reconcile())?.blockedPaneKeys ?? [] }
  } catch (error) {
    options.onDeferredRecoveryError(error)
    return { blockedPaneKeys: [] }
  }
}
