import type { OrcaRuntimeService } from '../../orca-runtime'
import { sweepSettledWorkerResumeFences } from './settled-worker-resume-fence-sweep'

// Client reports own throttling; the host must observe every resource ownership population.
export function recordWorkerTerminalUserTakeover(
  runtime: OrcaRuntimeService,
  paneKey: string | null | undefined
): number {
  if (!paneKey) {
    return 0
  }
  const changed = runtime.getOrchestrationDb().markWorkerTerminalUserOwned(paneKey)
  if (changed > 0) {
    sweepSettledWorkerResumeFences(runtime)
  }
  return changed
}
