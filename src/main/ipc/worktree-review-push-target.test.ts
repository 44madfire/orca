import { expect, it, vi } from 'vitest'
import { resolveStoredReviewPushTarget } from './worktree-review-push-target'
import { reviewTarget } from '../../shared/__fixtures__/git-review-target'
import type { Store } from '../persistence'

it('rejects missing and superseded targets at the local IPC metadata boundary', () => {
  const meta = {
    linkedPR: 42,
    pushTarget: undefined as ReturnType<typeof reviewTarget> | undefined
  }
  const store = {
    getAllWorktreeMetaForHost: vi.fn(() => ({ 'repo::/repo/wt': meta }))
  } as unknown as Store
  expect(() => resolveStoredReviewPushTarget(store, { worktreePath: '/repo/wt' })).toThrow(
    'unresolved'
  )
  meta.pushTarget = reviewTarget('origin', 'feature')
  expect(resolveStoredReviewPushTarget(store, { worktreePath: '/repo/wt' })).toEqual(
    meta.pushTarget
  )
  expect(() =>
    resolveStoredReviewPushTarget(store, {
      worktreePath: '/repo/wt',
      pushTarget: reviewTarget('fork', 'feature')
    })
  ).toThrow('changed')
  expect(store.getAllWorktreeMetaForHost).toHaveBeenCalledWith('local')
})

it('reads SSH-owned metadata without substituting the local row', () => {
  const store = {
    getAllWorktreeMetaForHost: vi.fn(() => ({ 'repo::/repo/wt': { linkedGitLabMR: 42 } }))
  } as unknown as Store
  expect(() =>
    resolveStoredReviewPushTarget(store, { worktreePath: '/repo/wt', connectionId: 'host' })
  ).toThrow('unresolved')
  expect(store.getAllWorktreeMetaForHost).toHaveBeenCalledWith('ssh:host')
})
