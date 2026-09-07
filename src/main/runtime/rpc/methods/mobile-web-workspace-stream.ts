import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defineMethod, defineStreamingMethod, isStreamingMethod } from '../core'
import { CLIENT_EVENT_METHODS } from './client-events'

const source = CLIENT_EVENT_METHODS.find(
  (method) => method.name === 'runtime.clientEvents.subscribe'
)
if (!source || !isStreamingMethod(source)) {
  throw new Error('Missing client event subscription')
}
const stream = source

/** The catalog signals the workspace list redraws on. The raw client-event feed carries every
 * runtime event with its payload; the page only ever needed to know that something changed. */
function workspaceChangeType(event: unknown): 'reposChanged' | 'worktreesChanged' | undefined {
  const type =
    typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
  return type === 'reposChanged' || type === 'worktreesChanged' ? type : undefined
}

export const MOBILE_WEB_WORKSPACE_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.workspace.subscribe',
    params: null,
    handler: async (_params, context, emit) => {
      const subscriptionId = randomUUID()
      const connection = context.connectionId ?? 'local'
      const key = `mobileWeb.workspace:${connection}:${subscriptionId}`
      // The inner feed keys cleanup by its own generated id, which only its ready frame carries.
      let sourceKey: string | undefined
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
          if (sourceKey) {
            context.runtime.cleanupSubscription(sourceKey)
          }
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
        await stream.handler(null, { ...context, requestId: subscriptionId }, (event) => {
          const type =
            typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
          if (type === 'ready') {
            sourceKey ??=
              typeof event === 'object' &&
              event !== null &&
              'subscriptionId' in event &&
              typeof event.subscriptionId === 'string'
                ? event.subscriptionId
                : undefined
            return
          }
          if (closed) {
            return
          }
          if (type === 'end' || type === 'error') {
            if (type === 'error') {
              emit({ type: 'error' })
            }
            cleanup()
            return
          }
          const change = workspaceChangeType(event)
          if (change) {
            emit({ type: change })
          }
        })
      } catch (error) {
        cleanup()
        throw error
      } finally {
        if (closed && sourceKey) {
          context.runtime.cleanupSubscription(sourceKey)
        }
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.workspace.unsubscribe',
    params: z.object({ subscriptionId: z.string().uuid() }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        `mobileWeb.workspace:${context.connectionId ?? 'local'}:${params.subscriptionId}`
      )
      return { unsubscribed: true }
    }
  })
]
