import { evidenceStep } from './hosted-webview-e2e-report.mjs'
import { verifyHostedIosNativeAlertJourney } from './hosted-ios-native-alert-journey.mjs'
import { verifyHostedIosBrowserSettings } from './hosted-ios-browser-settings-journey.mjs'
import { verifyHostedIosChatSettings } from './hosted-ios-chat-settings-journey.mjs'

export async function verifyHostedIosWorkspaceDeviceCapabilities(args) {
  const nativeAlert = await evidenceStep('native Alert bridge journey', () =>
    verifyHostedIosNativeAlertJourney(args)
  )
  const chatSettings = args.verifyChatPreferences
    ? await evidenceStep('hosted chat preference persistence', () =>
        verifyHostedIosChatSettings({ ...args, workspaceDocument: nativeAlert.workspaceDocument })
      )
    : null
  const browserSettings = chatSettings
    ? await evidenceStep('hosted browser preference persistence', () =>
        verifyHostedIosBrowserSettings({
          ...args,
          workspaceDocument: chatSettings.workspaceDocument
        })
      )
    : null
  return {
    nativeAlert,
    browserSettings,
    chatSettings,
    workspaceDocument:
      browserSettings?.workspaceDocument ??
      chatSettings?.workspaceDocument ??
      nativeAlert.workspaceDocument
  }
}
