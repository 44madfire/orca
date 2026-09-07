import { z } from 'zod'
import { defineMethod } from '../core'
import {
  isMobileWebPageBrowserNavigationUrl,
  mobileWebPageBrowserUrl,
  MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH
} from '../../../../shared/mobile-web/browser-url-privacy'
import {
  dispatchMobileWebBrowserCommand,
  mobileWebBrowserTargetFields,
  MOBILE_WEB_BROWSER_APPLIED,
  MobileWebBrowserTarget
} from './mobile-web-browser-command-dispatch'

const HISTORY_COMMANDS = {
  back: 'browser.back',
  forward: 'browser.forward',
  reload: 'browser.reload'
} as const

export const MOBILE_WEB_BROWSER_NAVIGATION_METHODS = [
  defineMethod({
    name: 'mobileWeb.browser.navigate',
    params: MobileWebBrowserTarget.extend({
      url: z
        .string()
        .min(1)
        .max(MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH)
        .refine(isMobileWebPageBrowserNavigationUrl, 'Unsupported browser URL')
    }),
    handler: async (params, context) => {
      const result = await dispatchMobileWebBrowserCommand(
        'browser.goto',
        { ...mobileWebBrowserTargetFields(params), url: params.url },
        context
      )
      // The landing URL can carry credentials the page must never see, so it is stripped here.
      return {
        url: mobileWebPageBrowserUrl(
          typeof result === 'object' && result !== null && 'url' in result ? result.url : undefined
        )
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.history',
    params: MobileWebBrowserTarget.extend({ action: z.enum(['back', 'forward', 'reload']) }),
    handler: async (params, context) => {
      // The host result carries the raw tab URL; the page learns the new location from the stream.
      await dispatchMobileWebBrowserCommand(
        HISTORY_COMMANDS[params.action],
        mobileWebBrowserTargetFields(params),
        context
      )
      return MOBILE_WEB_BROWSER_APPLIED
    }
  })
]
