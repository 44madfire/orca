import type { MobileWebNativeChatReadResult } from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { readMobileWebHostMethods, requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

type MobileWebHostChatReadResult = MobileWebNativeChatReadResult

export async function readMobileWebHostNativeChat(
  requests: MobileWebOneShotRequestClient,
  target: { workspaceId: string; tabId: string; limit: number; beforeOffset?: number },
  legacy: () => Promise<MobileWebHostChatReadResult>
): Promise<MobileWebHostChatReadResult> {
  if (
    !requests.supports('workspace', 'hostRequest') ||
    !requests.supports('workspace', 'hostCatalog')
  ) {
    return legacy()
  }
  try {
    const methods = ['mobileWeb.nativeChat.bind', 'mobileWeb.nativeChat.read']
    const catalog = await readMobileWebHostMethods(requests, methods)
    if (!methods.every((method) => catalog.grants.some((grant) => grant.method === method))) {
      return legacy()
    }
    const bound = await requestMobileWebHost(requests, methods[0], target.workspaceId, {
      tabId: target.tabId
    })
    if (!isRecord(bound) || typeof bound.resourceId !== 'string') {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    const result = await requestMobileWebHost(requests, methods[1], target.workspaceId, {
      resourceId: bound.resourceId,
      read: {
        limit: target.limit,
        ...(target.beforeOffset === undefined ? {} : { beforeOffset: target.beforeOffset })
      }
    })
    if (
      !isRecord(result) ||
      !Array.isArray(result.messages) ||
      typeof result.hasMore !== 'boolean' ||
      result.messages.length > target.limit
    ) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    if (
      result.hasMore &&
      (typeof result.beforeOffset !== 'number' ||
        !Number.isSafeInteger(result.beforeOffset) ||
        result.beforeOffset < 0 ||
        (target.beforeOffset !== undefined && result.beforeOffset >= target.beforeOffset))
    ) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return result as MobileWebHostChatReadResult
  } catch (error) {
    if (
      error instanceof MobileWebBridgeClientError &&
      (error.code === 'unsupported_capability' || error.code === 'too_large')
    ) {
      return legacy()
    }
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
