import { mobileWebHostPayloadWithinBounds } from '../../../src/shared/mobile-web/host-rpc-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

export async function readMobileWebNativeResource(args: {
  client: RpcClient
  getPageSessionId?: () => Promise<string>
  isActive?: () => boolean
  hostWorkspaceId: string
  kind: string
  resourceId: string
}): Promise<unknown> {
  if (!args.getPageSessionId || args.isActive?.() === false) {
    throw new MobileWebBrokerError('cancelled')
  }
  const deadline = Date.now() + 15_000
  const pageSession = await args.getPageSessionId()
  const beforeSend = () => {
    if (Date.now() >= deadline) {
      throw new MobileWebBrokerError('timeout')
    }
    if (args.isActive?.() === false) {
      throw new MobileWebBrokerError('cancelled')
    }
  }
  beforeSend()
  const response = await args.client.sendRequest(
    'mobileWeb.resource.resolve',
    {
      worktree: `id:${args.hostWorkspaceId}`,
      pageSession,
      kind: args.kind,
      resourceId: args.resourceId
    },
    { timeoutMs: Math.max(1, deadline - Date.now()), budgetSpansConnect: true, beforeSend }
  )
  beforeSend()
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (
    !mobileWebHostPayloadWithinBounds(response.result) ||
    new TextEncoder().encode(JSON.stringify(response.result)).byteLength > 32 * 1024
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  return response.result
}
