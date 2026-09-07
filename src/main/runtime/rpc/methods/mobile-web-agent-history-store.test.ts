import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { MobileWebAgentHistoryStore } from './mobile-web-agent-history-store'

const session = (id: string) => ({ id }) as AiVaultSession
const page = { sessions: [], skippedTranscriptCount: 0, offset: 0 }

describe('mobile web agent history store', () => {
  it('keeps one connection from reading another connection cursor', () => {
    const store = new MobileWebAgentHistoryStore()
    const cursor = store.retain('socket-a', page)
    expect(() => store.consume('socket-b', cursor)).toThrow('invalid_argument')
    expect(store.consume('socket-a', cursor)).toMatchObject({ offset: 0 })
  })

  it('spends a cursor once', () => {
    const store = new MobileWebAgentHistoryStore()
    const cursor = store.retain('socket-a', page)
    store.consume('socket-a', cursor)
    expect(() => store.consume('socket-a', cursor)).toThrow('invalid_argument')
  })

  it('reuses one resume key until the resume succeeds', () => {
    const store = new MobileWebAgentHistoryStore()
    const first = store.claimResumeMutationId('socket-a', 'claude:1')
    expect(store.claimResumeMutationId('socket-a', 'claude:1')).toBe(first)
    store.releaseResumeMutationId('socket-a', 'claude:1')
    expect(store.claimResumeMutationId('socket-a', 'claude:1')).not.toBe(first)
  })

  it('mints a distinct handle per session and revokes the previous listing', () => {
    const store = new MobileWebAgentHistoryStore()
    const first = store.synchronize('socket-a', [session('a'), session('b')])
    expect(new Set(first.values()).size).toBe(2)
    const stale = first.get('a')!
    store.synchronize('socket-a', [session('a')])
    expect(() => store.session('socket-a', stale)).toThrow('selector_not_found')
  })
})
