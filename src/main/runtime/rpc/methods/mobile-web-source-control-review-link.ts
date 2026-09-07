import { z } from 'zod'
import { defineMethod, type RpcContext } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlReviewLinkUpdatePayloadSchema,
  type MobileWebSourceControlReviewLinkResult
} from '../../../../shared/mobile-web/source-control-review-contract'
import {
  mobileWebReviewLinkWorktreeField,
  projectMobileWebReviewLink
} from '../../../../shared/mobile-web/source-control-review-presentation'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

const worktreeShow = sourceControlHostMethod('worktree.show')
const worktreeSet = sourceControlHostMethod('worktree.set')

const UpdateParams = MobileWebWorktreeScope.extend(
  MobileWebSourceControlReviewLinkUpdatePayloadSchema.omit({ workspaceId: true }).shape
)

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_LINK_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewLink',
    params: MobileWebWorktreeScope,
    handler: async (params, context) =>
      withoutMobileWebWorkspaceId(await readReviewLink(params.worktree, context))
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewLinkUpdate',
    params: UpdateParams,
    handler: async (params, context) => {
      await worktreeSet.handler(
        {
          worktree: params.worktree,
          ...mobileWebReviewLinkWorktreeField(params.provider, params.number),
          ...(params.baseRef ? { baseRef: params.baseRef } : {})
        },
        context
      )
      return withoutMobileWebWorkspaceId(await readReviewLink(params.worktree, context))
    }
  })
]

async function readReviewLink(
  worktree: string,
  context: RpcContext
): Promise<MobileWebSourceControlReviewLinkResult> {
  const shown = await worktreeShow.handler({ worktree }, context)
  const record = z.object({ worktree: z.unknown() }).parse(shown).worktree
  return projectMobileWebReviewLink(record, MOBILE_WEB_PAGE_IDENTITY)
}
