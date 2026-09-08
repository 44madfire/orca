import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { AgentStatusEntry, AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const PTY = 'pty-evidence'
const APPROVAL = readFileSync(
  join(__dirname, '__fixtures__/cursor-agent-approval-prompt.txt'),
  'utf8'
)

async function createRuntime() {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const hooks: AgentStatusIpcPayload[] = []
  const runtime = new OrcaRuntimeService(null, undefined, { getAgentStatusSnapshot: () => hooks })
  const internals = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope(selector: string): Promise<unknown>
  }
  vi.spyOn(internals, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
    id: 'folder-1',
    path: '/workspace',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  })
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY, incarnationId: 'inc-1' }),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'codex'
  })
  const { handle } = await runtime.createTerminal('id:folder-1')
  function hook(
    state: AgentStatusEntry['state'],
    restoredUnconfirmed = false,
    stateStartedAt = Date.now()
  ): void {
    hooks.splice(0, hooks.length, {
      paneKey: 'hook-pane',
      terminalHandle: handle,
      state,
      prompt: '',
      agentType: 'codex',
      connectionId: null,
      receivedAt: Date.now(),
      stateStartedAt,
      restoredUnconfirmed
    })
  }
  function output(text: string): void {
    runtime.onPtyData(PTY, text, Date.now())
  }
  return { runtime, handle, hook, output }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runtime status and interactive-wait evidence agreement', () => {
  it.each(['working', 'done'] as const)(
    'clears stale permission after a newer %s hook',
    async (state) => {
      const { runtime, handle, hook, output } = await createRuntime()
      output('\x1b]0;Codex waiting for permission\x07')
      vi.setSystemTime(11_000)
      hook(state)
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: state === 'done' ? 'idle' : 'working'
      })
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      await expect(
        assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
      ).resolves.toBeUndefined()
    }
  )

  it.each([10_000, 11_000])(
    'keeps equal/newer genuine permission title blocked (%s)',
    async (at) => {
      const { runtime, handle, hook, output } = await createRuntime()
      hook('working')
      vi.setSystemTime(at)
      output('\x1b]0;Codex waiting for permission\x07')
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        status: 'permission'
      })
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
        source: 'title'
      })
      await expect(
        assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
      ).rejects.toThrow('terminal_guard_permission')
    }
  )

  it('clears retained approval text only after a newer explicit response', async () => {
    const { runtime, handle, hook, output } = await createRuntime()
    output(`\x1b]0;⠇ Cursor Agent\x07${APPROVAL}`)
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      reason: 'agent-approval-prompt'
    })
    vi.setSystemTime(11_000)
    hook('working')
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      status: 'working'
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  it('preserves genuine approval text after an earlier working hook', async () => {
    const { runtime, handle, hook, output } = await createRuntime()
    hook('working')
    vi.setSystemTime(11_000)
    output(`\x1b]0;⠇ Cursor Agent\x07${APPROVAL}`)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      status: 'permission'
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      reason: 'agent-approval-prompt'
    })
  })

  it('does not clear permission with a restored unconfirmed hook', async () => {
    const { runtime, handle, hook, output } = await createRuntime()
    output('\x1b]0;Codex waiting for permission\x07')
    vi.setSystemTime(11_000)
    hook('working', true)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      status: 'permission'
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      source: 'title'
    })
  })

  it('keeps a working refresh distinct from a new resume transition', async () => {
    const { runtime, handle, hook, output } = await createRuntime()
    hook('working')
    vi.setSystemTime(11_000)
    output('\x1b]0;Codex waiting for permission\x07')
    vi.setSystemTime(12_000)
    hook('working', false, 10_000)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      status: 'permission'
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      source: 'title'
    })
    hook('working')
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      status: 'working'
    })
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  it('preserves native receipt time through graph sync and clears it on provider reset and restore seed', async () => {
    const { runtime, output } = await createRuntime()
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    const graph = {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'folder-1',
          title: 'Terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [{ tabId: 'tab-1', worktreeId: 'folder-1', leafId, paneRuntimeId: 1, ptyId: PTY }]
    }
    runtime.syncWindowGraph(1, graph)
    const internals = runtime as unknown as {
      leaves: Map<string, { lastOscTitleEpochMs?: number | null }>
      getLeafKey(tabId: string, leafId: string): string
      resetTrackedTerminalStateForProviderGeneration(ptyId: string): void
      applySeededAgentStatus(ptyId: string, title: string): void
    }
    const receipt = (): number | null | undefined =>
      internals.leaves.get(internals.getLeafKey('tab-1', leafId))?.lastOscTitleEpochMs
    output('\x1b]0;Codex waiting for permission\x07')
    expect(receipt()).toBe(10_000)
    runtime.syncWindowGraph(1, graph)
    expect(receipt()).toBe(10_000)
    internals.resetTrackedTerminalStateForProviderGeneration(PTY)
    expect(receipt()).toBeNull()
    vi.setSystemTime(11_000)
    internals.applySeededAgentStatus(PTY, 'Codex waiting for permission')
    expect(receipt()).toBeNull()
  })
})
