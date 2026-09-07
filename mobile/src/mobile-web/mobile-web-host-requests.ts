import {
  MobileWebHostRequestPayloadSchema,
  mobileWebHostPayloadByteLength
} from '../../../src/shared/mobile-web/host-rpc-contract'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import type { MobileWebHostCatalogCache } from './mobile-web-host-catalog-cache'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export const MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS = 15_000

/** The page handle a request is scoped to, resolved once and re-checked at every dispatch. Absent
 * only for host-scoped grants, which carry no workspace at all. */
export type MobileWebHostRequestScope = {
  pageWorkspaceId: string
  hostWorkspaceId: MobileWebHostWorkspaceId
}

export type MobileWebHostRequestArguments = {
  client: RpcClient
  catalog: MobileWebHostCatalogCache
  authority: MobileWebWorkspaceAuthority
  payload: unknown
  isActive: () => boolean
  requestOptions?: () => SendRequestOptions
}

export function assertMobileWebHostRequestScope(
  authority: MobileWebWorkspaceAuthority,
  scope: MobileWebHostRequestScope | undefined
): void {
  if (scope) {
    authority.assertHostWorkspaceBinding(scope.pageWorkspaceId, scope.hostWorkspaceId)
  }
}

export async function prepareMobileWebHostRequest(
  args: MobileWebHostRequestArguments,
  mode: 'once' | 'subscription'
) {
  const payload = MobileWebHostRequestPayloadSchema.parse(args.payload)
  const scope =
    payload.workspaceId === undefined
      ? undefined
      : {
          pageWorkspaceId: payload.workspaceId,
          hostWorkspaceId: args.authority.hostWorkspaceId(payload.workspaceId)
        }
  const grant = await args.catalog.grant(args.client, payload.method, args.requestOptions?.())
  if (
    !grant ||
    (grant.scope === 'host') !== (scope === undefined) ||
    (grant.mode ?? 'once') !== mode ||
    (mode === 'subscription' && !grant.unsubscribeMethod)
  ) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  assertMobileWebHostRequestScope(args.authority, scope)
  const params = {
    ...payload.params,
    // Scope agreement above plus the grant schema's refine make workspaceParam present here.
    ...(scope ? { [grant.workspaceParam!]: `id:${scope.hostWorkspaceId}` } : {})
  }
  const requestBytes = mobileWebHostPayloadByteLength(params)
  if (requestBytes === undefined || requestBytes > grant.maxRequestBytes) {
    throw new MobileWebBrokerError('too_large')
  }
  return { payload, scope, grant, params }
}

export async function executeMobileWebHostRequest(
  args: MobileWebHostRequestArguments
): Promise<unknown> {
  const deadline = Date.now() + MOBILE_WEB_HOST_REQUEST_TIMEOUT_MS
  const beforeSend = () => {
    if (!args.isActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    if (Date.now() >= deadline) {
      throw new MobileWebBrokerError('timeout')
    }
  }
  const requestOptions = (): SendRequestOptions => {
    beforeSend()
    return { timeoutMs: deadline - Date.now(), budgetSpansConnect: true, beforeSend }
  }
  const { payload, scope, grant, params } = await prepareMobileWebHostRequest(
    { ...args, requestOptions },
    'once'
  )
  const options = requestOptions()
  options.beforeSend = () => {
    beforeSend()
    assertMobileWebHostRequestScope(args.authority, scope)
  }
  const response = await args.client.sendRequest(payload.method, params, options)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  assertMobileWebHostRequestScope(args.authority, scope)
  const responseBytes = mobileWebHostPayloadByteLength(response.result)
  if (responseBytes === undefined || responseBytes > grant.maxResponseBytes) {
    throw new MobileWebBrokerError('too_large')
  }
  return response.result
}
