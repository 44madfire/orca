import { z } from 'zod'
import type { RpcContext } from '../core'
import { isStreamingMethod } from '../core'
import { SESSION_TAB_METHODS } from './session-tabs'
import { mobileWebSessionSnapshot } from './mobile-web-session-snapshot'
import { mobileWebSessionResources } from './mobile-web-session-resources'
import {
  admitMobileWebPageResourceSnapshot,
  resolveMobileWebPageResource
} from './mobile-web-page-resources'

export const MobileWebSessionScope = z.object({
  worktree: z.string().min(1).max(4096),
  pageSession: z.string().min(1).max(160),
  workspaceId: z.string().min(1).max(160)
})
export function mobileWebSessionMethod(name: string) {
  const method = SESSION_TAB_METHODS.find((entry) => entry.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing session method: ${name}`)
  }
  return method
}

export function projectMobileWebSession(
  result: unknown,
  params: z.infer<typeof MobileWebSessionScope>,
  context: RpcContext
) {
  if (context.signal?.aborted) {
    throw new Error('runtime_unavailable')
  }
  const resources = mobileWebSessionResources(context, params.pageSession)
  const {
    worktree: workspace,
    publicationEpoch,
    snapshotVersion
  } = z
    .object({
      worktree: z.string(),
      publicationEpoch: z.string().min(1).max(128),
      snapshotVersion: z.number().int().nonnegative()
    })
    .parse(result)
  if (`id:${workspace}` !== params.worktree) {
    throw new Error('selector_not_found')
  }
  admitMobileWebPageResourceSnapshot(
    context,
    params.pageSession,
    params.worktree,
    publicationEpoch,
    snapshotVersion
  )
  return mobileWebSessionSnapshot(
    result,
    workspace,
    params.workspaceId,
    resources.browser,
    resources.nativeChat
  )
}

export function resolveMobileWebSessionTab(
  params: z.infer<typeof MobileWebSessionScope> & { tabId: string },
  context: RpcContext
) {
  if (!params.tabId.startsWith('resource_')) {
    return params.tabId
  }
  const binding = resolveMobileWebPageResource<{ hostPageId: string }>(
    context,
    params.pageSession,
    params.worktree,
    'browser',
    params.tabId
  )
  return binding.hostPageId
}
