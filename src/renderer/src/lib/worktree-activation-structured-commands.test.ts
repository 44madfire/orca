import { describe, expect, it, vi } from 'vitest'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import {
  createMockStore,
  registerWorktreeActivationReset,
  setSetupScriptLaunchMode
} from './worktree-activation-test-harness'

registerWorktreeActivationReset()

describe('structured creation terminal work', () => {
  it('preserves explicit default tabs and their setup splits in the background', () => {
    setSetupScriptLaunchMode('split-horizontal')
    let index = 0
    const store = createMockStore({ createTab: vi.fn(() => ({ id: `tab-${++index}` })) })
    ensureWorktreeHasInitialTerminal(
      store,
      'wt-1',
      undefined,
      { runnerScriptPath: '/tmp/setup.sh', command: 'run-setup', envVars: {} },
      undefined,
      { tabs: [{ title: 'Server', command: 'run-server' }], runCommands: true },
      { callerProvidesSurface: true, activateCreatedTabs: false }
    )
    expect(store.createTab).toHaveBeenCalledTimes(1)
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith('tab-1', { command: 'run-server' })
    expect(store.queueTabSetupSplit).toHaveBeenCalledWith('tab-1', {
      command: 'run-setup',
      env: {},
      direction: 'horizontal'
    })
    expect(store.setActiveTab).not.toHaveBeenCalled()
  })
})
