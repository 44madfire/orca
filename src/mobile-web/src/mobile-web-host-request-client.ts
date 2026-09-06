import {
  MobileWebHostCatalogPayloadSchema,
  MobileWebHostCatalogResultSchema,
  MobileWebHostRequestPayloadSchema,
  MobileWebHostResultSchema
} from '../../shared/mobile-web/host-rpc-contract'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export function requestMobileWebHost(
  requests: MobileWebOneShotRequestClient,
  method: string,
  workspaceId: string,
  params: Record<string, unknown>,
  options?: MobileWebBridgeRequestOptions
): Promise<unknown> {
  return requests.request(
    'workspace',
    'hostRequest',
    { method, workspaceId, params },
    MobileWebHostRequestPayloadSchema,
    MobileWebHostResultSchema,
    options
  )
}

export function readMobileWebHostMethods(
  requests: MobileWebOneShotRequestClient,
  methods: string[],
  options?: MobileWebBridgeRequestOptions
) {
  return requests.request(
    'workspace',
    'hostCatalog',
    { methods },
    MobileWebHostCatalogPayloadSchema,
    MobileWebHostCatalogResultSchema,
    options
  )
}
