import { z } from 'zod'
import { defineMethod, type RpcContext } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlReviewMetadataUpdateShape,
  rejectDuplicateReviewMetadataKeys,
  type MobileWebSourceControlReviewMetadataResult
} from '../../../../shared/mobile-web/source-control-review-contract'
import {
  mobileWebReviewMetadataWorktreeFields,
  projectMobileWebReviewMetadata
} from '../../../../shared/mobile-web/source-control-review-presentation'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

const worktreeShow = sourceControlHostMethod('worktree.show')
const worktreeSet = sourceControlHostMethod('worktree.set')

const UpdateParams = MobileWebWorktreeScope.extend(MobileWebSourceControlReviewMetadataUpdateShape)
  .strict()
  .superRefine(rejectDuplicateReviewMetadataKeys)

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_METADATA_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewMetadata',
    params: MobileWebWorktreeScope,
    handler: async (params, context) =>
      withoutMobileWebWorkspaceId(await readReviewMetadata(params.worktree, context))
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewMetadataUpdate',
    params: UpdateParams,
    handler: async (params, context) => {
      const current = await readReviewMetadata(params.worktree, context)
      if (current.revision !== params.expectedRevision) {
        throw new Error('conflict')
      }
      // worktree.set has no compare-and-set, so another writer can still win after this read.
      await worktreeSet.handler(
        {
          worktree: params.worktree,
          ...mobileWebReviewMetadataWorktreeFields({
            worktreeId: worktreeIdFromSelector(params.worktree),
            comments: params.comments,
            reviewState: params.reviewState
          })
        },
        context
      )
      return withoutMobileWebWorkspaceId(await readReviewMetadata(params.worktree, context))
    }
  })
]

async function readReviewMetadata(
  worktree: string,
  context: RpcContext
): Promise<MobileWebSourceControlReviewMetadataResult> {
  const shown = await worktreeShow.handler({ worktree }, context)
  const record = z.object({ worktree: z.unknown() }).parse(shown).worktree
  return projectMobileWebReviewMetadata(record, MOBILE_WEB_PAGE_IDENTITY)
}

function worktreeIdFromSelector(worktree: string): string {
  return worktree.startsWith('id:') ? worktree.slice('id:'.length) : worktree
}
