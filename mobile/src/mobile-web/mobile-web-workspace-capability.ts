import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { executeMobileWebHostRequest, readMobileWebHostCatalog } from './mobile-web-host-requests'
import { executeMobileWebWorkspaceOperation } from './mobile-web-workspace-operations'

type OnceRequest = Extract<
  Extract<MobileWebBridgePageMessage, { type: 'request' }>,
  { mode: 'once' }
>

export async function executeWorkspace(
  args: MobileWebCapabilityExecutionDependencies,
  request: OnceRequest
): Promise<unknown> {
  if (request.operation === 'hostCatalog') {
    return readMobileWebHostCatalog(args.connectedClient(), request.payload)
  }
  if (request.operation === 'hostRequest') {
    return executeMobileWebHostRequest({
      client: args.connectedClient(),
      authority: args.workspaceAuthority,
      payload: request.payload,
      isActive: args.isRequestActive
    })
  }
  if (request.capability !== 'workspace' && request.capability !== 'settings') {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  const result = await executeMobileWebWorkspaceOperation({
    capability: request.capability,
    operation: request.operation,
    payload: request.payload,
    client: args.connectedClient(),
    authority: args.workspaceAuthority,
    snapshots: args.workspaceSnapshots
  })
  if (request.capability === 'workspace' && request.operation === 'activate') {
    args.terminalArtifactAuthority.clear()
  }
  return result
}
