import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { readMobileWebHostMethods, requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export async function bindMobileWebHostNativeChat(
  requests: MobileWebOneShotRequestClient,
  workspaceId: string,
  tabId: string,
  method: string
): Promise<string | null> {
  if (
    !requests.supports('workspace', 'hostRequest') ||
    !requests.supports('workspace', 'hostCatalog')
  ) {
    return null
  }
  const methods = ['mobileWeb.nativeChat.bind', method]
  const catalog = await readMobileWebHostMethods(requests, methods)
  if (!methods.every((method) => catalog.grants.some((grant) => grant.method === method))) {
    return null
  }
  const bound = await requestMobileWebHost(requests, methods[0], workspaceId, { tabId })
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
