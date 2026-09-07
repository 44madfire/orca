import {
  MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT,
  type MobileWebNativeChatFileSearchPayload,
  type MobileWebNativeChatOpenFilePayload,
  type MobileWebNativeChatReadabilityPayload
} from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebRelativePathSchema } from '../../shared/mobile-web/bridge-operation-contract'
import { bindMobileWebHostNativeChat } from './mobile-web-host-native-chat-binding'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebNativeChatFileClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  fileSearch(
    payload: MobileWebNativeChatFileSearchPayload,
    tabId?: string
  ): Promise<{ paths: string[] }> {
    if (!tabId) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.withBinding(
      'mobileWeb.nativeChat.fileSearch',
      payload.workspaceId,
      tabId,
      async (resourceId, timeoutMs) => {
        const result = await requestMobileWebHost(
          this.requests,
          'mobileWeb.nativeChat.fileSearch',
          payload.workspaceId,
          {
            resourceId,
            search: { query: payload.query, limit: MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT }
          },
          { timeoutMs }
        )
        if (!isRecord(result) || !Array.isArray(result.files)) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        const paths = result.files.flatMap((file): string[] => {
          const path = MobileWebRelativePathSchema.safeParse(
            isRecord(file) ? file.relativePath : undefined
          )
          return path.success ? [path.data] : []
        })
        return { paths: paths.slice(0, MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT) }
      }
    )
  }

  openFile(payload: MobileWebNativeChatOpenFilePayload, tabId?: string): Promise<null> {
    if (!tabId) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.withBinding(
      'mobileWeb.nativeChat.openFile',
      payload.workspaceId,
      tabId,
      async (resourceId, timeoutMs) => {
        const result = await requestMobileWebHost(
          this.requests,
          'mobileWeb.nativeChat.openFile',
          payload.workspaceId,
          { resourceId, pathText: payload.pathText, timeoutMs },
          { timeoutMs }
        )
        if (!isRecord(result) || typeof result.opened !== 'boolean') {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return null
      }
    )
  }

  async readability(
    payload: MobileWebNativeChatReadabilityPayload
  ): Promise<{ readable: boolean }> {
    const result = await requestMobileWebHost(
      this.requests,
      'mobileWeb.nativeChat.readability',
      payload.workspaceId,
      {}
    )
    if (!isRecord(result) || typeof result.readable !== 'boolean') {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return result as { readable: boolean }
  }

  private async withBinding<T>(
    method: string,
    workspaceId: string,
    tabId: string,
    run: (resourceId: string, timeoutMs: number) => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + 15_000
    const resourceId = await bindMobileWebHostNativeChat(
      this.requests,
      workspaceId,
      tabId,
      method,
      {
        timeoutMs: remaining(deadline)
      }
    )
    return run(resourceId, remaining(deadline))
  }
}
function remaining(deadline: number): number {
  const timeoutMs = deadline - Date.now()
  if (timeoutMs <= 0) {
    throw new MobileWebBridgeClientError('timeout', true)
  }
  return timeoutMs
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
