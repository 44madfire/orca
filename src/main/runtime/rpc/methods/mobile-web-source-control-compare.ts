import { defineMethod } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import {
  MobileWebGitObjectIdSchema,
  MobileWebGitRefNameSchema
} from '../../../../shared/mobile-web/source-control-history-contract'
import {
  projectMobileWebBranchCompare,
  projectMobileWebCommitCompare
} from '../../../../shared/mobile-web/source-control-history-presentation'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

const branchCompare = sourceControlHostMethod('git.branchCompare')
const commitCompare = sourceControlHostMethod('git.commitCompare')

export const MOBILE_WEB_SOURCE_CONTROL_COMPARE_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.branchCompare',
    params: MobileWebWorktreeScope.extend({ baseRef: MobileWebGitRefNameSchema }),
    handler: async (params, context) =>
      withoutMobileWebWorkspaceId(
        projectMobileWebBranchCompare(
          await branchCompare.handler(
            { worktree: params.worktree, baseRef: params.baseRef },
            context
          ),
          MOBILE_WEB_PAGE_IDENTITY,
          params.baseRef
        )
      )
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.commitCompare',
    params: MobileWebWorktreeScope.extend({ commitId: MobileWebGitObjectIdSchema }),
    handler: async (params, context) =>
      withoutMobileWebWorkspaceId(
        projectMobileWebCommitCompare(
          await commitCompare.handler(
            { worktree: params.worktree, commitId: params.commitId },
            context
          ),
          MOBILE_WEB_PAGE_IDENTITY,
          params.commitId
        )
      )
  })
]
