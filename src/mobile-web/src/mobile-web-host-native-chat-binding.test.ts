import { afterEach, expect, it, vi } from 'vitest'
import { bindMobileWebHostNativeChat } from './mobile-web-host-native-chat-binding'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

afterEach(() => vi.useRealTimers())
it('spends one timeout across the catalog read and resource binding', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const request = vi.fn().mockImplementation(async (_capability, operation) => {
    if (operation === 'hostCatalog') {
      vi.setSystemTime(4_000)
      return {
        grants: [{ method: 'mobileWeb.nativeChat.bind' }, { method: 'mobileWeb.nativeChat.mutate' }]
      }
    }
    return { resourceId: 'resource' }
  })
  const requests = { supports: () => true, request } as unknown as MobileWebOneShotRequestClient
  await expect(
    bindMobileWebHostNativeChat(requests, 'workspace', 'tab', 'mobileWeb.nativeChat.mutate', {
      timeoutMs: 5_000
    })
  ).resolves.toBe('resource')
  expect(request.mock.calls.map((args) => args.at(-1).timeoutMs)).toEqual([5_000, 2_000])
})
