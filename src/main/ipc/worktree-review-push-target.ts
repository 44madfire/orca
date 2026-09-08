import { resolve } from 'node:path'
import { LOCAL_EXECUTION_HOST_ID, toSshExecutionHostId } from '../../shared/execution-host'
import { splitWorktreeId } from '../../shared/worktree/id'
import { linkedReviewOperationTarget } from '../../shared/linked-review-operation-target'
import type { GitPushTarget } from '../../shared/worktree/types'
import { readAllWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import type { Store } from '../persistence'

export function resolveStoredReviewPushTarget(
  store: Store,
  args: {
    worktreePath: string
    connectionId?: string
    pushTarget?: GitPushTarget
  }
): GitPushTarget | undefined {
  const host = args.connectionId ? toSshExecutionHostId(args.connectionId) : LOCAL_EXECUTION_HOST_ID
  const comparable = (path: string): string => (args.connectionId ? path : resolve(path))
  const entries = Object.entries(readAllWorktreeMetaForHost(store, host)).filter(([id]) => {
    const parsed = splitWorktreeId(id)
    return parsed && comparable(parsed.worktreePath) === comparable(args.worktreePath)
  })
  if (entries.length > 1) {
    throw new Error('Review push workspace ownership is ambiguous.')
  }
  return linkedReviewOperationTarget(entries[0]?.[1], args.pushTarget)
}
