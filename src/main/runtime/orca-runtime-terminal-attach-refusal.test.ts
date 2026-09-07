import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn()
  },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function stubLaunchScope(runtime: OrcaRuntimeService, path = '/repo/app'): void {
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
      id: string
      path: string
      connectionId: string | null
      repo: null
      folderWorkspace: null
    }>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'wt-1',
    path,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
}

describe('paired terminal create attach refusal', () => {
  it.each(['exitedBeforeAttach', 'reattachUnverifiable'] as const)(
    'returns %s before registering a terminal',
    async (outcome) => {
      const runtime = new OrcaRuntimeService()
      stubLaunchScope(runtime)
      const spawn = vi.fn().mockResolvedValue({ id: 'retained-pty', [outcome]: true })
      const registerPty = vi.spyOn(runtime, 'registerPty')
      const committed = vi.fn()
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const result = await runtime.createTerminal('id:wt-1', {
        onPtySpawnCommitted: committed
      })
      expect(result).toMatchObject({ ptyId: 'retained-pty', [outcome]: true })
      expect(registerPty).not.toHaveBeenCalled()
      expect(committed).not.toHaveBeenCalled()
    }
  )

  it.each(['exitedBeforeAttach', 'reattachUnverifiable'] as const)(
    'returns adopted %s before requesting a spawn',
    async (outcome) => {
      const runtime = new OrcaRuntimeService()
      stubLaunchScope(runtime)
      const spawn = vi.fn().mockResolvedValue({ id: 'wrong-pty' })
      const registerPty = vi.spyOn(runtime, 'registerPty')
      runtime.setPtyController({
        spawn,
        adoptStablePane: vi.fn().mockResolvedValue({
          result: { id: 'retained-pty', [outcome]: true },
          owner: {
            handle: 'retained-handle',
            tabId: 'tab-1',
            leafId: 'pane:1',
            ptyId: 'retained-pty'
          }
        }),
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const result = await runtime.createTerminal('id:wt-1')
      expect(result).toMatchObject({
        handle: 'retained-handle',
        ptyId: 'retained-pty',
        [outcome]: true
      })
      expect(spawn).not.toHaveBeenCalled()
      expect(registerPty).not.toHaveBeenCalled()
    }
  )
})
