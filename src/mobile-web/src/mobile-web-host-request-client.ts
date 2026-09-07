import {
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

export class MobileWebHostRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  request(
    payload: MobileWebHostRequestPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<unknown> {
    return requestMobileWebHost(
      this.requests,
      payload.method,
      payload.workspaceId,
      payload.params,
      options
    )
  }
}
