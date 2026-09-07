import { z } from 'zod'
import { defineMethod } from '../core'
import { resolveMobileWebPageResource } from './mobile-web-page-resources'
import { mobileWebNativeChatBinding } from './mobile-web-session-snapshot'
import type { MobileWebHostNativeChatBinding } from './mobile-web-session-resources'

// Shell-only: these private native bindings must never enter the page catalog.
export const MOBILE_WEB_SESSION_NATIVE_RESOURCE_METHOD = defineMethod({
  name: 'mobileWeb.resource.resolve',
  params: z.object({
    worktree: z.string().min(1).max(4096),
    pageSession: z.string().min(1).max(160),
    kind: z.enum(['browser', 'sessionChat']),
    resourceId: z.string().min(1).max(160)
  }),
  handler: async (params, context) => {
    const value = resolveMobileWebPageResource<
      MobileWebHostNativeChatBinding | { hostWorkspaceId: string; hostPageId: string }
    >(context, params.pageSession, params.worktree, params.kind, params.resourceId)
    const snapshot = await context.runtime.listMobileSessionTabs(
      params.worktree,
      context.pairedDeviceId
    )
    if (snapshot.worktree !== value.hostWorkspaceId) {
      throw new Error('selector_not_found')
    }
    if ('hostPageId' in value) {
      if (
        !snapshot.tabs.some(
          (tab) => tab.type === 'browser' && tab.browserPageId === value.hostPageId
        )
      ) {
        throw new Error('selector_not_found')
      }
    } else {
      const current = mobileWebNativeChatBinding(
        snapshot.tabs.find((tab) => tab.id === value.hostTabId),
        snapshot.worktree
      )
      if (!current || JSON.stringify(current) !== JSON.stringify(value)) {
        throw new Error('selector_not_found')
      }
    }
    if (context.signal?.aborted) {
      throw new Error('runtime_unavailable')
    }
    return value
  }
})
