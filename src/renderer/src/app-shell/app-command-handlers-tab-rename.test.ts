import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { AppShortcutState, ShortcutDispatchInput } from './app-command-handlers'

const mocks = vi.hoisted(() => ({
  requestTerminalTabRename: vi.fn(),
  store: {} as AppState
}))

vi.mock('../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: () => mocks.store })
}))

vi.mock('../components/tab-bar/terminal-tab-rename-request', () => ({
  requestTerminalTabRename: mocks.requestTerminalTabRename
}))

vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

vi.mock('@/lib/terminal-shortcut-capture-notification', () => ({
  showTerminalShortcutCaptureNotification: vi.fn()
}))

import { createAppCommandHandlers } from './app-command-handlers'

function shortcutState(): AppShortcutState {
  return {
    activeView: 'terminal',
    activeWorktreeId: 'repo::/feature',
    actions: {} as AppShortcutState['actions'],
    creationLayoutActive: false,
    floatingTerminalEnabled: false,
    floatingTerminalOpen: false,
    floatingVisibleTabCount: 0,
    keybindings: {},
    openFloatingWorkspaceMaximized: vi.fn(),
    pluginCommands: [],
    setFloatingTerminalOpen: vi.fn(),
    terminalShortcutPolicy: 'orca-first',
    workspaceChromeActive: true
  }
}

function shortcutInput(): ShortcutDispatchInput {
  return { target: null, defaultPrevented: false, preventDefault: vi.fn() }
}

function runRename(activeTabType: string | null): boolean | undefined {
  mocks.store = { activeTabType, activeTabId: 'tab-1' } as unknown as AppState
  return createAppCommandHandlers(shortcutState(), shortcutInput(), 'terminal').get(
    'tab.rename'
  )?.()
}

describe('tab.rename shortcut', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens the rename editor on a structured chat tab', () => {
    expect(runRename('agent-session')).toBe(true)
    expect(mocks.requestTerminalTabRename).toHaveBeenCalledWith('tab-1')
  })

  it('still opens the rename editor on a terminal tab', () => {
    expect(runRename('terminal')).toBe(true)
    expect(mocks.requestTerminalTabRename).toHaveBeenCalledWith('tab-1')
  })

  it('does not claim the chord for a tab type that has no inline rename', () => {
    expect(runRename('browser')).toBe(false)
    expect(mocks.requestTerminalTabRename).not.toHaveBeenCalled()
  })
})
