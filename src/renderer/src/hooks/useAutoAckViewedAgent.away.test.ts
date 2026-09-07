// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAutoAckViewedAgent } from './useAutoAckViewedAgent'
import { useAppStore } from '../store'
import { makeTab } from '../store/slices/store-test-helpers'
import { makePaneKey } from '../../../shared/stable-pane-id'

const leaf = '11111111-1111-4111-8111-111111111111'
const pane = makePaneKey('away-tab', leaf)
const readAway = vi.fn<() => Promise<boolean | undefined>>()
const dismiss = vi.fn()
const previousApi = window.api
beforeEach(() => {
  readAway.mockReset().mockResolvedValue(true)
  dismiss.mockReset()
  Object.assign(window, { api: { notifications: { getDesktopAwayState: readAway, dismiss } } })
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  useAppStore.setState({
    activeView: 'terminal',
    activeTabId: 'away-tab',
    activeWorktreeId: 'away-workspace',
    activeTabIdByWorktree: {},
    tabsByWorktree: {
      'away-workspace': [makeTab({ id: 'away-tab', worktreeId: 'away-workspace' })]
    },
    terminalLayoutsByTabId: {
      'away-tab': { root: null, activeLeafId: leaf, expandedLeafId: null }
    },
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {},
    manuallyUnreadTurnsByPaneKey: {}
  })
  useAppStore
    .getState()
    .setAgentStatus(pane, { state: 'done', prompt: 'away test', agentType: 'codex' })
  useAppStore.getState().markAgentCompletionPaneUnread(pane)
})
afterEach(() => {
  cleanup()
  Object.assign(window, { api: previousApi })
  vi.restoreAllMocks()
})

it('leaves the focused pane unread while desktop is away, then acknowledges on user return', async () => {
  renderHook(() => useAutoAckViewedAgent(false))
  await act(async () => {
    await Promise.resolve()
  })
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe(true)
  expect(dismiss).not.toHaveBeenCalled()
  readAway.mockResolvedValue(false)
  const input = new Event('pointerdown')
  Object.defineProperty(input, 'isTrusted', { value: true })
  act(() => window.dispatchEvent(input))
  await waitFor(() =>
    expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBeUndefined()
  )
  expect(dismiss).toHaveBeenCalledTimes(1)
})

it('does not acknowledge when the presence query fails or the hook unmounts', async () => {
  let resolve!: (away: boolean) => void
  readAway.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const hook = renderHook(() => useAutoAckViewedAgent(false))
  hook.unmount()
  await act(async () => {
    resolve(false)
  })
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe(true)
  readAway.mockRejectedValue(new Error('unavailable'))
  renderHook(() => useAutoAckViewedAgent(false))
  await act(async () => {
    await Promise.resolve()
  })
  expect(useAppStore.getState().unreadAgentCompletionPanes[pane]).toBe(true)
  expect(dismiss).not.toHaveBeenCalled()
})
