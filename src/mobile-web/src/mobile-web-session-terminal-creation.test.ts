import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebSessionRequestClient } from './mobile-web-session-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

function fixture(dispatch = true) {
  const request = vi.fn(async (capability, operation, payload) => {
    if (capability === 'session') {
      return { workspaceId: 'workspace', tabId: 'legacy', created: true }
    }
    if (operation === 'hostCatalog') {
      return { grants: payload.methods.map((method: string) => ({ method })) }
    }
    return payload.method.endsWith('agentOptions')
      ? { agents: ['codex', 'future-agent'] }
      : { tabId: 'tab', created: true }
  })
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  return { request, client: new MobileWebSessionRequestClient(requests, dispatch) }
}
afterEach(() => vi.useRealTimers())
describe('host session terminal creation page integration', () => {
  it('reads future host agent names without installed-shell enum filtering', async () => {
    const f = fixture()
    expect(await f.client.agentOptions({ workspaceId: 'workspace' })).toEqual({
      agents: ['codex', 'future-agent']
    })
  })
  it.each([false, true])(
    'creates blank/agent terminal (agent=%s) over generic authority',
    async (agent) => {
      const f = fixture()
      expect(
        await (agent
          ? f.client.createAgent({ workspaceId: 'workspace', agent: 'codex' })
          : f.client.create({ workspaceId: 'workspace' }))
      ).toEqual({ workspaceId: 'workspace', tabId: 'tab', created: true })
      expect(f.request.mock.calls[1][2]).toEqual({
        method: 'mobileWeb.session.createTerminal',
        workspaceId: 'workspace',
        params: {
          ...(agent ? { agent: 'codex' } : {}),
          clientMutationId: expect.any(String),
          timeoutMs: expect.any(Number)
        }
      })
    }
  )
  it('uses old-shell creation without probing when dispatch fencing is unavailable', async () => {
    const f = fixture(false)
    expect((await f.client.create({ workspaceId: 'workspace' })).tabId).toBe('legacy')
    expect(f.request.mock.calls.map((call) => call[1])).toEqual(['create'])
  })
  it('falls back for an older host before creation dispatch', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce({ grants: [] })
    expect((await f.client.create({ workspaceId: 'workspace' })).tabId).toBe('legacy')
    expect(f.request.mock.calls.map((call) => call[1])).toEqual(['hostCatalog', 'create'])
  })
  it.each(['timeout', 'unsupported_capability'] as const)(
    'does not retry creation after %s',
    async (code) => {
      const f = fixture()
      f.request
        .mockImplementationOnce(async (_cap, _op, payload) => ({
          grants: payload.methods.map((method: string) => ({ method }))
        }))
        .mockRejectedValueOnce(new MobileWebBridgeClientError(code, false))
      await expect(f.client.create({ workspaceId: 'workspace' })).rejects.toMatchObject({ code })
      expect(f.request.mock.calls.map((call) => call[1])).toEqual(['hostCatalog', 'hostRequest'])
    }
  )
  it('shares one deadline across catalog and creation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.request.mockImplementationOnce(async (_cap, _op, payload) => {
      vi.setSystemTime(4_000)
      return { grants: payload.methods.map((method: string) => ({ method })) }
    })
    await f.client.create({ workspaceId: 'workspace' })
    expect(f.request.mock.calls[1][2].params.timeoutMs).toBe(12_000)
  })
})
