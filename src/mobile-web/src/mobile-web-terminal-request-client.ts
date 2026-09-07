import {
  MOBILE_WEB_SHELL_HOST_PAGE_SESSION_FEATURE,
  MOBILE_WEB_SHELL_HOST_REQUEST_DISPATCH_FEATURE
} from '../../shared/mobile-web/shell-feature-contract'
import { bindMobileWebHostTerminalActions } from './mobile-web-host-terminal-actions'
import { MobileWebHapticSelectionResultSchema } from '../../shared/mobile-web/bridge-operation-contract'
import {
  MobileWebTerminalDeviceInputResultSchema,
  MobileWebTerminalRequestSchema,
  type MobileWebTerminalDeviceInputResult,
  type MobileWebTerminalRequest
} from '../../shared/mobile-web/terminal-stream-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

// One-shot terminal operations; the stream itself lives on the subscription client.
export class MobileWebTerminalRequestClient {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly hostActions = false
  ) {}

  prepareActions(workspaceId: string, tabId: string, signal: AbortSignal) {
    if (
      !this.hostActions ||
      !this.requests.supports('workspace', 'hostCatalog') ||
      !this.requests.supports('workspace', 'hostRequest')
    ) {
      return null
    }
    return bindMobileWebHostTerminalActions(this.requests, workspaceId, tabId, signal)
  }

  request(payload: Exclude<MobileWebTerminalRequest, { operation: 'subscribe' }>): Promise<null> {
    return this.requests.request(
      'terminal',
      payload.operation,
      payload,
      MobileWebTerminalRequestSchema,
      MobileWebHapticSelectionResultSchema
    )
  }

  deviceInput(
    payload: Extract<MobileWebTerminalRequest, { operation: 'clipboardPaste' | 'attachImage' }>
  ): Promise<MobileWebTerminalDeviceInputResult> {
    return this.requests.request(
      'terminal',
      payload.operation,
      payload,
      MobileWebTerminalRequestSchema,
      MobileWebTerminalDeviceInputResultSchema
    )
  }
}

export function mobileWebTerminalClientBindings(
  requests: MobileWebOneShotRequestClient,
  features: ReadonlySet<string>
) {
  const client = new MobileWebTerminalRequestClient(
    requests,
    features.has(MOBILE_WEB_SHELL_HOST_PAGE_SESSION_FEATURE) &&
      features.has(MOBILE_WEB_SHELL_HOST_REQUEST_DISPATCH_FEATURE)
  )
  return {
    prepareTerminalActions: client.prepareActions.bind(client),
    terminalRequest: client.request.bind(client),
    terminalDeviceInputRequest: client.deviceInput.bind(client)
  }
}
