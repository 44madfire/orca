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

export async function executeMobileWebHostRequest(args: {
  client: RpcClient
  authority: MobileWebWorkspaceAuthority
  payload: unknown
  isActive: () => boolean
}): Promise<unknown> {
  const payload = MobileWebHostRequestPayloadSchema.parse(args.payload)
  if (!mobileWebHostPayloadWithinBounds(payload.params)) {
    throw new MobileWebBrokerError('too_large')
  }
  const hostWorkspaceId = args.authority.hostWorkspaceId(payload.workspaceId)
  const catalog = await readMobileWebHostCatalog(args.client, { methods: [payload.method] })
  const grant = catalog.grants.find((entry) => entry.method === payload.method)
  if (!grant) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  args.authority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  const params = { ...payload.params, [grant.workspaceParam]: `id:${hostWorkspaceId}` }
  if (
    !mobileWebHostPayloadWithinBounds(params) ||
    mobileWebEncodedByteLength(params) > grant.maxRequestBytes
  ) {
    throw new MobileWebBrokerError('too_large')
  }
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
