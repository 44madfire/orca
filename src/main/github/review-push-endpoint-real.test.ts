import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { gitExecFileAsync as realGit } from '../git/command-runner/git-exec-file'
import { getPublishTargetStatus } from '../../shared/git-publish-target-status'
import { hasUsableHostedReviewPushTarget } from '../../shared/hosted-review-push-target-admission'
import { resolveRelayPushTarget } from '../../relay/git-handler-push-target'

const state = vi.hoisted(() => ({
  root: '',
  endpoint: '',
  env: {} as NodeJS.ProcessEnv,
  pushes: [] as string[]
}))
vi.mock('./gh-utils', () => ({
  acquire: async () => {},
  release: () => {},
  githubRepoContext: () => ({}),
  ghRepoExecOptions: () => ({}),
  getRemoteUrlForRepo: async () => state.endpoint,
  gitExecFileAsync: (args: string[]) =>
    realGit(args, { cwd: state.root, env: state.env, timeout: 10_000 }),
  ghExecFileAsync: async () => ({
    stdout: JSON.stringify({
      head: {
        ref: 'feature',
        repo: {
          name: 'repo',
          owner: { login: 'team' },
          clone_url: state.endpoint,
          ssh_url: state.endpoint
        }
      }
    })
  })
}))
vi.mock('./github-api-repository', () => ({
  getGitHubApiRepositoryForRemote: async () => ({ host: '127.0.0.1', owner: 'team', repo: 'repo' }),
  githubHostExecOptions: () => ({})
}))
vi.mock('./client/pull-request-lookup-candidates', () => ({
  resolvePullRequestLookupCandidates: async () => [
    { host: '127.0.0.1', owner: 'team', repo: 'repo' }
  ]
}))
vi.mock('./client', async () => ({
  getPullRequestPushTarget: (await import('./client/lookup/pull-request-push-target'))
    .getPullRequestPushTarget,
  getWorkItem: async () => ({ type: 'pr', branchName: 'feature' })
}))
vi.mock('../git/runner', () => ({
  gitExecFileAsync: async (args: string[]) => {
    const result = await realGit(
      args[0] === 'push' ? ['push', '--dry-run', '--porcelain', ...args.slice(1)] : args,
      { cwd: state.root, env: state.env, timeout: 10_000 }
    )
    if (args[0] === 'push') {
      state.pushes.push(result.stdout)
    }
    return result
  }
}))
import { getPullRequestPushTarget } from './client/lookup/pull-request-push-target'
import { resolveGitHubPrStartPoint } from './pr-start-point'
import { gitPush } from '../git/remote'

