import type { MobileWebNativeChatEvent } from '../../shared/mobile-web/native-chat-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import { bindMobileWebHostNativeChat } from './mobile-web-host-native-chat-binding'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export function subscribeMobileWebHostNativeChat(
  requests: MobileWebOneShotRequestClient,
  subscriptions: MobileWebBridgeSubscriptionClient,
  tabId: string,
  ...[payload, onEvent, onError]: Parameters<
    MobileWebBridgeSubscriptionClient['subscribeNativeChat']
  >
): MobileWebBridgeSubscription {
  const legacy = () => subscriptions.subscribeNativeChat(payload, onEvent, onError)
  if (!requests.supports('workspace', 'hostSubscribe')) {
    return legacy()
  }
  let cancelled = false
  let current: MobileWebBridgeSubscription | undefined
  const ready = (async () => {
    let resourceId: string | null
    try {
      resourceId = await bindMobileWebHostNativeChat(
        requests,
        payload.workspaceId,
        tabId,
        'mobileWeb.nativeChat.subscribe'
      )
    } catch (error) {
      if (
        !(error instanceof MobileWebBridgeClientError) ||
        error.code !== 'unsupported_capability'
      ) {
        throw error
      }
      resourceId = null
    }
    if (cancelled) {
      throw new MobileWebBridgeClientError('cancelled', false)
    }
    current =
      resourceId === null
        ? legacy()
        : subscriptions.subscribeHost(
            {
              method: 'mobileWeb.nativeChat.subscribe',
              workspaceId: payload.workspaceId,
              params: {
                resourceId,
                read: { limit: payload.limit, capabilities: { transcriptPending: 1 } }
              }
            },
            (event) => {
              if (cancelled) {
                return
              }
              if (typeof event !== 'object' || event === null || !('type' in event)) {
                onError(new MobileWebBridgeClientError('invalid_message', false))
                return
              }
              if (event.type !== 'ready') {
                onEvent(event as MobileWebNativeChatEvent)
              }
            },
            onError
          )
    await current.ready
  })()
  void ready.catch((error: unknown) => {
    if (!cancelled && !current) {
      onError(
        error instanceof MobileWebBridgeClientError
          ? error
          : new MobileWebBridgeClientError('unavailable', true)
      )
    }
  })
  return {
    ready,
    unsubscribe() {
      cancelled = true
      current?.unsubscribe()
    }
  }
}
