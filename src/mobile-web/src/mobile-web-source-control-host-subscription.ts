import { MobileWebSourceControlSubscribePayloadSchema } from '../../shared/mobile-web/source-control-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'

export function subscribeHostSourceControl(
  requests: MobileWebOneShotRequestClient,
  subscriptions: MobileWebBridgeSubscriptionClient,
  ...[payload, onEvent, onError]: Parameters<
    MobileWebBridgeSubscriptionClient['subscribeSourceControl']
  >
): MobileWebBridgeSubscription {
  const legacy = () => subscriptions.subscribeSourceControl(payload, onEvent, onError)
  if (
    !requests.supports('workspace', 'hostSubscribe') ||
    !MobileWebSourceControlSubscribePayloadSchema.safeParse(payload).success
  ) {
    return legacy()
  }
  let cancelled = false
  let ready = false
  let current: MobileWebBridgeSubscription = subscriptions.subscribeHost(
    {
      method: 'mobileWeb.files.watch',
      workspaceId: payload.workspaceId,
      params: {}
    },
    (event) => {
      if (cancelled || typeof event !== 'object' || event === null) {
        return
      }
      if ('type' in event && event.type === 'changed') {
        const events = 'events' in event && Array.isArray(event.events) ? event.events : null
        if (!events) {
          onError(new MobileWebBridgeClientError('invalid_message', false))
          return
        }
        const overflow =
          events.length > 5_000 ||
          events.some(
            (entry: unknown) =>
              typeof entry === 'object' &&
              entry !== null &&
              'kind' in entry &&
              entry.kind === 'overflow'
          )
        onEvent({ workspaceId: payload.workspaceId, reason: overflow ? 'overflow' : 'changed' })
      } else if ('type' in event && (event.type === 'error' || event.type === 'end')) {
        onError(new MobileWebBridgeClientError('unavailable', true))
      }
    },
    (error) => {
      if (!cancelled && (ready || error.code !== 'unsupported_capability')) {
        onError(error)
      }
    }
  )
  const settled = current.ready
    .catch((error: unknown) => {
      if (
        !cancelled &&
        error instanceof MobileWebBridgeClientError &&
        error.code === 'unsupported_capability'
      ) {
        current = legacy()
        return current.ready
      }
      throw error
    })
    .then(() => {
      ready = true
    })
  return {
    ready: settled,
    unsubscribe() {
      cancelled = true
      current.unsubscribe()
    }
  }
}
