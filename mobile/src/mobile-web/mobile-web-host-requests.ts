import {
  MobileWebHostCatalogPayloadSchema,
  MobileWebHostCatalogResultSchema,
  MobileWebHostRequestPayloadSchema,
  mobileWebHostPayloadWithinBounds
} from '../../../src/shared/mobile-web/host-rpc-contract'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { mobileWebEncodedByteLength } from './mobile-web-request-accounting'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HOST_REQUEST_TIMEOUT_MS = 15_000

export async function readMobileWebHostCatalog(
  client: RpcClient,
  input: unknown,
  options: SendRequestOptions = { timeoutMs: HOST_REQUEST_TIMEOUT_MS, budgetSpansConnect: true }
) {
  const payload = MobileWebHostCatalogPayloadSchema.parse(input)
  const response = await client.sendRequest('mobileWeb.host.catalog', payload, options)
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
  requestOptions?: () => SendRequestOptions
}

export async function prepareMobileWebHostRequest(
  args: MobileWebHostRequestArguments,
  mode: 'once' | 'subscription'
) {
  const payload = MobileWebHostRequestPayloadSchema.parse(args.payload)
  if (!mobileWebHostPayloadWithinBounds(payload.params)) {
    throw new MobileWebBrokerError('too_large')
  }
  const hostWorkspaceId =
    payload.workspaceId === undefined
      ? undefined
      : args.authority.hostWorkspaceId(payload.workspaceId)
  const catalog = await readMobileWebHostCatalog(
    args.client,
    { methods: [payload.method] },
    args.requestOptions?.()
  )
  const grant = catalog.grants.find((entry) => entry.method === payload.method)
  if (
    !grant ||
    (grant.scope === 'host') !== (payload.workspaceId === undefined) ||
    (grant.mode ?? 'once') !== mode ||
    (mode === 'subscription' && !grant.unsubscribeMethod)
  ) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  if (payload.workspaceId !== undefined && hostWorkspaceId !== undefined) {
    args.authority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  }
  if (
    grant.pageSessionParam &&
    (!args.pageSessionId || grant.pageSessionParam === grant.workspaceParam)
  ) {
    throw new MobileWebBrokerError('unsupported_capability')
  }
  const params = {
    ...payload.params,
    ...(grant.workspaceParam && hostWorkspaceId
      ? { [grant.workspaceParam]: `id:${hostWorkspaceId}` }
      : {}),
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
  const deadline = Date.now() + HOST_REQUEST_TIMEOUT_MS
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
  const { payload, hostWorkspaceId, grant, params } = await prepareMobileWebHostRequest(
    { ...args, requestOptions },
    'once'
  )
  const options = requestOptions()
  options.beforeSend = () => {
    beforeSend()
    if (payload.workspaceId !== undefined && hostWorkspaceId !== undefined) {
      args.authority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    }
  }
  const response = await args.client.sendRequest(payload.method, params, options)
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  if (!args.isActive()) {
    throw new MobileWebBrokerError('cancelled')
  }
  if (payload.workspaceId !== undefined && hostWorkspaceId !== undefined) {
    args.authority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
  }
  if (
    !mobileWebHostPayloadWithinBounds(response.result) ||
    mobileWebEncodedByteLength(response.result) > grant.maxResponseBytes
  ) {
    throw new MobileWebBrokerError('too_large')
  }
  return response.result
}
