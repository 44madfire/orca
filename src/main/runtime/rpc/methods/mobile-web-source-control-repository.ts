import { defineMethod, type RpcContext } from '../core'
import {
  MOBILE_WEB_PAGE_IDENTITY,
  MobileWebWorktreeScope,
  sourceControlHostMethod
} from './mobile-web-source-control-host-method'
import { projectMobileWebRepositoryState } from '../../../../shared/mobile-web/source-control-repository-presentation'
import { withoutMobileWebWorkspaceId } from './mobile-web-source-control-workspace-id'

const status = sourceControlHostMethod('git.status')
const upstream = sourceControlHostMethod('git.upstreamStatus')
const worktreeShow = sourceControlHostMethod('worktree.show')
const repoBaseRefDefault = sourceControlHostMethod('repo.baseRefDefault')

export const MOBILE_WEB_SOURCE_CONTROL_REPOSITORY_METHODS = [
  defineMethod({
    name: 'mobileWeb.sourceControl.repositoryState',
    params: MobileWebWorktreeScope,
    handler: async (params, context) => {
      const [statusResult, upstreamResult, baseRef] = await Promise.all([
        status.handler({ worktree: params.worktree }, context),
        upstream.handler({ worktree: params.worktree }, context),
        resolveBaseRef(params.worktree, context)
      ])
      return withoutMobileWebWorkspaceId(
        projectMobileWebRepositoryState({
          status: statusResult,
          upstream: upstreamResult,
          baseRef,
          workspaceId: MOBILE_WEB_PAGE_IDENTITY
        })
      )
    }
  })
]

/** The workspace ref wins; the project default only fills in a workspace that never pinned one. */
async function resolveBaseRef(worktree: string, context: RpcContext): Promise<unknown> {
  const shown = await worktreeShow.handler({ worktree }, context)
  const record = isRecord(shown) && isRecord(shown.worktree) ? shown.worktree : undefined
  if (typeof record?.baseRef === 'string' && record.baseRef.length > 0) {
    return record.baseRef
  }
  if (typeof record?.repoId !== 'string' || record.repoId.length === 0) {
    return null
  }
  const fallback = await repoBaseRefDefault.handler({ repo: `id:${record.repoId}` }, context)
  return isRecord(fallback) ? fallback.defaultBaseRef : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
