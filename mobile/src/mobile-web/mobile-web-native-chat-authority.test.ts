import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'

function binding(overrides: Partial<Parameters<MobileWebNativeChatAuthority['bind']>[1]> = {}) {
  return {
    hostWorkspaceId: 'workspace-a',
    hostTabId: 'tab-a',
    hostTerminalId: 'terminal-a' as string | null,
    agent: 'claude',
    providerSessionId: 'provider-session-a',
    transcriptPath: '/private/transcript-a.jsonl',
    ...overrides
  }
}

describe('mobile web native chat authority', () => {
  it('keeps host transcript and terminal identities behind an opaque session handle', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length).fill(7))
    const sessionId = bind(authority, 'resource_first', binding())

    expect(sessionId).toBe('resource_first')
    expect(sessionId).not.toContain('terminal-a')
    expect(sessionId).not.toContain('provider-session-a')
    expect(sessionId).not.toContain('transcript')
    expect(authority.resolve('workspace-a', sessionId)).toEqual(binding())
    expect(() => authority.assertBinding('workspace-a', sessionId, binding())).not.toThrow()
    expect(() => authority.resolve('workspace-b', sessionId)).toThrow('not_found')
  })

  it('revokes replaced tab sessions and explicitly released handles', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const first = bind(authority, 'resource_first', binding())
    const second = bind(
      authority,
      'resource_second',
      binding({ providerSessionId: 'provider-session-b', transcriptPath: undefined })
    )

    expect(second).not.toBe(first)
    expect(() => authority.resolve('workspace-a', first)).toThrow('not_found')
    expect(authority.resolve('workspace-a', second).providerSessionId).toBe('provider-session-b')

    authority.revoke(second)

    expect(() => authority.resolve('workspace-a', second)).toThrow('not_found')
  })

  it('clears all handles on shell or client replacement', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const sessionId = bind(authority, 'resource_first', binding())

    authority.clear()

    expect(() => authority.resolve('workspace-a', sessionId)).toThrow('not_found')
    expect(() => authority.assertBinding('workspace-a', sessionId, binding())).toThrow('not_found')
  })

  it('keeps image paths opaque and scoped to one workspace session', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length).fill(9))
    const firstSession = bind(authority, 'resource_first', binding())
    const secondSession = bind(authority, 'resource_second', binding({ hostTabId: 'tab-b' }))
    const imageId = authority.registerImage('workspace-a', firstSession, '/private/image.png')

    expect(imageId).toMatch(/^native_chat_image_0_[a-f0-9]{32}$/)
    expect(imageId).not.toContain('private')
    expect(authority.resolveImagePaths('workspace-a', firstSession, [imageId])).toEqual([
      '/private/image.png'
    ])
    expect(() => authority.resolveImagePaths('workspace-a', secondSession, [imageId])).toThrow(
      'not_found'
    )
    expect(() => authority.resolveImagePaths('workspace-b', firstSession, [imageId])).toThrow(
      'not_found'
    )
  })

  it('bounds and releases session image references', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const sessionId = bind(authority, 'resource_first', binding())
    const imageIds = Array.from({ length: MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT }, (_, index) =>
      authority.registerImage('workspace-a', sessionId, `/private/image-${index}.png`)
    )

    expect(() =>
      authority.registerImage('workspace-a', sessionId, '/private/overflow.png')
    ).toThrow('rate_limited')
    authority.releaseImages('workspace-a', sessionId, [imageIds[0]!])
    expect(() => authority.resolveImagePaths('workspace-a', sessionId, [imageIds[0]!])).toThrow(
      'not_found'
    )
    expect(authority.registerImage('workspace-a', sessionId, '/private/replacement.png')).toMatch(
      /^native_chat_image_/
    )
  })
})

function bind(
  authority: MobileWebNativeChatAuthority,
  id: string,
  value: ReturnType<typeof binding>
) {
  authority.bind(id, value as Parameters<MobileWebNativeChatAuthority['bind']>[1])
  return id
}
