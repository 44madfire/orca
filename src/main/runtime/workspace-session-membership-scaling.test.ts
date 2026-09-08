import { expect, it, vi } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { rebaseWorkspaceSessionTerminalMembership } from './workspace-session-terminal-membership-authority'

it('rebases a large group without rescanning tab order for every recent tab', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => `tab-${index}`)
  const session: WorkspaceSessionState = {
    activeRepoId: 'repo',
    activeWorktreeId: 'repo::/workspace',
    activeTabId: null,
    tabsByWorktree: {
      'repo::/workspace': ids.map((id, index) => ({
        id,
        worktreeId: 'repo::/workspace',
        ptyId: null,
        title: id,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: 0
      }))
    },
    terminalLayoutsByTabId: {},
    terminalTopologyRevisionByRepoId: { repo: 1 },
    tabGroups: {
      'repo::/workspace': [
        {
          id: 'group',
          worktreeId: 'repo::/workspace',
          activeTabId: 'missing',
          tabOrder: [...ids, 'missing'],
          recentTabIds: [...ids, 'missing']
        }
      ]
    }
  }
  const includes = vi.spyOn(Array.prototype, 'includes')
  let result: WorkspaceSessionState
  let probes: number
  try {
    result = rebaseWorkspaceSessionTerminalMembership(session, session)
    probes = includes.mock.calls.length
  } finally {
    includes.mockRestore()
  }
  expect(probes).toBeLessThan(10)
  expect(result.tabGroups?.['repo::/workspace'][0]).toMatchObject({
    tabOrder: ids,
    recentTabIds: ids,
    activeTabId: ids[0]
  })
})
