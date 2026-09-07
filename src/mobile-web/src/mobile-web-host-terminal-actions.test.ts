import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindMobileWebHostTerminalActions } from './mobile-web-host-terminal-actions'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const methods = ['mobileWeb.terminal.bind', 'mobileWeb.terminal.action']
function fixture() {
  const request = vi.fn(async (_capability, operation, payload) => {
    if (operation === 'hostCatalog') {
      return { grants: methods.map((method) => ({ method })) }
    }
    return payload.method === methods[0]
      ? { resourceId: 'resource-terminal' }
      : { applied: true, future: 1 }
  })
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  const signal = new AbortController().signal
  return { requests, request, signal }
}
afterEach(() => vi.useRealTimers())
describe('page-owned terminal metadata forwarding', () => {
  it('uses one bound resource for all metadata actions, keeping stream ids out of host payloads', async () => {
    const f = fixture()
    const run = await bindMobileWebHostTerminalActions(f.requests, 'workspace', 'tab', f.signal)
    for (const request of [
      {
        operation: 'displayMode' as const,
        mode: 'auto' as const,
        viewport: { cols: 90, rows: 30 }
      },
      { operation: 'rename' as const, title: 'Build' },
      { operation: 'clear' as const }
    ]) {
      await expect(run!(request)).resolves.toBeNull()
    }
    expect(f.request.mock.calls.map((call) => call[2])).toEqual([
      { methods },
      { method: methods[0], workspaceId: 'workspace', params: { tabId: 'tab' } },
      ...[
        {
          method: 'terminal.setDisplayMode',
          fields: { mode: 'auto', viewport: { cols: 90, rows: 30 } }
        },
        { method: 'terminal.rename', fields: { title: 'Build' } },
        { method: 'terminal.clearBuffer', fields: {} }
      ].map((params) => ({
        method: methods[1],
        workspaceId: 'workspace',
        params: { resourceId: 'resource-terminal', ...params, timeoutMs: 15_000 }
      }))
    ])
    expect(
      f.request.mock.calls
        .filter((call) => call[1] !== 'hostCatalog')
        .every(
          (call) =>
            (call as unknown[]).at(-1) &&
            ((call as unknown[]).at(-1) as { signal: AbortSignal }).signal === f.signal
        )
    ).toBe(true)
  })
  it.each(['timeout', 'unsupported_capability', 'host_error'] as const)(
    'does not retry after action returns %s',
    async (code) => {
      const f = fixture()
      const run = await bindMobileWebHostTerminalActions(f.requests, 'w', 't', f.signal)
      f.request.mockRejectedValueOnce(new MobileWebBridgeClientError(code, true))
      await expect(run!({ operation: 'clear' })).rejects.toMatchObject({ code })
      expect(f.request).toHaveBeenCalledTimes(3)
    }
  )
  it('spends one binding budget across catalog and host lookup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.request.mockImplementationOnce(async () => {
      vi.setSystemTime(4_000)
      return { grants: methods.map((method) => ({ method })) } as never
    })
    await bindMobileWebHostTerminalActions(f.requests, 'w', 't', f.signal)
    expect(
      f.request.mock.calls.map(
        (call) => ((call as unknown[]).at(-1) as { timeoutMs: number }).timeoutMs
      )
    ).toEqual([15_000, 12_000])
  })
})
