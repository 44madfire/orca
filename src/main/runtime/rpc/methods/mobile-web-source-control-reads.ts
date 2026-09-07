import { defineMethod } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlStatusPayloadSchema
} from '../../../../shared/mobile-web/source-control-operation-contract'
import {
  sanitizeMobileWebSourceControlDiff,
  sanitizeMobileWebSourceControlStatus
} from '../../../../shared/mobile-web/source-control-host-presentation'
import {
  clipMobileWebDiffResult,
  MOBILE_WEB_SOURCE_CONTROL_MAX_RESULT_BYTES
} from './mobile-web-source-control-diff-clip'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

const status = sourceControlHostMethod('git.status')
const diff = sourceControlHostMethod('git.diff')

export const MOBILE_WEB_SOURCE_CONTROL_READ_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.status',
    params: MobileWebSourceControlStatusPayloadSchema.omit({ workspaceId: true }).extend(
      MobileWebWorktreeScope.shape
    ),
    handler: async (params, context) => {
      const raw = await status.handler({ worktree: params.worktree, reuseLineStats: true }, context)
      const result = withoutMobileWebWorkspaceId(
        sanitizeMobileWebSourceControlStatus(raw, MOBILE_WEB_PAGE_IDENTITY, params.limit)
      )
      while (
        Buffer.byteLength(JSON.stringify(result)) > MOBILE_WEB_SOURCE_CONTROL_MAX_RESULT_BYTES &&
        result.entries.length
      ) {
        result.entries.pop()
        result.truncated = true
      }
      return result
    }
  }),
  defineMethod({
    name: 'mobileWeb.sourceControl.diff',
    params: MobileWebSourceControlDiffPayloadSchema.omit({ workspaceId: true }).extend(
      MobileWebWorktreeScope.shape
    ),
    handler: async (params, context) => {
      const raw = await diff.handler(
        {
          worktree: params.worktree,
          filePath: params.relativePath,
          staged: params.area === 'staged'
        },
        context
      )
      return clipMobileWebDiffResult(
        withoutMobileWebWorkspaceId(
          sanitizeMobileWebSourceControlDiff(raw, {
            ...params,
            workspaceId: MOBILE_WEB_PAGE_IDENTITY
          })
        )
      )
    }
  })
]
