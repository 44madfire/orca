import {
  MOBILE_WEB_NATIVE_CHAT_FILE_RESULT_LIMIT,
  MobileWebNativeChatFileSearchPayloadSchema,
  MobileWebNativeChatFileSearchResultSchema,
  MobileWebNativeChatOpenFilePayloadSchema,
  MobileWebNativeChatOpenFileResultSchema,
  MobileWebNativeChatReadabilityPayloadSchema,
  MobileWebNativeChatReadabilityResultSchema,
  type MobileWebNativeChatFileSearchPayload,
  type MobileWebNativeChatOpenFilePayload,
  type MobileWebNativeChatReadabilityPayload
} from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebRelativePathSchema } from '../../shared/mobile-web/bridge-operation-contract'
import { bindMobileWebHostNativeChat } from './mobile-web-host-native-chat-binding'
import { readMobileWebHostMethods, requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebNativeChatFileClient {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly hostPageSession: boolean,
    private readonly hostRequestDispatch: boolean
  ) {}

  fileSearch(
    payload: MobileWebNativeChatFileSearchPayload,
    tabId?: string
  ): Promise<{ paths: string[] }> {
    const legacy = (timeoutMs?: number) =>
      this.requests.request(
        'nativeChat',
        'fileSearch',
        payload,
        MobileWebNativeChatFileSearchPayloadSchema,
        MobileWebNativeChatFileSearchResultSchema,
        { timeoutMs }
      )
    if (!tabId || !this.hostPageSession) {
      return legacy()
    }
    return this.withBinding(
      'mobileWeb.nativeChat.fileSearch',
      payload.workspaceId,
      tabId,
      legacy,
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
    const legacy = (timeoutMs?: number) =>
      this.requests.request(
        'nativeChat',
        'openFile',
        payload,
        MobileWebNativeChatOpenFilePayloadSchema,
        MobileWebNativeChatOpenFileResultSchema,
        { timeoutMs }
      )
    if (!tabId || !this.hostPageSession || !this.hostRequestDispatch) {
      return legacy()
    }
    return this.withBinding(
      'mobileWeb.nativeChat.openFile',
      payload.workspaceId,
      tabId,
      legacy,
      async (resourceId, timeoutMs) => {
        // Binding fallback ends before this call; an absent reply may hide a successful open.
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
    const legacy = (timeoutMs?: number) =>
      this.requests.request(
        'nativeChat',
        'readability',
        payload,
        MobileWebNativeChatReadabilityPayloadSchema,
        MobileWebNativeChatReadabilityResultSchema,
        { timeoutMs }
      )
    if (
      !this.hostPageSession ||
      !this.requests.supports('workspace', 'hostRequest') ||
      !this.requests.supports('workspace', 'hostCatalog')
    ) {
      return legacy()
    }
    const method = 'mobileWeb.nativeChat.readability'
    const deadline = Date.now() + 15_000
    try {
      const catalog = await readMobileWebHostMethods(this.requests, [method], {
        timeoutMs: remaining(deadline)
      })
      if (!catalog.grants.some((grant) => grant.method === method)) {
        return legacy(remaining(deadline))
      }
      const result = await requestMobileWebHost(
        this.requests,
        method,
        payload.workspaceId,
        {},
        { timeoutMs: remaining(deadline) }
      )
      if (!isRecord(result) || typeof result.readable !== 'boolean') {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return result as { readable: boolean }
    } catch (error) {
      if (unsupported(error)) {
        return legacy(remaining(deadline))
      }
      throw error
    }
  }

  private async withBinding<T>(
    method: string,
    workspaceId: string,
    tabId: string,
    legacy: (timeoutMs?: number) => Promise<T>,
    run: (resourceId: string, timeoutMs: number) => Promise<T>
  ): Promise<T> {
    const deadline = Date.now() + 15_000
    let resourceId: string | null
    try {
      resourceId = await bindMobileWebHostNativeChat(this.requests, workspaceId, tabId, method, {
        timeoutMs: remaining(deadline)
      })
    } catch (error) {
      if (unsupported(error)) {
        return legacy(remaining(deadline))
      }
      throw error
    }
    if (!resourceId) {
      return legacy(remaining(deadline))
    }
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
function unsupported(error: unknown): boolean {
  return error instanceof MobileWebBridgeClientError && error.code === 'unsupported_capability'
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
