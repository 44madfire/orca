import path from 'node:path'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry,
  waitForVisibleHostedWebView
} from './hosted-webview-cdp-session.mjs'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'

const SWITCH_LABEL = 'Open sessions in Chat UI'

export async function verifyHostedIosChatSettings({
  deviceUdid,
  discoveryUrl,
  workspaceDocument,
  expectedWorkspace,
  runtimeDirectory,
  timeoutMs
}) {
  const open = async (document) => {
    await activateHostedWebViewControl(document, { kind: 'label', value: 'Chat settings' })
    return waitForVisibleHostedWebView({
      discoveryUrl,
      expectedHrefIncludes: '/native-chat-settings',
      expectedText: 'for this paired host',
      timeoutMs
    })
  }
  const back = async (document) => {
    await activateHostedWebViewControl(document, { kind: 'label', value: 'Back' })
    return waitForVisibleHostedWebView({ discoveryUrl, expectedText: expectedWorkspace, timeoutMs })
  }
  let settings = await open(workspaceDocument)
  if (!(await checked(settings))) {
    await activateHostedWebViewControl(settings, { kind: 'label', value: SWITCH_LABEL })
  }
  await waitChecked(settings, true, timeoutMs)
  let workspace = await back(settings)
  settings = await open(workspace)
  await waitChecked(settings, true, timeoutMs)
  const screenshot = path.join(runtimeDirectory, 'hosted-chat-settings.png')
  await captureScreenshot(deviceUdid, screenshot)
  await activateHostedWebViewControl(settings, { kind: 'label', value: SWITCH_LABEL })
  await waitChecked(settings, false, timeoutMs)
  workspace = await back(settings)
  settings = await open(workspace)
  await waitChecked(settings, false, timeoutMs)
  return {
    workspaceDocument: await back(settings),
    evidence: {
      persistenceAfterReopen: true,
      restoredTerminalDefault: true,
      screenshot
    }
  }
}

async function checked(document) {
  const value = await evaluateHostedDocumentWithRetry(
    document,
    `(() => {
    const element = document.querySelector('[aria-label="${SWITCH_LABEL}"]');
    if (!element) throw new Error('Chat preference switch missing');
    return JSON.stringify(element.getAttribute('aria-checked') === 'true' ||
      element.checked === true || element.querySelector('input')?.checked === true);
  })()`
  )
  return JSON.parse(value)
}
async function waitChecked(document, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await checked(document)) === expected) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Chat preference did not persist the requested value')
}