let root: string
let daemon: ReturnType<typeof spawnProcess>
let other: string
const run = (args: string[]) => realGit(args, { cwd: root, env: state.env, timeout: 10_000 })
const git = async (...args: string[]) => (await run(args)).stdout.trim()
const refs = () =>
  Promise.all(
    [root, join(root, 'team/repo.git'), join(root, 'other/repo.git')].map(
      async (cwd) =>
        (
          await realGit(['for-each-ref', '--format=%(refname) %(objectname)'], {
            cwd,
            env: state.env
          })
        ).stdout
    )
  )

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-push-authority-'))
  state.root = root
  state.env = {
    ...process.env,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(root, 'empty-config'),
    ORCA_BACKGROUND_LAUNCH: '1'
  }
  await git('init', '-q')
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgSign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'base'
  )
  await git('branch', '-M', 'feature')
  for (const path of ['team/repo.git', 'other/repo.git']) {
    await git('clone', '--bare', '-q', root, join(root, path))
  }
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  daemon = spawnProcess({
    program: 'git',
    args: [
      'daemon',
      '--verbose',
      '--export-all',
      '--enable=receive-pack',
      '--listen=127.0.0.1',
      `--port=${port}`,
      `--base-path=${root}`,
      root
    ],
    cwd: root,
    env: state.env
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Git daemon startup timed out')), 10_000)
    daemon.once('error', reject)
    daemon.stderr.on('data', (chunk) => {
      if (String(chunk).includes('Ready to rumble')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  state.endpoint = `git://127.0.0.1:${port}/team/repo.git`
  other = `git://127.0.0.1:${port}/other/repo.git`
  await git('remote', 'add', 'origin', state.endpoint)
  await git('fetch', '-q', 'origin')
})
afterAll(async () => {
  if (daemon) {
    expect(daemon.spawnargs).toContain(root)
    const closed = once(daemon, 'close')
    daemon.kill('SIGTERM')
    await closed
  }
  await rm(root, { recursive: true, force: true })
})

it('carries shipping hydrated identity through status, admission, local and relay execution', async () => {
  const resolved = await resolveGitHubPrStartPoint({
    repoPath: root,
    prNumber: 42,
    gitExec: run,
    resolveRemote: async () => 'origin',
    fetchRemoteTrackingRef: async () => {
      await git('fetch', '-q', 'origin')
    },
    fetchPullRequestHeadRef: async () => {
      throw new Error('unexpected fork fetch')
    }
  })
  expect(resolved).not.toHaveProperty('error')
  if ('error' in resolved || !resolved.pushTarget) {
    throw new Error('Missing hydrated target')
  }
  const target = resolved.pushTarget
  const status = await getPublishTargetStatus(run, target)
  expect(
    hasUsableHostedReviewPushTarget({
      pushTarget: target,
      upstreamStatus: status,
      hasResolvableHostedReviewPushTargetLink: true
    })
  ).toBe(true)
  const before = await refs()
  const config = await readFile(join(root, '.git/config'))
  await gitPush(root, false, target)
  expect(state.pushes.at(-1)).toContain(state.endpoint)
  const relay = await resolveRelayPushTarget((args) => run(args), root, target)
  await git('push', '--dry-run', '--porcelain', relay!.remote, relay!.refspec)
  expect(await refs()).toEqual(before)
  expect(await readFile(join(root, '.git/config'))).toEqual(config)

  for (const urls of [[other], [state.endpoint, other]]) {
    await git('config', '--replace-all', 'remote.origin.pushurl', urls[0]!)
    if (urls[1]) {
      await git('config', '--add', 'remote.origin.pushurl', urls[1])
    }
    const configBefore = await readFile(join(root, '.git/config'))
    expect(await getPullRequestPushTarget(root, 42)).toBeNull()
    const denied = await getPublishTargetStatus(run, target)
    expect(
      hasUsableHostedReviewPushTarget({
        pushTarget: target,
        upstreamStatus: denied,
        hasResolvableHostedReviewPushTargetLink: true
      })
    ).toBe(false)
    await expect(gitPush(root, false, target)).rejects.toThrow('authority')
    await expect(resolveRelayPushTarget((args) => run(args), root, target)).rejects.toThrow(
      'authority'
    )
    const control = await git(
      'push',
      '--dry-run',
      '--porcelain',
      'origin',
      'HEAD:refs/heads/feature'
    )
    for (const url of urls) {
      expect(control).toContain(url)
    }
    expect(await refs()).toEqual(before)
    expect(await readFile(join(root, '.git/config'))).toEqual(configBefore)
  }
})

it('uses Git rewrite and pushurl selection rules without changing configuration during execution', async () => {
  await git('config', '--unset-all', 'remote.origin.pushurl')
  await git('remote', 'set-url', 'origin', 'fixture:review')
  await git('config', `url.${state.endpoint}.insteadOf`, 'fixture:review')
  const before = await refs()
  const verify = async (accepted: boolean, destinations: string[]): Promise<void> => {
    const config = await readFile(join(root, '.git/config'))
    const resolved = await getPullRequestPushTarget(root, 42)
    expect(!!resolved?.pushTarget).toBe(accepted)
    if (resolved?.pushTarget) {
      await gitPush(root, false, resolved.pushTarget)
    }
    const dryRun = await git(
      'push',
      '--dry-run',
      '--porcelain',
      'origin',
      'HEAD:refs/heads/feature'
    )
    for (const destination of destinations) {
      expect(dryRun).toContain(destination)
    }
    expect(await refs()).toEqual(before)
    expect(await readFile(join(root, '.git/config'))).toEqual(config)
  }
  await verify(true, [state.endpoint])
  await git('config', `url.${other}.pushInsteadOf`, 'fixture:review')
  await verify(false, [other])
  await git('config', 'remote.origin.pushurl', state.endpoint)
  await verify(true, [state.endpoint])
  await git('config', '--unset-all', 'remote.origin.pushurl')
  await git('config', '--unset-all', `url.${other}.pushInsteadOf`)
  await git('remote', 'set-url', 'origin', state.endpoint)
  await git('config', '--add', 'remote.origin.url', other)
  await verify(false, [state.endpoint, other])
})
