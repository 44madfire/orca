import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { decodeBrowserScreencastFrame } from '../../../../shared/browser-screencast-protocol'
import type { MobileWebBrowserEvent } from '../../../../shared/mobile-web/browser-operation-contract'
import { defineMethod, defineStreamingMethod, isStreamingMethod } from '../core'
import { BROWSER_SCREENCAST_METHODS } from './browser-screencast'
import { MobileWebBrowserTarget } from './mobile-web-browser-command-dispatch'
import { mobileWebBrowserFrameChunks } from './mobile-web-browser-frame-chunks'
import { mobileWebBrowserPageEvent } from './mobile-web-browser-page-event'

const source = BROWSER_SCREENCAST_METHODS.find((method) => method.name === 'browser.screencast')
if (!source || !isStreamingMethod(source)) {
  throw new Error('Missing browser screencast stream')
}
const stream = source

function subscriptionKey(connectionId: string | undefined, subscriptionId: string): string {
  return `mobileWeb.browser:${connectionId ?? 'local'}:${subscriptionId}`
}

export const MOBILE_WEB_BROWSER_STREAM_METHODS = [
  defineStreamingMethod({
    name: 'mobileWeb.browser.subscribe',
    params: MobileWebBrowserTarget.extend({
      format: z.enum(['jpeg', 'png']),
      quality: z.number().int().min(1).max(100),
      maxWidth: z.number().int().min(1).max(2400),
      maxHeight: z.number().int().min(1).max(2160),
      viewportWidth: z.number().int().min(1).max(10_000).optional(),
      viewportHeight: z.number().int().min(1).max(10_000).optional(),
      deviceScaleFactor: z.number().finite().min(0.1).max(10).optional(),
      mobile: z.boolean().optional(),
      everyNthFrame: z.number().int().min(1).max(60),
      minFrameIntervalMs: z.number().int().min(16).max(10_000)
    }),
    handler: async (params, context, emit) => {
      const subscriptionId = randomUUID()
      const key = subscriptionKey(context.connectionId, subscriptionId)
      const inner = new AbortController()
      let closed = false
      const close = (event?: MobileWebBrowserEvent): void => {
        if (closed) {
          return
        }
        closed = true
        if (event) {
          emit(event)
        }
        inner.abort()
      }
      const end = (): void => close({ type: 'end' })
      context.runtime.registerSubscriptionCleanup(key, end, context.connectionId)
      context.signal?.addEventListener('abort', end, { once: true })
      if (context.signal?.aborted) {
        end()
        return
      }
      // The shell learns the cancel id from this frame, so it precedes anything the stream sends.
      emit({ type: 'ready', subscriptionId })
      const deliverFrame = (bytes: Uint8Array): boolean => {
        if (closed) {
          return true
        }
        const frame = decodeBrowserScreencastFrame(bytes)
        if (!frame) {
          return true
        }
        const chunks = mobileWebBrowserFrameChunks(frame)
        if (!chunks) {
          emit({ type: 'error', message: 'Browser frame is too large to display safely.' })
          return true
        }
        for (const chunk of chunks) {
          emit(chunk)
        }
        return true
      }
      try {
        await stream.handler(
          stream.params!.parse(params),
          { ...context, signal: inner.signal, sendBinary: deliverFrame },
          (event) => {
            if (closed) {
              return
            }
            const projected = mobileWebBrowserPageEvent(event)
            if (!projected) {
              return
            }
            if (projected.type === 'end' || projected.type === 'error') {
              close(projected)
              return
            }
            emit(projected)
          }
        )
      } finally {
        context.signal?.removeEventListener('abort', end)
        context.runtime.cleanupSubscription(key)
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.unsubscribe',
    params: z.object({ subscriptionId: z.string().uuid() }),
    handler: (params, context) => {
      context.runtime.cleanupSubscription(
        subscriptionKey(context.connectionId, params.subscriptionId)
      )
      return { unsubscribed: true }
    }
  })
]
