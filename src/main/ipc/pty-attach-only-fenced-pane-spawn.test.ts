import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// A settled orchestration worker's pane is fenced from resuming its provider session, so its
// restored reattach rides `attachOnly`. Main must attach the session it already owns, and on a
// proven absence it must refuse to mint a replacement rather than cold-restoring the agent.
describe('pty:spawn under a caller-requested attachOnly fence', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  function buildFencedPaneContext(name: string) {
    const worktreeId = `repo-1::/tmp/${name}`
    const tabId = `tab-${name}`
    const leafId = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b'
    const ptyId = `pty-${name}`
    const paneKey = makePaneKey(tabId, leafId)
    let session = {
      tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId }] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: ptyId }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: `inc-${name}` }
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next: typeof session) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => `term-${name}`),
      preAllocateHandleForPty: vi.fn(() => `term-${name}`),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    const spawnArgs = {
      cols: 80,
      rows: 24,
      cwd: `/tmp/${name}`,
      worktreeId,
      tabId,
      leafId,
      sessionId: ptyId,
      attachOnly: true,
      env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId }
    }
    return { ptyId, store, runtime, spawnArgs }
  }

  it('attaches the restored session so main owns it, without a fresh spawn', async () => {
    const { ptyId, store, runtime, spawnArgs } = buildFencedPaneContext('fenced-live-worker')
    const providerSpawn = installDaemonTestProvider({
      spawn: vi.fn(async (options: { attachOnly?: boolean; sessionId?: string }) => {
        if (!options.attachOnly) {
          throw new Error('a fenced pane must never reach a fresh spawn')
        }
        return { id: options.sessionId!, incarnationId: 'inc-fenced-live-worker', isReattach: true }
      })
    })
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).resolves.toMatchObject({ id: ptyId })
    expect(providerSpawn.mock.calls.every(([options]) => options.attachOnly === true)).toBe(true)
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
  })

  it('refuses to mint a replacement session when the owner proves the session absent', async () => {
    const { store, runtime, spawnArgs } = buildFencedPaneContext('fenced-absent-worker')
    const providerSpawn = installDaemonTestProvider({
      spawn: vi.fn(async (options: { attachOnly?: boolean; sessionId?: string }) => {
        if (options.attachOnly) {
          throw new SessionNotFoundError(options.sessionId ?? '')
        }
        return { id: 'pty-replacement', incarnationId: 'inc-replacement' }
      })
    })
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )

    // The rejection carries the owner's own wording, which is what the renderer classifies as a
    // proven absence — the one answer that licenses treating the pane as exited.
    await expect(handlers.get('pty:spawn')!(null, spawnArgs)).rejects.toThrow(/Session not found: /)
    expect(providerSpawn.mock.calls.every(([options]) => options.attachOnly === true)).toBe(true)
  })

  it('ignores the flag without a session to attach, so a fresh tab still spawns', async () => {
    const { store, runtime, spawnArgs } = buildFencedPaneContext('fenced-no-session')
    const providerSpawn = installDaemonTestProvider()
    registerPtyHandlers(
      mainWindow as never,
      runtime as never,
      undefined,
      undefined,
      undefined,
      store as never
    )

    await handlers.get('pty:spawn')!(null, {
      ...spawnArgs,
      sessionId: undefined,
      tabId: 'tab-unbound',
      leafId: '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c'
    })

    expect(providerSpawn.mock.calls.at(-1)?.[0]).not.toMatchObject({ attachOnly: true })
  })
})
