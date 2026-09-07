import { z } from 'zod'
import type { RpcContext } from '../core'
import { BROWSER_CORE_METHODS } from './browser-core'
import { BROWSER_EXTRA_METHODS } from './browser-extras'

/** The shell rewrites the page's workspace handle into `worktree`; `page` is the host browser page
 * id the page already holds from `mobileWeb.session.createBrowser`. */
export const MobileWebBrowserTarget = z.object({
  worktree: z.string().min(1).max(4096),
  page: z.string().min(1).max(512)
})

export const MOBILE_WEB_BROWSER_APPLIED = { applied: true } as const

export const MobileWebBrowserCoordinate = z.number().finite().min(-100_000).max(100_000)

const commands = new Map(
  [...BROWSER_CORE_METHODS, ...BROWSER_EXTRA_METHODS].map((method) => [method.name, method])
)

export async function dispatchMobileWebBrowserCommand(
  name: string,
  fields: Record<string, unknown>,
  context: RpcContext
): Promise<unknown> {
  const command = commands.get(name)
  if (!command) {
    throw new Error('method_not_found')
  }
  if (context.signal?.aborted) {
    throw new Error('runtime_unavailable')
  }
  return command.handler(command.params!.parse(fields), context)
}

export function mobileWebBrowserTargetFields(params: z.infer<typeof MobileWebBrowserTarget>): {
  worktree: string
  page: string
} {
  return { worktree: params.worktree, page: params.page }
}
