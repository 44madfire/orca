import { z } from 'zod'
import { isStreamingMethod, type RpcMethod } from '../core'
import { GIT_METHODS } from './git'
import { REPO_METHODS } from './repo'
import { WORKTREE_METHODS } from './worktree'

export const MobileWebWorktreeScope = z.object({ worktree: z.string().min(1).max(4096) })

/** The page never sees a workspace handle in a wrapper result: the shell rewrote its own handle
 * into `worktree`, so the projection carries this placeholder and the page restores its handle. */
export const MOBILE_WEB_PAGE_IDENTITY = 'page'

const HOST_METHODS = new Map(
  [...GIT_METHODS, ...WORKTREE_METHODS, ...REPO_METHODS].map((method) => [method.name, method])
)

export function sourceControlHostMethod(name: string): RpcMethod {
  const method = HOST_METHODS.get(name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing source control host method: ${name}`)
  }
  return method
}
