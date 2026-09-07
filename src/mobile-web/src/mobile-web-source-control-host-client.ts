import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

type PayloadSchema = { safeParse: (value: unknown) => { success: boolean } }

/** A Git write can outlast a read: a push over a slow link, a pull with a large fetch, a commit
 * behind a slow hook. This raises the page's own wait; the shell still applies its request
 * deadline until the host-request payload carries one. */
export const MOBILE_WEB_SOURCE_CONTROL_WRITE_TIMEOUT_MS = 60_000

/** Every Source Control call is one Desktop method addressed by the page's workspace handle. The
 * payload contract is checked here so a malformed request never reaches the bridge. */
export class MobileWebSourceControlHostClient {
  constructor(protected readonly requests: MobileWebOneShotRequestClient) {}

  protected host(
    schema: PayloadSchema,
    payload: { workspaceId: string },
    method: string,
    params: Record<string, unknown>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<unknown> {
    if (!schema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(this.requests, method, payload.workspaceId, params, options)
  }

  protected hostWrite(
    schema: PayloadSchema,
    payload: { workspaceId: string },
    method: string,
    params: Record<string, unknown>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<unknown> {
    return this.host(schema, payload, method, params, {
      ...options,
      timeoutMs: options?.timeoutMs ?? MOBILE_WEB_SOURCE_CONTROL_WRITE_TIMEOUT_MS
    })
  }
}
