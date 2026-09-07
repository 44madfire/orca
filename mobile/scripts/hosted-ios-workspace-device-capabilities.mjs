import { evidenceStep } from './hosted-webview-e2e-report.mjs'
import { verifyHostedIosNativeAlertJourney } from './hosted-ios-native-alert-journey.mjs'
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
  return {
    nativeAlert,
    chatSettings,
    workspaceDocument: chatSettings?.workspaceDocument ?? nativeAlert.workspaceDocument
  }
}
