import type { MobileWebHostRequestClient } from '../../../src/mobile-web/src/mobile-web-host-request-client'
import type { RpcRequestSender } from '../transport/rpc-client'

/** The hosted page reaches the same desktop methods the native app calls, so the task operation
 * modules are shared verbatim. A desktop error arrives as a rejected bridge request, never as an
 * `ok: false` reply, which is why this sender only ever resolves successes. */
export function webHostTaskRpcSender(host: MobileWebHostRequestClient): RpcRequestSender {
  return {
    async sendRequest(method, params) {
      return { ok: true, result: await host.request({ method, params: hostParams(params) }) }
    }
  }
}

function hostParams(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {}
}
