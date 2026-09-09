import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { nativeHostSessionTabOperations } from './native-host-session-tab-operations'

describe('native host session tab operations', () => {
  it('maps the two named lifecycle operations to the caller-local RPCs', async () => {
    const sendRequest = vi
      .fn<RpcClient['sendRequest']>()
      .mockResolvedValueOnce({ ok: true, result: { browserPageId: 'browser-1' } })
      .mockResolvedValueOnce({ ok: true, result: { closed: true } })
    const operations = nativeHostSessionTabOperations({
      sendRequest
    } as unknown as RpcClient)

    await expect(operations.createBrowser('workspace-1', 'https://example.com')).resolves.toEqual({
      browserPageId: 'browser-1'
    })
    await expect(operations.close('workspace-1', 'tab-1')).resolves.toEqual({
      outcome: 'closed'
    })

    expect(sendRequest.mock.calls).toEqual([
      [
        'browser.tabCreate',
        {
          worktree: 'id:workspace-1',
          url: 'https://example.com',
          activate: true
        },
        // The caller carried this budget before the seam existed; a browser create that parks on
        // reconnect leaves the composer spinning with no error.
        { timeoutMs: 30_000 }
      ],
      ['session.tabs.close', { worktree: 'id:workspace-1', tabId: 'tab-1', reason: 'user' }]
    ])
  })

  it('treats a create that answers without a page id as a create, not a failure', async () => {
    const operations = nativeHostSessionTabOperations({
      sendRequest: vi.fn().mockResolvedValue({ ok: true, result: {} })
    } as unknown as RpcClient)

    await expect(operations.createBrowser('workspace-1', 'https://example.com')).resolves.toEqual(
      {}
    )
  })

  it('reports the host message when a browser create is refused', async () => {
    const operations = nativeHostSessionTabOperations({
      sendRequest: vi
        .fn()
        .mockResolvedValue({ ok: false, error: { code: 'busy', message: 'Browser busy' } })
    } as unknown as RpcClient)

    await expect(operations.createBrowser('workspace-1', 'https://example.com')).rejects.toThrow(
      'Browser busy'
    )
  })

  it('keeps refused closes visible to the shared screen', async () => {
    const operations = nativeHostSessionTabOperations({
      sendRequest: vi.fn().mockResolvedValue({
        ok: true,
        result: { closed: true, refused: true, refusalReason: 'live-host-pty' }
      })
    } as unknown as RpcClient)

    await expect(operations.close('workspace-1', 'tab-1')).resolves.toEqual({
      outcome: 'refused',
      reason: 'live-host-pty'
    })
  })
})
