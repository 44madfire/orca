import { describe, expect, it } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { resolveActivationPtyListScope } from './worktree-activation-pty-inventory'

const worktreeId = 'repo::/workspace'

describe('activation inventory execution scope', () => {
  it('keeps a known local repo usable before unrelated runtime catalogs hydrate', () => {
    expect(
      resolveActivationPtyListScope(
        {
          repos: [{ id: 'repo' }],
          runtimeEnvironments: [],
          runtimeEnvironmentCatalogHydrated: false,
          activeWorktreeId: 'other::/remote',
          activeWorkspaceExecutionHostId: 'ssh:other'
        },
        worktreeId
      )
    ).toEqual({ connectionId: null })
  })

  it('does not use the native repo fallback for an explicitly owned worktree', () => {
    expect(() =>
      resolveActivationPtyListScope(
        {
          repos: [{ id: 'repo' }],
          worktreesByRepo: { repo: [{ id: worktreeId, repoId: 'repo', hostId: 'runtime:hub' }] }
        },
        worktreeId
      )
    ).toThrow('provider unavailable')
  })

  it.each(['local', 'ssh:remote%20box'] as const)('resolves only %s', (hostId) => {
    expect(
      resolveActivationPtyListScope(
        {
          repos: [{ id: 'repo', executionHostId: hostId }]
        },
        worktreeId
      )
    ).toEqual({ connectionId: hostId === 'local' ? null : 'remote box' })
  })

  it('resolves folder workspaces without a Git worktree row', () => {
    expect(
      resolveActivationPtyListScope(
        {
          folderWorkspaces: [{ id: 'folder', projectGroupId: 'group', connectionId: 'box' }]
        },
        folderWorkspaceKey('folder')
      )
    ).toEqual({ connectionId: 'box' })
  })

  it('does not choose a provider for missing or ambiguous ownership', () => {
    expect(() => resolveActivationPtyListScope({}, worktreeId)).toThrow('provider unavailable')
    expect(() =>
      resolveActivationPtyListScope(
        {
          repos: [
            { id: 'repo', executionHostId: 'local' },
            { id: 'repo', executionHostId: 'ssh:box' }
          ]
        },
        worktreeId
      )
    ).toThrow('provider unavailable')
  })

  it('never routes a paired host or its nested SSH target through client providers', () => {
    for (const hostId of ['runtime:hub', 'ssh:nested'] as const) {
      expect(() =>
        resolveActivationPtyListScope(
          {
            worktreesByRepo: {
              repo: [{ id: worktreeId, repoId: 'repo', hostId, runtimeOwnerEnvironmentId: 'hub' }]
            }
          },
          worktreeId
        )
      ).toThrow('provider unavailable')
    }
  })
})
