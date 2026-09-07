import {
  MobileWebBrowserEventSchema,
  type MobileWebBrowserEvent
} from '../../../../shared/mobile-web/browser-operation-contract'
import { mobileWebPageBrowserUrl } from '../../../../shared/mobile-web/browser-url-privacy'

/** Screencast events carry raw tab URLs, host page ids and driver-supplied text. This is the only
 * projection the page sees, so anything not named here never reaches it. */
export function mobileWebBrowserPageEvent(value: unknown): MobileWebBrowserEvent | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.type === 'ready' || value.type === 'navigation') {
    const tab = isRecord(value.tab) ? value.tab : {}
    return MobileWebBrowserEventSchema.parse({
      type: value.type,
      tab: {
        url: mobileWebPageBrowserUrl(tab.url),
        title: boundedText(tab.title, 240, ''),
        canGoBack: tab.canGoBack === true,
        canGoForward: tab.canGoForward === true
      }
    })
  }
  if (value.type === 'end' || value.type === 'dialogClosed') {
    return { type: value.type }
  }
  if (value.type === 'dialog') {
    return MobileWebBrowserEventSchema.parse({
      type: 'dialog',
      dialogType: isDialogType(value.dialogType) ? value.dialogType : 'alert',
      message: boundedText(value.message, 8192, 'Browser dialog')
    })
  }
  if (value.type === 'error') {
    return { type: 'error', message: 'Browser stream failed.' }
  }
  return null
}

function boundedText(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' ? value.slice(0, maximum) : fallback
}

function isDialogType(value: unknown): value is 'alert' | 'confirm' | 'prompt' | 'beforeunload' {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
