import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { assertPairedBrowserFileUrlAllowed } from './browser-file-url-confinement'

let root: string
let outside: string
let worktree: { id: string; path: string }

// Real directories, because the check resolves both sides with realpath.
beforeAll(async () => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'orca-file-url-')))
  root = path.join(base, 'workspace')
  outside = path.join(base, 'outside')
  await mkdir(path.join(root, 'build'), { recursive: true })
  await mkdir(path.join(base, 'workspace-secrets'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(path.join(root, 'build', 'report.html'), '<h1>artifact</h1>')
  await writeFile(path.join(outside, 'id_rsa'), 'secret')
  await writeFile(path.join(base, 'workspace-secrets', 'env'), 'secret')
  await symlink(path.join(outside, 'id_rsa'), path.join(root, 'escape-link'))
  await symlink(path.join(outside, 'missing'), path.join(root, 'dangling-link'))
  worktree = { id: 'wt-1', path: root }
})

function assertAllowed(url: string, target = worktree): Promise<void> {
  return assertPairedBrowserFileUrlAllowed({ url, pairedCaller: true, worktree: target })
}

describe('paired browser file: confinement', () => {
  it('allows a file inside the workspace root, the native HTML-artifact open', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString())
    ).resolves.toBeUndefined()
  })

  it('refuses a path outside the workspace root', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(outside, 'id_rsa')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a sibling directory that shares the root prefix', async () => {
    await expect(assertAllowed(`${pathToFileURL(root).toString()}-secrets/env`)).rejects.toThrow(
      /outside the requested workspace/
    )
  })

  it('refuses a traversal escape that percent-encodes its separators', async () => {
    await expect(
      assertAllowed(`${pathToFileURL(root).toString()}/%2e%2e/outside/id_rsa`)
    ).rejects.toThrow(/outside the requested workspace/)
  })

  // Why: the containment check is lexical, so a link inside the root reads as inside it.
  it('refuses a symlink inside the root that points outside it', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'escape-link')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a dangling symlink inside the root', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'dangling-link')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a file that does not exist', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'absent.html')).toString())
    ).rejects.toThrow(/outside the requested workspace/)
  })

  it('refuses a file: create with no workspace to confine it to', async () => {
    await expect(
      assertPairedBrowserFileUrlAllowed({
        url: 'file:///etc/passwd',
        pairedCaller: true,
        worktree: undefined
      })
    ).rejects.toThrow(/requires an explicit workspace/)
  })

  it('refuses a remote workspace, whose path names another machine', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString(), {
        ...worktree,
        hostId: 'ssh:box'
      } as typeof worktree)
    ).rejects.toThrow(/remote workspace/)
  })

  it('allows a folder workspace on the local host', async () => {
    await expect(
      assertAllowed(pathToFileURL(path.join(root, 'build', 'report.html')).toString(), {
        id: 'folder-1',
        path: root,
        hostId: 'local'
      } as typeof worktree)
    ).resolves.toBeUndefined()
  })

  it('leaves http(s) and local callers alone', async () => {
    await expect(
      assertPairedBrowserFileUrlAllowed({
        url: 'https://example.com',
        pairedCaller: true,
        worktree: undefined
      })
    ).resolves.toBeUndefined()
    await expect(
      assertPairedBrowserFileUrlAllowed({
        url: 'file:///etc/passwd',
        pairedCaller: false,
        worktree: undefined
      })
    ).resolves.toBeUndefined()
  })
})
