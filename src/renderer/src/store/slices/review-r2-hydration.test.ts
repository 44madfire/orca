import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { it, expect } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
it('scoped authoritative retirement removes only target fences', () => {
  const store = createTestStore()
  const wt = 'repo::/wt'
  const pane = 'tab-a:11111111-2222-4333-8444-555555555555'
  const tab = makeTab({ id: 'tab-a', worktreeId: wt })
  store.setState({
    tabsByWorktree: { [wt]: [tab] },
    legacyWorkerResumeFencesByPaneKey: {
      [pane]: true,
      'tab-b:22222222-2222-4333-8444-555555555555': true
    }
  })
  store.getState().hydrateWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [wt]: [tab] },
      legacyWorkerResumeFencesByPaneKey: {}
    },
    { replaceWorkspaceKeys: [wt], additionalValidWorkspaceKeys: [worktreeWorkspaceKey(wt)] }
  )
  expect(
    store.getState().legacyWorkerResumeFencesByPaneKey['tab-b:22222222-2222-4333-8444-555555555555']
  ).toBe(true)
  expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBeUndefined()
})
