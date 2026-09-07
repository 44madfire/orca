import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
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

// A retained orchestration worker's pane re-attaches renderer-only after an app restart, so the
// daemon adapter's `hasPty` cache never learns the session. The renderer's visibility reconciler
// closes a pane on exactly the `false` that cache miss used to produce, even though the daemon
// still runs the process (Slack thread "disappearing orchestrator-worker tabs", #16904 regression).
describe('pty:hasPty on a daemon-adapter cache miss', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  it('asks the provider readback before answering absent', async () => {
    const probePtyLiveness = vi.fn(async (id: string) => id === 'retained-worker-pty')
    installDaemonTestProvider({ hasPty: () => false, probePtyLiveness })
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'retained-worker-pty' })).resolves.toBe(
      true
    )
    expect(probePtyLiveness).toHaveBeenCalledWith('retained-worker-pty')
  })

  it('keeps the readback verdict when the daemon really has no such session', async () => {
    installDaemonTestProvider({
      hasPty: () => false,
      probePtyLiveness: vi.fn(async () => false)
    })
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'reaped-pty' })).resolves.toBe(false)
  })

  it('answers unverifiable when the readback cannot reach the daemon', async () => {
    installDaemonTestProvider({
      hasPty: () => false,
      probePtyLiveness: vi.fn(async () => null)
    })
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'unreachable-pty' })).resolves.toBe(null)
  })

  it('does not spend a readback on a cache hit', async () => {
    const probePtyLiveness = vi.fn(async () => false)
    installDaemonTestProvider({ hasPty: (id: string) => id === 'attached-pty', probePtyLiveness })
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'attached-pty' })).resolves.toBe(true)
    expect(probePtyLiveness).not.toHaveBeenCalled()
  })

  it('keeps the sole in-process provider authoritative when it has no readback', async () => {
    // The in-process LocalPtyProvider is its own only owner (#12393): its cache IS the process table.
    installDaemonTestProvider({ hasPty: () => false })
    registerPtyHandlers(mainWindow as never)

    await expect(handlers.get('pty:hasPty')!(null, { id: 'never-spawned-pty' })).resolves.toBe(
      false
    )
  })
})
