import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import {
  MobileWebHostCatalogPayloadSchema,
  MobileWebHostCatalogResultSchema,
  MobileWebHostRequestPayloadSchema,
  MobileWebHostResultSchema,
  type MobileWebHostRequestPayload
} from '../../shared/mobile-web/host-rpc-contract'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export function requestMobileWebHost(
  requests: MobileWebOneShotRequestClient,
  method: string,
  workspaceId: string | undefined,
  params: Record<string, unknown>,
  options?: MobileWebBridgeRequestOptions
): Promise<unknown> {
  return requests.request(
    'workspace',
    'hostRequest',
    { method, ...(workspaceId === undefined ? {} : { workspaceId }), params },
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

export class MobileWebHostRequestClient {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly hostScope: boolean
  ) {}

  catalog(methods: string[], options?: MobileWebBridgeRequestOptions) {
    return readMobileWebHostMethods(this.requests, methods, options)
  }

  request(
    payload: MobileWebHostRequestPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<unknown> {
    if (payload.workspaceId === undefined && !this.hostScope) {
      return Promise.reject(new MobileWebBridgeClientError('unsupported_capability', false))
    }
    return requestMobileWebHost(
      this.requests,
      payload.method,
      payload.workspaceId,
      payload.params,
      options
    )
  }
}
