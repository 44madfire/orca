import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineMethod, defineStreamingMethod, isStreamingMethod } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'
import { MobileWebSessionScope, projectMobileWebSession } from './mobile-web-session-scope'

const source = SESSION_TAB_METHODS.find((method) => method.name === 'session.tabs.subscribe')
if (!source || !isStreamingMethod(source)) {
  throw new Error('Missing session subscription')
}
const stream = source

export const MOBILE_WEB_SESSION_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.session.subscribe',
    params: MobileWebSessionScope,
    handler: async (params, context, emit) => {
      const subscriptionId = randomUUID()
      const connection = context.connectionId ?? 'local'
      const key = `mobileWeb.session:${connection}:${subscriptionId}`
      const sourceKey = `session.tabs:${connection}:${params.worktree.slice(3)}:${subscriptionId}`
      let closed = false
      const cleanup = () => context.runtime.cleanupSubscription(key)
      context.runtime.registerSubscriptionCleanup(
        key,
        () => {
          if (closed) {
            return
          }
          closed = true
          context.signal?.removeEventListener('abort', cleanup)
          context.runtime.cleanupSubscription(sourceKey)
          emit({ type: 'end' })
        },
        context.connectionId
      )
      context.signal?.addEventListener('abort', cleanup, { once: true })
      if (context.signal?.aborted) {
        cleanup()
      }
      if (closed) {
        return
      }
      emit({ type: 'ready', subscriptionId })
      if (closed) {
        return
      }
      try {
        await stream.handler(
          stream.params!.parse({ worktree: params.worktree }),
          { ...context, requestId: subscriptionId },
          (event) => {
            if (closed) {
              return
            }
            const type =
              typeof event === 'object' && event !== null && 'type' in event
                ? event.type
                : undefined
            if (type === 'end' || type === 'error') {
              if (type === 'error') {
                emit({ type: 'error', message: 'Session feed unavailable' })
              }
              cleanup()
              return
            }
            try {
              emit({ type: 'snapshot', snapshot: projectMobileWebSession(event, params, context) })
            } catch {
              emit({ type: 'error', message: 'Session snapshot unavailable' })
              cleanup()
            }
          }
        )
      } catch (error) {
        cleanup()
        throw error
      } finally {
        if (closed) {
          context.runtime.cleanupSubscription(sourceKey)
        }
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.session.unsubscribe',
    params: z.object({ subscriptionId: z.string().uuid() }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        `mobileWeb.session:${context.connectionId ?? 'local'}:${params.subscriptionId}`
      )
      return { unsubscribed: true }
    }
  })
]
