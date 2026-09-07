import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { readMobileWebHostMethods, requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export async function bindMobileWebHostNativeChat(
  requests: MobileWebOneShotRequestClient,
  workspaceId: string,
  tabId: string,
  method: string,
  options?: MobileWebBridgeRequestOptions
): Promise<string> {
  const deadline = options?.timeoutMs === undefined ? null : Date.now() + options.timeoutMs
  const remainingOptions = () => {
    if (deadline === null) {
      return options
    }
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      throw new MobileWebBridgeClientError('timeout', true)
    }
    return { ...options, timeoutMs }
  }
  const methods = ['mobileWeb.nativeChat.bind', method]
  const catalog = await readMobileWebHostMethods(requests, methods, remainingOptions())
  if (!methods.every((method) => catalog.grants.some((grant) => grant.method === method))) {
    throw new MobileWebBridgeClientError('unsupported_capability', false)
  }
  const bound = await requestMobileWebHost(
    requests,
    methods[0],
    workspaceId,
    { tabId },
    remainingOptions()
  )
  if (
    typeof bound !== 'object' ||
    bound === null ||
    !('resourceId' in bound) ||
    typeof bound.resourceId !== 'string'
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return bound.resourceId
}
