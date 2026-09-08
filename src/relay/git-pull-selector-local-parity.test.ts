import { expect, it, vi } from 'vitest'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../main/git/runner', () => ({ gitExecFileAsync: run }))
vi.mock('../main/git/status', () => ({
  runWithGitReadCacheInvalidation: (fn: () => unknown) => fn()
}))
vi.mock('../main/git/local-repo-ref-maintenance', () => ({
  postponeRepoRefMaintenance: () => {},
  withRepoRefMaintenancePaused: (_key: string, fn: () => unknown) => fn()
}))
import { gitPull } from '../main/git/remote'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import { createMockDispatcher, type RelayDispatcher } from './git-handler-test-setup'

it('keeps the literal pull selector separate from its matching status tracking ref on both hosts', async () => {
  const url = 'https://github.com/canonical/repo.git'
  const calls: string[][] = []
  const script = async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'symbolic-ref') {
      return { stdout: 'feature', stderr: '' }
    }
    if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
      throw new Error("fatal: no upstream configured for branch 'feature'")
    }
    if (args[0] === 'config') {
      const values: Record<string, string> = {
        'branch.feature.remote': url,
        'branch.feature.merge': 'refs/heads/feature'
      }
      if (!(args[2] in values)) {
        throw new Error('missing config')
      }
      return { stdout: values[args[2]], stderr: '' }
    }
    if (args[0] === 'remote') {
      return {
        stdout: `origin\t${url} (fetch)\norigin\thttps://github.com/contributor/repo.git (push)`,
        stderr: ''
      }
    }
    return { stdout: '', stderr: '' }
  }
  run.mockImplementation(script)
  await gitPull('/repo')
  expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', url, 'feature'])
  expect(calls.some((args) => args.includes('refs/remotes/origin/feature'))).toBe(true)
  calls.length = 0
  const dispatcher = createMockDispatcher()
  const handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  vi.spyOn(handler as unknown as { git: typeof script }, 'git').mockImplementation(script)
  await dispatcher.callRequest('git.pull', { worktreePath: '/repo' })
  expect(calls.find((args) => args[0] === 'pull')).toEqual(['pull', url, 'feature'])
})
