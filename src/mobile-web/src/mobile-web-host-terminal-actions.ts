import type { MobileWebTerminalRequest } from '../../shared/mobile-web/terminal-stream-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { readMobileWebHostMethods, requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export type MobileWebTerminalMetadataRequest = Extract<
  MobileWebTerminalRequest,
  { operation: 'displayMode' | 'clear' | 'rename' }
>
export type MobileWebTerminalMetadataAction = (
  request: MobileWebTerminalMetadataRequest
) => Promise<null>

export async function bindMobileWebHostTerminalActions(
  requests: MobileWebOneShotRequestClient,
  workspaceId: string,
  tabId: string,
  signal: AbortSignal
): Promise<MobileWebTerminalMetadataAction | null> {
  const methods = ['mobileWeb.terminal.bind', 'mobileWeb.terminal.action']
  const deadline = Date.now() + 15_000
  const options = () => {
    const timeoutMs = deadline - Date.now()
    if (timeoutMs <= 0) {
      throw new MobileWebBridgeClientError('timeout', true)
    }
    return { signal, timeoutMs }
  }
  let bound: unknown
  try {
    const catalog = await readMobileWebHostMethods(requests, methods, options())
    if (!methods.every((method) => catalog.grants.some((grant) => grant.method === method))) {
      return null
    }
    bound = await requestMobileWebHost(requests, methods[0], workspaceId, { tabId }, options())
  } catch (error) {
    if (error instanceof MobileWebBridgeClientError && error.code === 'unsupported_capability') {
      return null
    }
    throw error
  }
  if (
    typeof bound !== 'object' ||
    bound === null ||
    !('resourceId' in bound) ||
    typeof bound.resourceId !== 'string'
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  const resourceId = bound.resourceId
  return async ({ operation, streamId: _streamId, ...fields }) => {
    const method =
      operation === 'displayMode'
        ? 'terminal.setDisplayMode'
        : operation === 'clear'
          ? 'terminal.clearBuffer'
          : 'terminal.rename'
    // A missing acknowledgement may hide a committed action; never retry on the legacy lane.
    const result = await requestMobileWebHost(
      requests,
      methods[1],
      workspaceId,
      { resourceId, method, fields, timeoutMs: 15_000 },
      { signal }
    )
    if (
      typeof result !== 'object' ||
      result === null ||
      !('applied' in result) ||
      result.applied !== true
    ) {
      throw new MobileWebBridgeClientError('invalid_message', false)
    }
    return null
  }
}
