import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalAgentStatusQuery } from './runtime-terminal-agent-status-query'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { AgentStatus } from '../../shared/agent-detection'

const PERMISSION = 'Codex waiting for permission'
const APPROVAL = readFileSync(
  join(__dirname, '__fixtures__/cursor-agent-approval-prompt.txt'),
  'utf8'
)

function createQuery() {
  const pty = {
    ptyId: 'pty-1',
    connected: true,
    title: null,
    titleUpdatedAt: null,
    lastOscTitle: PERMISSION,
    lastOscTitleAt: 900_000,
    lastOscTitleEpochMs: 100,
    lastAgentStatus: 'permission',
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    waitBlockedAt: null
  } as unknown as RuntimePtyWorktreeRecord
  const state = {
    generation: 1,
    leafHandle: false,
    explicit: { status: 'working' as AgentStatus, updatedAt: 200, stateStartedAt: 200 } as {
      status: AgentStatus
      updatedAt: number
      stateStartedAt?: number
    } | null,
    lifecycle: null as { status: AgentStatus; updatedAt: number } | null,
    leaf: null as RuntimeLeafRecord | null
  }
  const getForegroundProcess = vi.fn(async (): Promise<string | null> => 'codex')
  const confirmForegroundProcess = vi.fn(async (): Promise<string | null> => 'codex')
  const isRunning = vi.fn(async () => false)
  const query = new RuntimeTerminalAgentStatusQuery({
    getController: () =>
      ({ getForegroundProcess, confirmForegroundProcess }) as unknown as RuntimePtyController,
    getLivePty: () => (state.leafHandle ? null : { pty }),
    getLiveLeaf: () => {
      if (state.leaf) {
        return { leaf: state.leaf }
      }
      throw new Error('unexpected leaf lookup')
    },
    getPrimaryLeaf: () => state.leaf,
    getTabTitle: () => null,
    getExplicitStatus: () => state.explicit,
    getLifecycleStatus: () => state.lifecycle,
    getLifecycleGeneration: () => state.generation,
    isRunning
  })
  return { query, pty, state, getForegroundProcess, confirmForegroundProcess, isRunning }
}

describe('terminal status evidence selection', () => {
  it('lets a newer explicit transition clear permission using receipt time, not title sequence', async () => {
    const { query, getForegroundProcess } = createQuery()
    expect(query.getSnapshot('term-1', 'pty-1')).toMatchObject({ titleUpdatedAt: 100 })
    await expect(query.getStatus('term-1')).resolves.toEqual({
      handle: 'term-1',
      isRunningAgent: true,
      status: 'working'
    })
    expect(getForegroundProcess).toHaveBeenCalledOnce()
  })

  it.each([200, 300, null])('preserves tied, newer or undated permission (%s)', async (at) => {
    const { query, pty, getForegroundProcess } = createQuery()
    pty.lastOscTitleEpochMs = at
    await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'permission' })
    expect(getForegroundProcess).not.toHaveBeenCalled()
  })

  it.each([50, undefined])(
    'does not mistake a refreshed or undated working snapshot for a transition (%s)',
    async (stateStartedAt) => {
      const { query, state } = createQuery()
      state.explicit = { status: 'working', updatedAt: 200, stateStartedAt }
      await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'permission' })
    }
  )

  it('uses the selected native observation receipt clock for a mounted leaf handle', async () => {
    const { query, state } = createQuery()
    state.leafHandle = true
    state.leaf = {
      ptyId: 'pty-1',
      connected: true,
      lastExitCode: null,
      paneTitle: null,
      paneTitleUpdatedAt: null,
      lastOscTitle: PERMISSION,
      lastOscTitleAt: 900_001,
      lastOscTitleEpochMs: 100,
      tailBuffer: [],
      tailPartialLine: '',
      preview: '',
      waitBlockedAt: null
    } as unknown as RuntimeLeafRecord
    await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'working' })
    state.leaf.lastOscTitleEpochMs = null
    await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'permission' })
  })

  it('does not borrow OSC receipt time for a newer pane title with the same text', async () => {
    const { query, state } = createQuery()
    state.leaf = {
      paneTitle: PERMISSION,
      paneTitleUpdatedAt: 900_002,
      lastOscTitle: PERMISSION,
      lastOscTitleAt: 900_001
    } as RuntimeLeafRecord
    expect(query.getSnapshot('term-1', 'pty-1').titleUpdatedAt).toBeNull()
    await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'permission' })
  })

  it.each([100, 200, 300, null])(
    'arbitrates timestamped approval text conservatively (%s)',
    async (at) => {
      const { query, pty } = createQuery()
      pty.lastOscTitle = '⠇ Cursor Agent'
      pty.tailBuffer = APPROVAL.split('\n')
      pty.waitBlockedAt = at
      await expect(query.getStatus('term-1')).resolves.toMatchObject({
        status: at === 100 ? 'working' : 'permission'
      })
    }
  )

  it('does not let a later title-derived lifecycle clear an unanswered approval', async () => {
    const { query, pty, state } = createQuery()
    pty.lastOscTitle = '⠇ Cursor Agent'
    pty.tailBuffer = APPROVAL.split('\n')
    pty.waitBlockedAt = 100
    state.explicit = null
    state.lifecycle = { status: 'working', updatedAt: 300 }
    await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'permission' })
  })

  it('still corroborates shell foreground after clearing a stale permission title', async () => {
    const { query, getForegroundProcess, confirmForegroundProcess } = createQuery()
    getForegroundProcess.mockResolvedValue('powershell.exe')
    confirmForegroundProcess.mockResolvedValue('pwsh.exe')
    await expect(query.getStatus('term-1')).resolves.toMatchObject({
      isRunningAgent: false,
      status: null
    })
    expect(confirmForegroundProcess).toHaveBeenCalledOnce()
  })

  it.each(['OC | session', '◐'])('keeps corroboration for ambiguous title %s', async (title) => {
    const { query, pty, state, isRunning } = createQuery()
    pty.lastOscTitle = title
    state.explicit = null
    await expect(query.getStatus('term-1')).resolves.toMatchObject({
      isRunningAgent: false,
      status: null
    })
    expect(isRunning).toHaveBeenCalledOnce()
  })

  it('keeps title-only CLI compatibility when hooks are absent', async () => {
    const { query, pty, state, isRunning } = createQuery()
    pty.lastOscTitle = 'Codex working'
    state.explicit = null
    await expect(query.getStatus('term-1')).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'working'
    })
    expect(isRunning).not.toHaveBeenCalled()
  })

  it.each(['pty', 'generation'])(
    'rejects delayed evidence after %s replacement without joining it',
    async (kind) => {
      const { query, pty, state, getForegroundProcess } = createQuery()
      let finish!: (value: string) => void
      getForegroundProcess.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          })
      )
      const first = query.getStatus('term-1')
      const duplicate = query.getStatus('term-1')
      const rejected = expect(first).rejects.toThrow('terminal_handle_stale')
      const duplicateRejected = expect(duplicate).rejects.toThrow('terminal_handle_stale')
      expect(getForegroundProcess).toHaveBeenCalledOnce()
      if (kind === 'pty') {
        pty.ptyId = 'pty-2'
      } else {
        state.generation += 1
      }
      await expect(query.getStatus('term-1')).resolves.toMatchObject({ status: 'working' })
      expect(getForegroundProcess).toHaveBeenCalledTimes(2)
      finish('codex')
      await Promise.all([rejected, duplicateRejected])
    }
  )
})
