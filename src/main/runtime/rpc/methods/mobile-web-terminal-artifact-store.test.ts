import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS } from '../../../../shared/mobile-web/terminal-artifact-contract'
import { MobileWebTerminalArtifactStore } from './mobile-web-terminal-artifact-store'

function record(connectionId: string, tabId: string) {
  return {
    connectionId,
    worktree: 'id:workspace-1',
    tabId,
    terminal: 'private-terminal',
    absolutePath: '/private/report.txt',
    grantId: 'grant',
    previewKind: 'text' as const
  }
}

describe('mobile web terminal artifact store', () => {
  it('keeps one live token per tab', () => {
    const store = new MobileWebTerminalArtifactStore()
    const first = store.retain(record('socket-a', 'tab-1'))
    store.retain(record('socket-a', 'tab-1'))
    expect(store.sizeForTests()).toBe(1)
    expect(() => store.require({ ...first, tabId: 'tab-1' })).toThrow('selector_not_found')
  })

  it('caps what one connection can hold without touching another connection', () => {
    const store = new MobileWebTerminalArtifactStore()
    const other = store.retain(record('socket-b', 'tab-0'))
    for (let index = 0; index <= MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS; index += 1) {
      store.retain(record('socket-a', `tab-${index}`))
    }
    expect(store.sizeForTests()).toBe(MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS + 1)
    expect(store.require({ token: other.token, connectionId: 'socket-b', tabId: 'tab-0' })).toEqual(
      other
    )
  })

  it('drops a token once its ttl passes', () => {
    let now = 1_000
    const store = new MobileWebTerminalArtifactStore(() => now)
    const retained = store.retain(record('socket-a', 'tab-1'))
    now += 10 * 60 * 1000
    expect(store.sizeForTests()).toBe(0)
    expect(() =>
      store.require({ token: retained.token, connectionId: 'socket-a', tabId: 'tab-1' })
    ).toThrow('selector_not_found')
  })
})
