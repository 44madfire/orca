import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetGitOperationRemoteRoleCache } from './git-operation-remote-roles'
import {
  _resetOriginGitHubApiRepositoryCache,
  resolveGitHubApiRepositoryCandidates
} from '../github/github-api-repository'
import { _resetProjectRefCache, resolveIssueSource } from '../gitlab/gitlab-project-ref-resolution'

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim()
}

describe('operation remote roles through shipping forge consumers', () => {
  let repoPath = ''

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'orca-operation-remotes-'))
    git(repoPath, ['init'])
    git(repoPath, [
      '-c',
      'user.name=Orca Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'init'
    ])
    git(repoPath, ['switch', '-c', 'feature'])
    _resetGitOperationRemoteRoleCache()
    _resetOriginGitHubApiRepositoryCache()
    _resetProjectRefCache()
  })

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true })
  })

  it('finds a no-upstream fork branch from its matching remote-tracking tip across rename', async () => {
    git(repoPath, ['remote', 'add', 'origin', 'https://github.com/stablyai/orca.git'])
    git(repoPath, ['remote', 'add', 'fork', 'https://github.com/contributor/orca.git'])
    git(repoPath, ['update-ref', 'refs/remotes/fork/feature', 'HEAD'])

    await expect(
      resolveGitHubApiRepositoryCandidates(repoPath, null, {}, 'feature')
    ).resolves.toMatchObject({
      headRepo: { owner: 'contributor', repo: 'orca', host: 'github.com' }
    })

    git(repoPath, ['remote', 'rename', 'fork', 'personal'])
    _resetGitOperationRemoteRoleCache()
    _resetOriginGitHubApiRepositoryCache()
    await expect(
      resolveGitHubApiRepositoryCandidates(repoPath, null, {}, 'feature')
    ).resolves.toMatchObject({
      headRepo: { owner: 'contributor', repo: 'orca', host: 'github.com' }
    })
  })

  it('resolves a sole nonstandard GitLab issue source', async () => {
    git(repoPath, ['remote', 'add', 'company', 'git@gitlab.com:stablyai/orca.git'])

    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
  })

  it('does not choose between two plausible nonstandard GitLab issue sources', async () => {
    git(repoPath, ['remote', 'add', 'company', 'git@gitlab.com:stablyai/orca.git'])
    git(repoPath, ['remote', 'add', 'mirror', 'git@gitlab.com:mirror/orca.git'])

    await expect(resolveIssueSource(repoPath, 'auto', ['gitlab.com'])).resolves.toEqual({
      source: null,
      fellBack: false,
      ambiguousRemoteNames: ['company', 'mirror']
    })
  })
})
