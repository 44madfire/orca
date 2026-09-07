import { z } from 'zod'
import { defineMethod, defineStreamingMethod } from '../core'
import { openMobileWebPageResources } from './mobile-web-page-resources'

const Scope = z.object({ pageSession: z.string().min(1).max(160) })

// Shell-only lifetime subscription: transport replay opens it before dependent page feeds.
export const MOBILE_WEB_PAGE_LIFETIME_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.page.subscribe',
    params: Scope,
    handler: async (params, context, emit) => {
      if (context.signal?.aborted) {
        return
      }
      const close = openMobileWebPageResources(context, params.pageSession)
      const key = `mobileWeb.page:${context.connectionId}:${params.pageSession}`
      const cleanup = () => context.runtime.cleanupSubscription(key)
      context.runtime.registerSubscriptionCleanup(
        key,
        () => {
          context.signal?.removeEventListener('abort', cleanup)
          close()
          emit({ type: 'end' })
        },
        context.connectionId
      )
      context.signal?.addEventListener('abort', cleanup, { once: true })
      emit({ type: 'ready', subscriptionId: params.pageSession })
    }
  }),
  defineMethod({
    name: 'mobileWeb.page.unsubscribe',
    params: z.object({ subscriptionId: z.string().min(1).max(160) }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        `mobileWeb.page:${context.connectionId}:${params.subscriptionId}`
      )
      return { unsubscribed: true }
    }
  })
]
