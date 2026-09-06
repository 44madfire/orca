import {
  MobileWebHostCatalogPayloadSchema,
  MobileWebHostCatalogResultSchema,
  MobileWebHostRequestPayloadSchema,
  mobileWebHostPayloadWithinBounds
} from '../../../src/shared/mobile-web/host-rpc-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function readMobileWebHostCatalog(client: RpcClient, input: unknown) {
  const payload = MobileWebHostCatalogPayloadSchema.parse(input)
  const response = await client.sendRequest('mobileWeb.host.catalog', payload)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (!mobileWebHostPayloadWithinBounds(response.result)) {
    throw new MobileWebBrokerError('too_large')
  }
  return MobileWebHostCatalogResultSchema.parse(response.result)
}

export type MobileWebHostRequestArguments = {
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  payload: unknown
  isActive: () => boolean
  pageSessionId?: string
}

export async function prepareMobileWebHostRequest(
  args: MobileWebHostRequestArguments,
  mode: 'once' | 'subscription'
) {
  const payload = MobileWebHostRequestPayloadSchema.parse(args.payload)
  if (!mobileWebHostPayloadWithinBounds(payload.params)) {
    throw new MobileWebBrokerError('too_large')
  }
  const hostWorkspaceId = args.authority.hostWorkspaceId(payload.workspaceId)
  const catalog = await readMobileWebHostCatalog(args.client, { methods: [payload.method] })
  const grant = catalog.grants.find((entry) => entry.method === payload.method)
  if (
    !grant ||
    (grant.mode ?? 'once') !== mode ||
    (mode === 'subscription' && !grant.unsubscribeMethod)
  ) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  args.authority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  if (
    grant.pageSessionParam &&
    (!args.pageSessionId || grant.pageSessionParam === grant.workspaceParam)
  ) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  const params = {
    ...payload.params,
    [grant.workspaceParam]: `id:${hostWorkspaceId}`,
    ...(grant.pageSessionParam ? { [grant.pageSessionParam]: args.pageSessionId } : {})
  }
  if (
    !mobileWebHostPayloadWithinBounds(params) ||
    mobileWebEncodedByteLength(params) > grant.maxRequestBytes
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  return { payload, hostWorkspaceId, grant, params }
}

export async function executeMobileWebHostRequest(
  args: MobileWebHostRequestArguments
): Promise<unknown> {
  const { payload, hostWorkspaceId, grant, params } = await prepareMobileWebHostRequest(
    args,
    'once'
  )
  const response = await args.client.sendRequest(payload.method, params)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  args.authority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  if (
    !mobileWebHostPayloadWithinBounds(response.result) ||
    mobileWebEncodedByteLength(response.result) > grant.maxResponseBytes
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  return response.result
}
