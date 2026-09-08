import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'

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

describe('paired ensure resumes are admitted against the persisted source', () => {
  const { mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  it('refuses a new-pane resume before provider spawn or publication with the source intact', async () => {
    const worktreeId = 'folder:ensure-source'
    const paneKey = makePaneKey('tab-source', '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b')
    const record = {
      paneKey,
      worktreeId,
      agent: 'claude',
      providerSession: { key: 'session_id' as const, id: 'fenced-ensure-session' },
      automaticResumeBlockedBy: 'legacy-orchestration-worker'
    }
    const session = {
      tabsByWorktree: {},
      sleepingAgentSessionsByPaneKey: { [paneKey]: record }
    }
    const store = {
      getWorkspaceSession: vi.fn(() => session),
      getSettings: () => ({ agentCmdOverrides: {}, agentDefaultArgs: {}, agentDefaultEnv: {} }),
      setWorkspaceSession: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    }
    const providerSpawn = installDaemonTestProvider()
    const runtime = new OrcaRuntimeService(store as never)
    Object.assign(runtime, {
      resolveTerminalWorkspaceLaunchScope: vi.fn(async () => ({
        id: worktreeId,
        path: '/folder',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })),
      executionOwnerSupportsAgentSessionOperation: vi.fn(async () => true),
      markWorkspaceTrustedForAgent: vi.fn(async () => {})
    })
    registerPtyHandlers(
      mainWindow as never,
      runtime,
      undefined,
      undefined,
      undefined,
      store as never
    )
    const registerPty = vi.spyOn(runtime, 'registerPty')
    const result = await runtime.ensureAgentSession({
      worktree: `id:${worktreeId}`,
      kind: 'explicit',
      agent: 'claude',
      providerSession: record.providerSession,
      presentation: 'background'
    })
    expect(result).toMatchObject({ terminal: { reattachUnverifiable: true } })
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(registerPty).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(store.persistPtyBinding).not.toHaveBeenCalled()
    expect(session.sleepingAgentSessionsByPaneKey[paneKey]).toBe(record)
    expect(session.tabsByWorktree).toEqual({})
  })
})
