import { z } from 'zod'
import { defineMethod } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import {
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_DEFAULT_LIMIT,
  MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT,
  MobileWebGitRefNameSchema
} from '../../../../shared/mobile-web/source-control-history-contract'
import {
  projectMobileWebBranches,
  projectMobileWebHistory
} from '../../../../shared/mobile-web/source-control-history-presentation'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

const branches = sourceControlHostMethod('git.localBranches')
const history = sourceControlHostMethod('git.history')

export const MOBILE_WEB_SOURCE_CONTROL_HISTORY_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.branches',
    params: MobileWebWorktreeScope,
    handler: async (params, context) =>
      withoutMobileWebWorkspaceId(
        projectMobileWebBranches(
          await branches.handler({ worktree: params.worktree }, context),
          MOBILE_WEB_PAGE_IDENTITY
        )
      )
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.history',
    params: MobileWebWorktreeScope.extend({
      limit: z
        .number()
        .int()
        .min(1)
        .max(MOBILE_WEB_SOURCE_CONTROL_HISTORY_MAX_LIMIT)
        .default(MOBILE_WEB_SOURCE_CONTROL_HISTORY_DEFAULT_LIMIT),
      baseRef: MobileWebGitRefNameSchema.optional()
    }),
    handler: async (params, context) =>
      withoutMobileWebWorkspaceId(
        projectMobileWebHistory(
          await history.handler(
            {
              worktree: params.worktree,
              limit: params.limit,
              ...(params.baseRef === undefined ? {} : { baseRef: params.baseRef })
            },
            context
          ),
          MOBILE_WEB_PAGE_IDENTITY,
          params.limit
        )
      )
  })
]
