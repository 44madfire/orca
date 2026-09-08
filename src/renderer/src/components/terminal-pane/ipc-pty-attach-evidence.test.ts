import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

describe('IPC attach evidence', () => {
  const originalWindow = globalThis.window
  beforeEach(() => {
    vi.resetModules()
    installIpcPtyWindow(originalWindow, {})
  })
  afterEach(() => restorePtySpecWindow(originalWindow))

  it.each(['exitedBeforeAttach', 'reattachUnverifiable'] as const)(
    'preserves main %s without publishing a successful spawn or attach',
    async (evidence) => {
      const { createIpcPtyTransport } = await import('./pty-transport')
      const id = 'ssh:ssh-1@@old-epoch-pty'
      const outcome = { id, [evidence]: true }
      vi.mocked(window.api.pty.spawn).mockResolvedValueOnce(outcome)
      const onPtySpawn = vi.fn()
      const onConnect = vi.fn()
      const transport = createIpcPtyTransport({ connectionId: 'ssh-1', onPtySpawn })
      expect(await transport.connect({ url: '', sessionId: id, callbacks: { onConnect } })).toEqual(
        outcome
      )
      expect(onPtySpawn).not.toHaveBeenCalled()
      expect(onConnect).not.toHaveBeenCalled()
      expect(transport.getPtyId()).toBeNull()
      transport.destroy?.()
      expect(window.api.pty.kill).not.toHaveBeenCalled()
    }
  )

  it.each([
    'SSH_SESSION_EXPIRED: old-epoch-pty',
    'Session not found: old-epoch-pty',
    'SSH relay connection unavailable'
  ])('does not reconstruct observed exit from %s', async (message) => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    vi.mocked(window.api.pty.spawn).mockRejectedValueOnce(new Error(message))
    const transport = createIpcPtyTransport({ connectionId: 'ssh-1' })
    const result = await transport.connect({
      url: '',
      sessionId: 'ssh:ssh-1@@old-epoch-pty',
      callbacks: {}
    })
    expect(result && typeof result === 'object' && result.exitedBeforeAttach).toBeFalsy()
    transport.destroy?.()
  })
})
