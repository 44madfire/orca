import path from 'node:path'
import {
  activateHostedWebViewControl,
  evaluateHostedDocumentWithRetry
} from './hosted-webview-cdp-session.mjs'
import { openHostedIosSettings, closeHostedIosSettings } from './hosted-ios-settings-navigation.mjs'
import { captureAgentHistorySimulatorScreenshot as captureScreenshot } from './hosted-ios-agent-history-parity.mjs'

export async function verifyHostedIosBrowserSettings(args) {
  const open = (document) =>
    openHostedIosSettings(args, document, 'Browser', '/browser-settings', 'for this paired host')
  let settings = await open(args.workspaceDocument)
  await choose(settings, 'Phone browser', args.timeoutMs)
  settings = await open(await closeHostedIosSettings(args, settings))
  await waitMode(settings, 'Phone browser', args.timeoutMs)
  const screenshot = path.join(args.runtimeDirectory, 'hosted-browser-settings.png')
  await captureScreenshot(args.deviceUdid, screenshot)
  await choose(settings, 'Orca browser on desktop', args.timeoutMs)
  settings = await open(await closeHostedIosSettings(args, settings))
  await waitMode(settings, 'Orca browser on desktop', args.timeoutMs)
  return {
    workspaceDocument: await closeHostedIosSettings(args, settings),
    evidence: { persistenceAfterReopen: true, restoredDesktopBrowser: true, screenshot }
  }
}

async function choose(document, label, timeoutMs) {
  await waitMode(document, undefined, timeoutMs)
  await activateHostedWebViewControl(document, { kind: 'label', value: 'Open terminal links' })
  await waitPickerOption(document, label, timeoutMs)
  await activateHostedWebViewControl(document, { kind: 'text', value: label })
  await waitMode(document, label, timeoutMs)
}

async function waitMode(document, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await evaluateHostedDocumentWithRetry(
      document,
      `(() => {
      const error = document.querySelector('[role="alert"]');
      if (error?.textContent.includes('Could not')) throw new Error(error.textContent);
      const row = document.querySelector('[aria-label="Open terminal links"]');
      return JSON.stringify(Boolean(row && row.getAttribute('aria-disabled') !== 'true' &&
        !row.disabled && (${JSON.stringify(label)} === undefined || row.textContent.includes(${JSON.stringify(label)}))));
    })()`
    )
    if (JSON.parse(ready)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Browser preference did not finish loading or saving')
}

async function waitPickerOption(document, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const visible = await evaluateHostedDocumentWithRetry(
      document,
      `JSON.stringify(
      Array.from(document.querySelectorAll('body *')).some((element) => {
        if (element.children.length || element.textContent.trim() !== ${JSON.stringify(label)}) return false;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' &&
          rect.width > 0 && rect.height > 0 && rect.top < innerHeight && rect.bottom > 0;
      }))`
    )
    if (JSON.parse(visible)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Browser option did not become visible: ${label}`)
}
