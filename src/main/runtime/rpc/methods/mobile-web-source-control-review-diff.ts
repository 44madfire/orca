import { defineMethod } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlReviewDiffShape,
  rejectMissingReviewCompareIdentity
} from '../../../../shared/mobile-web/source-control-review-contract'
import { sanitizeMobileWebSourceControlDiff } from '../../../../shared/mobile-web/source-control-host-presentation'
import { clipMobileWebDiffResult } from './mobile-web-source-control-diff-clip'

const diff = sourceControlHostMethod('git.diff')
const branchDiff = sourceControlHostMethod('git.branchDiff')

export const MOBILE_WEB_SOURCE_CONTROL_REVIEW_DIFF_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.reviewDiff',
    params: MobileWebWorktreeScope.extend(MobileWebSourceControlReviewDiffShape)
      .strict()
      .superRefine(rejectMissingReviewCompareIdentity),
    handler: async (params, context) => {
      const raw =
        params.scope === 'branch'
          ? await branchDiff.handler(
              {
                worktree: params.worktree,
                filePath: params.relativePath,
                ...(params.oldRelativePath ? { oldPath: params.oldRelativePath } : {}),
                compare: params.compare
              },
              context
            )
          : await diff.handler(
              {
                worktree: params.worktree,
                filePath: params.relativePath,
                staged: params.scope === 'staged'
              },
              context
            )
      const {
        workspaceId: _workspaceId,
        area: _area,
        ...page
      } = sanitizeMobileWebSourceControlDiff(raw, {
        workspaceId: MOBILE_WEB_PAGE_IDENTITY,
        relativePath: params.relativePath,
        area: params.scope === 'staged' ? 'staged' : 'unstaged',
        offset: params.offset,
        limit: params.limit,
        ...(params.expectedRevision ? { expectedRevision: params.expectedRevision } : {})
      })
      return clipMobileWebDiffResult({ ...page, scope: params.scope })
    }
  })
]
