import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { GIT_METHODS } from './git'
import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlStatusPayloadSchema
} from '../../../../shared/mobile-web/source-control-operation-contract'
import {
  sanitizeMobileWebSourceControlDiff,
  sanitizeMobileWebSourceControlStatus
} from '../../../../shared/mobile-web/source-control-host-presentation'

const Worktree = z.string().min(1).max(4096)
const PAGE_IDENTITY = 'page'
const MAX_RESULT_BYTES = 512 * 1024

function sourceMethod(name: string) {
  const method = GIT_METHODS.find((entry) => entry.name === name)
  if (!method || isStreamingMethod(method)) {
    throw new Error(`Missing unary source control method: ${name}`)
  }
  return method
}
const status = sourceMethod('git.status')
const diff = sourceMethod('git.diff')

export const MOBILE_WEB_SOURCE_CONTROL_READ_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.status',
    params: MobileWebSourceControlStatusPayloadSchema.omit({ workspaceId: true }).extend({
      worktree: Worktree
    }),
    handler: async (params, context) => {
      const raw = await status.handler({ worktree: params.worktree, reuseLineStats: true }, context)
      const { workspaceId: _workspaceId, ...result } = sanitizeMobileWebSourceControlStatus(
        raw,
        PAGE_IDENTITY,
        params.limit
      )
      while (
        Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES &&
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
    params: MobileWebSourceControlDiffPayloadSchema.omit({ workspaceId: true }).extend({
      worktree: Worktree
    }),
    handler: async (params, context) => {
      const raw = await diff.handler(
        {
          worktree: params.worktree,
          filePath: params.relativePath,
          staged: params.area === 'staged'
        },
        context
      )
      const { workspaceId: _workspaceId, ...result } = sanitizeMobileWebSourceControlDiff(raw, {
        ...params,
        workspaceId: PAGE_IDENTITY
      })
      // Escaped line text can exceed the byte budget even within the row-count limit.
      if (result.kind === 'text') {
        while (
          Buffer.byteLength(JSON.stringify(result)) > MAX_RESULT_BYTES &&
          result.rows.length > 1
        ) {
          result.rows.pop()
          result.nextOffset = result.offset + result.rows.length
        }
      }
      return result
    }
  })
]
