import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  requestMobileNativeChatStopLease,
  requestMobileNativeChatWriteLease,
  resetMobileNativeChatStopLeasesForTests
} from './mobile-native-chat-stop-lease'

describe('mobile native-chat terminal leases', () => {
  afterEach(resetMobileNativeChatStopLeasesForTests)

  const owner = (sessionId: string, agent = 'codex') => ({
    agent,
    sessionId,
    streamIdentity: sessionId
  })

  it('runs Stop after the active action and before queued FIFO writers', async () => {
    const active = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const firstQueued = requestMobileNativeChatWriteLease('terminal-1')
    const secondQueued = requestMobileNativeChatWriteLease('terminal-1')
    const stop = requestMobileNativeChatStopLease('terminal-1', owner('session-1'))
    const order: string[] = []
    void firstQueued.acquired.then(() => order.push('first'))
    void secondQueued.acquired.then(() => order.push('second'))
    void stop?.acquired.then(() => order.push('stop'))

    active?.release()
    const stopLease = await stop?.acquired
    expect(order).toEqual(['stop'])

    stopLease?.release()
    const firstLease = await firstQueued.acquired
    expect(order).toEqual(['stop', 'first'])

    firstLease?.release()
    const secondLease = await secondQueued.acquired
    expect(order).toEqual(['stop', 'first', 'second'])
    secondLease?.release()
  })

  it('admits only one pending or active Stop per terminal', async () => {
    const writer = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const stop = requestMobileNativeChatStopLease('terminal-1', owner('session-1'))

    expect(stop).not.toBeNull()
    expect(requestMobileNativeChatStopLease('terminal-1', owner('session-1'))).toBeNull()
    writer?.release()
    const stopLease = await stop?.acquired
    expect(requestMobileNativeChatStopLease('terminal-1', owner('session-1'))).toBeNull()
    stopLease?.release()
  })

  it('queues a replacement-session Stop behind the active Stop', async () => {
    const activeRequest = requestMobileNativeChatStopLease('terminal-1', owner('session-1'))
    const active = await activeRequest?.acquired
    const replacement = requestMobileNativeChatStopLease('terminal-1', owner('session-2'))
    const admitted = vi.fn()
    void replacement?.acquired.then(admitted)

    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()
    active?.release()

    const replacementLease = await replacement?.acquired
    expect(admitted).toHaveBeenCalledOnce()
    replacementLease?.release()
  })

  it('treats a replacement agent as a distinct Stop owner', async () => {
    const activeRequest = requestMobileNativeChatStopLease('terminal-1', owner('session-1'))
    const active = await activeRequest?.acquired
    const replacement = requestMobileNativeChatStopLease('terminal-1', owner('session-1', 'claude'))

    expect(replacement).not.toBeNull()
    active?.release()
    const replacementLease = await replacement?.acquired
    replacementLease?.release()
  })

  it('supersedes a pending Stop owned by an older session', async () => {
    const writer = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const stale = requestMobileNativeChatStopLease('terminal-1', owner('session-1'))
    const replacement = requestMobileNativeChatStopLease('terminal-1', owner('session-2'))

    await expect(stale?.acquired).resolves.toBeNull()
    writer?.release()
    const replacementLease = await replacement?.acquired
    expect(replacementLease).toMatchObject({ terminal: 'terminal-1', kind: 'stop' })
    replacementLease?.release()
  })

  it('scopes ownership per terminal', async () => {
    const first = await requestMobileNativeChatWriteLease('terminal-1').acquired

    await expect(requestMobileNativeChatWriteLease('terminal-2').acquired).resolves.toMatchObject({
      terminal: 'terminal-2'
    })
    first?.release()
  })

  it('does not let a stale release retire a successor', async () => {
    const first = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const successorRequest = requestMobileNativeChatWriteLease('terminal-1')
    first?.release()
    const successor = await successorRequest.acquired
    const later = requestMobileNativeChatWriteLease('terminal-1')
    const admitted = vi.fn()
    void later.acquired.then(admitted)

    first?.release()
    await Promise.resolve()
    expect(admitted).not.toHaveBeenCalled()

    successor?.release()
    await later.acquired
    expect(admitted).toHaveBeenCalledOnce()
  })

  it('cancels a queued writer without starving its successor', async () => {
    const active = await requestMobileNativeChatWriteLease('terminal-1').acquired
    const canceled = requestMobileNativeChatWriteLease('terminal-1')
    const successor = requestMobileNativeChatWriteLease('terminal-1')

    canceled.cancel()
    await expect(canceled.acquired).resolves.toBeNull()
    active?.release()
    await expect(successor.acquired).resolves.toMatchObject({ terminal: 'terminal-1' })
  })
})
