import { describe, expect, it, vi } from 'vitest'
import { MobileWebResourceCache } from './mobile-web-resource-cache'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { executeMobileWebCapabilityRequest } from './mobile-web-capability-execution'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { mobileWebBridgeRequestMessage } from './mobile-web-bridge-roundtrip-fixture'

const randomBytes = (length: number) => new Uint8Array(length)

describe('disposable native resource mirrors', () => {
  it('holds an in-flight native operation and attachment through 600 closed-session bindings, then reclaims both', async () => {
    const workspace = new MobileWebWorkspaceAuthority(randomBytes)
    workspace.synchronize([{ workspaceId: 'host', repoId: 'repo' }])
    const workspaceId = workspace.pageWorkspaceId('host')
    const binding = {
      hostWorkspaceId: workspace.hostWorkspaceId(workspaceId),
      hostTabId: 'live',
      hostTerminalId: 'terminal',
      agent: 'codex',
      providerSessionId: 'session'
    }
    const chat = new MobileWebNativeChatAuthority(randomBytes)
    chat.bind('resource_image', { ...binding, hostTabId: 'image' })
    const image = chat.registerImage('host', 'resource_image', '/private/image')
    let finish!: (value: []) => void
    const sessionChatPendingRead = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve
        })
    )
    const pending = executeMobileWebCapabilityRequest({
      request: mobileWebBridgeRequestMessage({
        requestId: 'read',
        capability: 'nativeChat',
        operation: 'pendingRead',
        payload: { workspaceId, sessionId: 'resource_live' }
      }),
      connectedClient: () => ({ sendRequest: async () => ({ ok: true, result: binding }) }),
      getPageSessionId: async () => 'document',
      isRequestActive: () => true,
      workspaceAuthority: workspace,
      nativeChatAuthority: chat,
      browserAuthority: new MobileWebBrowserAuthority(),
      nativeAuthority: { sessionChatPendingRead }
    } as unknown as MobileWebCapabilityExecutionDependencies)
    await vi.waitFor(() => expect(sessionChatPendingRead).toHaveBeenCalledOnce())
    for (let index = 0; index < 600; index++) {
      chat.bind(`resource_${index}`, { ...binding, hostTabId: `closed-${index}` })
    }
    expect(chat.resolve('host', 'resource_live')).toEqual(binding)
    expect(chat.resolveImagePaths('host', 'resource_image', [image])).toEqual(['/private/image'])
    expect(() => chat.resolve('host', 'resource_0')).toThrow('not_found')
    expect(() => chat.resolve('other', 'resource_live')).toThrow('not_found')
    finish([])
    await expect(pending).resolves.toEqual({ deliveries: [] })
    chat.releaseImages('host', 'resource_image', [image])
    for (let index = 600; index < 1200; index++) {
      chat.bind(`resource_${index}`, { ...binding, hostTabId: `closed-${index}` })
    }
    expect(() => chat.resolve('host', 'resource_live')).toThrow('not_found')
    expect(() => chat.resolve('host', 'resource_image')).toThrow('not_found')
  })

  it('refuses all-pinned capacity and reuses only a released slot', () => {
    const cache = new MobileWebResourceCache<number>()
    const release = Array.from({ length: 512 }, (_, index) => {
      cache.set(String(index), index)
      return cache.retain(String(index))
    })
    expect(() => cache.set('overflow', 513)).toThrow('rate_limited')
    expect(cache.size).toBe(512)
    release[5]!()
    cache.set('replacement', 514)
    expect(cache.has('5')).toBe(false)
    expect(cache.get('0')).toBe(0)
    release.forEach((done) => done())
  })

  it('does not let an old generation release a new retention', () => {
    const cache = new MobileWebResourceCache<number>()
    cache.set('live', 1)
    const staleRelease = cache.retain('live')
    cache.clear()
    cache.set('live', 2)
    const release = cache.retain('live')
    staleRelease()
    staleRelease()
    for (let index = 0; index < 600; index++) {
      cache.set(String(index), index)
    }
    expect(cache.get('live')).toBe(2)
    release()
    for (let index = 600; index < 1200; index++) {
      cache.set(String(index), index)
    }
    expect(cache.has('live')).toBe(false)
  })
})
