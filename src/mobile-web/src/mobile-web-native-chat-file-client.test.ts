import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileWebNativeChatFileClient } from './mobile-web-native-chat-file-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

const payload = { workspaceId: 'workspace', sessionId: `native_chat_0_${'01'.repeat(16)}` }
const methods = ['bind', 'fileSearch', 'openFile', 'readability'].map(
  (method) => `mobileWeb.nativeChat.${method}`
)
function fixture() {
  const request = vi.fn(async (capability, operation, value) => {
    if (capability === 'nativeChat') {
      return operation === 'fileSearch'
        ? { paths: ['legacy.ts'] }
        : operation === 'readability'
          ? { readable: false }
          : null
    }
    if (operation === 'hostCatalog') {
      return { grants: methods.map((method) => ({ method })) }
    }
    if (value.method.endsWith('.bind')) {
      return { resourceId: 'resource-chat' }
    }
    if (value.method.endsWith('.fileSearch')) {
      return {
        files: [
          { relativePath: 'src/main.ts' },
          { relativePath: '/private/file' },
          { relativePath: '../bad' }
        ],
        future: 1
      }
    }
    if (value.method.endsWith('.readability')) {
      return { readable: true, future: 1 }
    }
    return { opened: true }
  })
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  return { request, client: new MobileWebNativeChatFileClient(requests) }
}
afterEach(() => vi.useRealTimers())
describe('native-chat file generic client', () => {
  it('binds by tab and presents only valid relative search paths', async () => {
    const f = fixture()
    expect(await f.client.fileSearch({ ...payload, query: 'src' }, 'tab')).toEqual({
      paths: ['src/main.ts']
    })
    expect(f.request.mock.calls.map((call) => call[2])).toEqual([
      { methods: ['mobileWeb.nativeChat.bind', 'mobileWeb.nativeChat.fileSearch'] },
      { method: 'mobileWeb.nativeChat.bind', workspaceId: 'workspace', params: { tabId: 'tab' } },
      {
        method: 'mobileWeb.nativeChat.fileSearch',
        workspaceId: 'workspace',
        params: { resourceId: 'resource-chat', search: { query: 'src', limit: 16 } }
      }
    ])
  })
  it('queries host readability without a terminal or provider id', async () => {
    const f = fixture()
    expect(await f.client.readability({ workspaceId: 'workspace' })).toEqual({
      readable: true,
      future: 1
    })
    expect(f.request.mock.calls[0][2]).toEqual({
      method: 'mobileWeb.nativeChat.readability',
      workspaceId: 'workspace',
      params: {}
    })
  })
  it('spends one deadline across bind/catalog and the open operation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const f = fixture()
    f.request.mockImplementationOnce(async () => {
      vi.setSystemTime(4_000)
      return { grants: methods.map((method) => ({ method })) }
    })
    await expect(
      f.client.openFile({ ...payload, pathText: 'src/main.ts' }, 'tab')
    ).resolves.toBeNull()
    expect(
      f.request.mock.calls.map(
        (call) => ((call as unknown[]).at(-1) as { timeoutMs: number }).timeoutMs
      )
    ).toEqual([15_000, 12_000, 12_000])
    expect(f.request.mock.calls[2][2]).toEqual({
      method: 'mobileWeb.nativeChat.openFile',
      workspaceId: 'workspace',
      params: { resourceId: 'resource-chat', pathText: 'src/main.ts', timeoutMs: 12_000 }
    })
  })
  it.each(['timeout', 'host_error', 'unsupported_capability'] as const)(
    'never retries or falls back after the open dispatch reports %s',
    async (code) => {
      const f = fixture()
      f.request.mockImplementation(async (_capability, operation, value) => {
        if (operation === 'hostCatalog') {
          return { grants: methods.map((method) => ({ method })) }
        }
        if (value.method.endsWith('.bind')) {
          return { resourceId: 'resource-chat' }
        }
        throw new MobileWebBridgeClientError(code, true)
      })
      await expect(f.client.openFile({ ...payload, pathText: 'x' }, 'tab')).rejects.toMatchObject({
        code
      })
      expect(f.request).toHaveBeenCalledTimes(3)
      expect(f.request.mock.calls.every((call) => call[0] === 'workspace')).toBe(true)
    }
  )
})
