import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Store } from './persistence'
import { testState, createStore, makeRepo } from './persistence-test-harness'
import { applyProjectHostSetupPathRelocation, relocateProjectPath } from './project-path-relocation'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

let root = ''
let oldPath = ''
let newPath = ''

/** The real Store, so the relocation is driven through the same state the app persists. */
function storeWithFolderProject(): Store {
  const store = createStore()
  store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'folder' }))
  return store
}

const rootWorkspaceId = (): string => `r1::${oldPath}`
const instanceWorkspaceId = (): string =>
  `r1::${oldPath}::workspace:11111111-1111-1111-1111-111111111111`

describe('relocateProjectPath', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-relocate-'))
    root = mkdtempSync(join(tmpdir(), 'orca-projects-'))
    oldPath = join(root, 'example-project')
    newPath = join(root, 'renamed-project')
    mkdirSync(oldPath)
    mkdirSync(newPath)
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('carries a folder project and every workspace identity to the new path', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(rootWorkspaceId(), { displayName: 'example-project' })
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft', isPinned: true })

    const result = relocateProjectPath(store, 'r1', newPath)

    expect(result.outcome).toBe('relocated')
    expect(store.getRepo('r1')?.path).toBe(newPath)
    // The instance suffix is identity, so siblings must stay distinct rather than collapse.
    expect(store.getWorktreeMeta(`r1::${newPath}`)?.displayName).toBe('example-project')
    const movedInstance = store.getWorktreeMeta(
      `r1::${newPath}::workspace:11111111-1111-1111-1111-111111111111`
    )
    expect(movedInstance?.displayName).toBe('draft')
    expect(movedInstance?.isPinned).toBe(true)
    expect(store.getWorktreeMeta(rootWorkspaceId())).toBeUndefined()
    expect(store.getWorktreeMeta(instanceWorkspaceId())).toBeUndefined()
  })

  it('keeps the session bound to the relocated workspace', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    store.setWorkspaceSession({
      tabsByWorktree: {
        [instanceWorkspaceId()]: [
          { id: 'tab-1', worktreeId: instanceWorkspaceId(), type: 'terminal', title: 'zsh' }
        ]
      },
      activeWorktreeId: instanceWorkspaceId()
    } as never)

    relocateProjectPath(store, 'r1', newPath)

    const session = store.getWorkspaceSession() as unknown as {
      tabsByWorktree?: Record<string, { worktreeId: string }[]>
      activeWorktreeId?: string
    }
    const movedId = `r1::${newPath}::workspace:11111111-1111-1111-1111-111111111111`
    expect(session.tabsByWorktree?.[movedId]?.[0]?.worktreeId).toBe(movedId)
    expect(session.tabsByWorktree?.[instanceWorkspaceId()]).toBeUndefined()
    expect(session.activeWorktreeId).toBe(movedId)
  })

  it('records the prior id so a session minted under it is not reaped', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })

    relocateProjectPath(store, 'r1', newPath)

    const moved = store.getWorktreeMeta(
      `r1::${newPath}::workspace:11111111-1111-1111-1111-111111111111`
    )
    expect(moved?.priorWorktreeIds).toContain(instanceWorkspaceId())
  })

  it('leaves a project untouched when the target directory does not exist', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })
    const missing = join(root, 'not-there')

    const result = relocateProjectPath(store, 'r1', missing)

    expect(result).toMatchObject({ outcome: 'refused' })
    // A refusal must not half-migrate: the old identity is still the live one.
    expect(store.getRepo('r1')?.path).toBe(oldPath)
    expect(store.getWorktreeMeta(instanceWorkspaceId())?.displayName).toBe('draft')
  })

  it('refuses a path another project already occupies', () => {
    const store = storeWithFolderProject()
    store.addRepo(makeRepo({ id: 'r2', path: newPath, displayName: 'Other', kind: 'folder' }))

    const result = relocateProjectPath(store, 'r1', newPath)

    expect(result).toMatchObject({ outcome: 'refused' })
    expect(store.getRepo('r1')?.path).toBe(oldPath)
  })

  it('refuses a project whose files live on another execution host', () => {
    const store = createStore()
    store.addRepo(
      makeRepo({ id: 'r1', path: oldPath, kind: 'folder', connectionId: 'ssh-target-1' })
    )

    const result = relocateProjectPath(store, 'r1', newPath)

    expect(result).toMatchObject({ outcome: 'refused' })
    expect(store.getRepo('r1')?.path).toBe(oldPath)
  })

  it('leaves worktrees outside the project directory where they are', () => {
    const store = createStore()
    store.addRepo(makeRepo({ id: 'r1', path: oldPath, kind: 'git' }))
    const siblingWorktreeId = `r1::${join(root, 'worktrees', 'feature')}`
    store.setWorktreeMeta(`r1::${oldPath}`, { displayName: 'main' })
    store.setWorktreeMeta(siblingWorktreeId, { displayName: 'feature' })

    relocateProjectPath(store, 'r1', newPath)

    // Only the checkout itself is addressed by the project path; a worktree under the base path is not.
    expect(store.getWorktreeMeta(siblingWorktreeId)?.displayName).toBe('feature')
    expect(store.getWorktreeMeta(`r1::${newPath}`)?.displayName).toBe('main')
  })

  it('reports an unchanged path without rewriting identity', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })

    const result = relocateProjectPath(store, 'r1', oldPath)

    expect(result.outcome).toBe('unchanged')
    expect(store.getWorktreeMeta(instanceWorkspaceId())?.displayName).toBe('draft')
  })
})

describe('applyProjectHostSetupPathRelocation', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-relocate-setup-'))
    root = mkdtempSync(join(tmpdir(), 'orca-projects-setup-'))
    oldPath = join(root, 'example-project')
    newPath = join(root, 'renamed-project')
    mkdirSync(oldPath)
    mkdirSync(newPath)
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  })

  it('relocates the project and hands persistence updates without a path', () => {
    const store = storeWithFolderProject()
    store.setWorktreeMeta(instanceWorkspaceId(), { displayName: 'draft' })

    const { updates, relocatedRepo } = applyProjectHostSetupPathRelocation(store, {
      setupId: 'r1',
      updates: { path: newPath, displayName: 'Renamed' }
    })

    expect(relocatedRepo?.path).toBe(newPath)
    expect(updates).toEqual({ displayName: 'Renamed' })
    // Persistence still refuses a raw path write, so the stripped update must survive it.
    expect(() => store.updateProjectHostSetup({ setupId: 'r1', updates })).not.toThrow()
    expect(store.getRepo('r1')?.displayName).toBe('Renamed')
  })

  it('passes an update with no path change straight through', () => {
    const store = storeWithFolderProject()

    const { updates, relocatedRepo } = applyProjectHostSetupPathRelocation(store, {
      setupId: 'r1',
      updates: { displayName: 'Renamed' }
    })

    expect(relocatedRepo).toBeNull()
    expect(updates).toEqual({ displayName: 'Renamed' })
  })

  it('surfaces the refusal instead of silently dropping the path', () => {
    const store = storeWithFolderProject()

    expect(() =>
      applyProjectHostSetupPathRelocation(store, {
        setupId: 'r1',
        updates: { path: join(root, 'not-there') }
      })
    ).toThrow(/No directory exists/)
  })
})
