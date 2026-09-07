import { z } from 'zod'
import { defineMethod, type RpcContext } from '../core'
import {
  dispatchMobileWebBrowserCommand,
  mobileWebBrowserTargetFields,
  MOBILE_WEB_BROWSER_APPLIED,
  MobileWebBrowserCoordinate,
  MobileWebBrowserTarget
} from './mobile-web-browser-command-dispatch'
import { takeMobileWebBrowserInputToken } from './mobile-web-browser-input-rate-limit'

const PointerParams = z.discriminatedUnion('action', [
  MobileWebBrowserTarget.extend({
    action: z.literal('scroll'),
    x: MobileWebBrowserCoordinate,
    y: MobileWebBrowserCoordinate,
    dx: MobileWebBrowserCoordinate,
    dy: MobileWebBrowserCoordinate
  }),
  MobileWebBrowserTarget.extend({
    action: z.literal('click'),
    x: MobileWebBrowserCoordinate,
    y: MobileWebBrowserCoordinate,
    button: z.enum(['left', 'right']),
    modifiers: z.array(z.enum(['cmd', 'ctrl', 'alt', 'shift'])).max(4),
    radius: z.number().finite().min(0).max(1000).optional()
  })
])

const KeyboardParams = z.discriminatedUnion('action', [
  MobileWebBrowserTarget.extend({
    action: z.literal('insertText'),
    text: z
      .string()
      .min(1)
      .max(32 * 1024)
  }),
  MobileWebBrowserTarget.extend({
    action: z.literal('keypress'),
    key: z.enum(['Enter', 'Backspace', 'Tab', 'Escape'])
  })
])

function requireInputToken(context: RpcContext): void {
  if (!takeMobileWebBrowserInputToken(context.connectionId)) {
    throw new Error('rate_limited')
  }
}

export const MOBILE_WEB_BROWSER_INPUT_METHODS = [
  defineMethod({
    name: 'mobileWeb.browser.pointer',
    params: PointerParams,
    handler: async (params, context) => {
      requireInputToken(context)
      const target = mobileWebBrowserTargetFields(params)
      if (params.action === 'scroll') {
        await dispatchMobileWebBrowserCommand(
          'browser.mouseMove',
          { ...target, x: params.x, y: params.y },
          context
        )
        await dispatchMobileWebBrowserCommand(
          'browser.mouseWheel',
          { ...target, dx: params.dx, dy: params.dy },
          context
        )
        return MOBILE_WEB_BROWSER_APPLIED
      }
      try {
        await dispatchMobileWebBrowserCommand(
          'browser.mouseClick',
          {
            ...target,
            x: params.x,
            y: params.y,
            button: params.button,
            modifiers: params.modifiers,
            ...(params.radius === undefined ? {} : { radius: params.radius })
          },
          context
        )
      } catch (error) {
        // A modified click has no press/release equivalent, so only a plain click falls back.
        if (params.modifiers.length > 0) {
          throw error
        }
        await dispatchMobileWebBrowserCommand(
          'browser.mouseMove',
          { ...target, x: params.x, y: params.y },
          context
        )
        await dispatchMobileWebBrowserCommand(
          'browser.mouseDown',
          { ...target, button: params.button },
          context
        )
        await dispatchMobileWebBrowserCommand(
          'browser.mouseUp',
          { ...target, button: params.button },
          context
        )
      }
      return MOBILE_WEB_BROWSER_APPLIED
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.keyboard',
    params: KeyboardParams,
    handler: async (params, context) => {
      requireInputToken(context)
      const target = mobileWebBrowserTargetFields(params)
      await (params.action === 'insertText'
        ? dispatchMobileWebBrowserCommand(
            'browser.keyboardInsertText',
            { ...target, text: params.text },
            context
          )
        : dispatchMobileWebBrowserCommand(
            'browser.keypress',
            { ...target, key: params.key },
            context
          ))
      return MOBILE_WEB_BROWSER_APPLIED
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.dialog',
    params: MobileWebBrowserTarget.extend({ action: z.enum(['accept', 'dismiss']) }),
    handler: async (params, context) => {
      await dispatchMobileWebBrowserCommand(
        params.action === 'accept' ? 'browser.dialogAccept' : 'browser.dialogDismiss',
        mobileWebBrowserTargetFields(params),
        context
      )
      return MOBILE_WEB_BROWSER_APPLIED
    }
  })
]
