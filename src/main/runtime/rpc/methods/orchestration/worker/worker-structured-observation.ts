import {
  refreshOrchestrationFleetLivenessAttention,
  type FleetDurableWorker,
  type FleetLiveness,
  type OrchestrationFleetWorker
} from '../../../../../../shared/orchestration-fleet-projection'
import { projectFleetNextAction } from '../../../../../../shared/orchestration-fleet-worker-projection'
import { parseWorkerTerminalHostScope } from '../../../../../../shared/worker-terminal-host-scope'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { observeStructuredWorker } from '../../../../structured-worker-authority'
import {
  isStructuredWorkerHandle,
  sessionIdFromStructuredWorkerIncarnation,
  structuredWorkerPaneKeyBelongsToSession
} from '../../../../structured-worker-identity'

export function applyStructuredWorkerObservations(
  workers: OrchestrationFleetWorker[],
  durable: ReadonlyMap<string, FleetDurableWorker>,
  db: OrchestrationDb,
  now: number
): void {
  for (const worker of workers) {
    const row = durable.get(worker.dispatchId)!
    if (!isStructuredWorkerHandle(row.agentTerminalHandle) || worker.liveness.verdict === 'exited') {
      continue
    }
    const resource = row.resource
    const sessionId = sessionIdFromStructuredWorkerIncarnation(resource?.processIncarnation)
    let liveness: FleetLiveness = { verdict: 'unverifiable', reason: 'host_indeterminate' }
    // The page's exact resource lineage supplies identity; a registry/global inventory cannot.
    if (
      sessionId &&
      resource?.ownerDispatchId === row.dispatchId &&
      resource.ownershipState === 'owned' &&
      resource.paneKey === row.paneKey &&
      parseWorkerTerminalHostScope(resource.hostScope)?.kind === 'local' &&
      structuredWorkerPaneKeyBelongsToSession(resource.paneKey, sessionId) &&
      db.isDispatchProcessCurrent({
        dispatchId: row.dispatchId,
        paneKey: resource.paneKey,
        processIncarnation: resource.processIncarnation ?? null
      })
    ) {
      const observed = observeStructuredWorker({ sessionId })
      if (observed.status === 'live') {
        liveness = { verdict: 'live', source: 'execution_host', observedAt: now }
      } else if (observed.status === 'exited') {
        liveness = { verdict: 'exited', source: 'execution_host' }
      }
    }
    worker.liveness = liveness
    worker.nextAction = projectFleetNextAction(row, liveness)
    refreshOrchestrationFleetLivenessAttention(worker)
  }
}
