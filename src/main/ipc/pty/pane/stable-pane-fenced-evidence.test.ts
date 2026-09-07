import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import {
  SshPtyAbsentFromRelayError,
  SshPtyProvenExitedOnRelayError
} from '../../../providers/ssh-pty-errors'
import type { IPtyProvider } from '../../../providers/types'
import { resolveStablePaneOwner, spawnForStablePane } from './stable-owner'
import { ptyOwnership } from '../provider/ownership-state'

const tabId = 'tab-worker'
const leafId = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b'
const paneKey = makePaneKey(tabId, leafId)
const worktreeId = 'folder-worker'

function fixture(connectionId: string | null) {
  const ptyId = connectionId ? `ssh:${connectionId}@@worker` : 'worker'
  const session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, type: 'terminal' }] },
    terminalLayoutsByTabId: { [tabId]: { ptyIdsByLeafId: { [leafId]: ptyId } } },
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: { worktreeId, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
    }
  }
  const store = {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    flushOrThrow: vi.fn()
  }
  return {
    ptyId,
    store,
    owner: resolveStablePaneOwner(
      undefined,
      store as unknown as Store,
      paneKey,
      worktreeId,
      connectionId
    )
  }
}

describe('stable-pane fenced attach evidence', () => {
  it.each([
    [null, new SessionNotFoundError('worker'), 'exitedBeforeAttach'],
    [null, new Error('Session not found: worker'), 'reattachUnverifiable'],
    ['host', new SshPtyAbsentFromRelayError('worker'), 'reattachUnverifiable'],
    ['host', new SshPtyProvenExitedOnRelayError('worker'), 'exitedBeforeAttach'],
    ['host', new Error('socket closed'), 'reattachUnverifiable']
  ] as const)('preserves %s ownership for %s', async (connectionId, error, outcome) => {
    const { ptyId, store, owner } = fixture(connectionId)
    const spawn = vi.fn(async () => {
      throw error
    })
    ptyOwnership.set(ptyId, connectionId)
    try {
      const result = await spawnForStablePane({
        store: store as unknown as Store,
        runtime: undefined,
        provider: { spawn } as unknown as IPtyProvider,
        owner,
        worktreeId,
        connectionId,
        spawnOptions: { cols: 80, rows: 24, paneKey, command: 'must never run' }
      })
      expect(result.result).toEqual({ id: ptyId, [outcome]: true })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({ attachOnly: true, command: undefined })
      )
      expect(store.setWorkspaceSession).not.toHaveBeenCalled()
      expect(ptyOwnership.get(ptyId)).toBe(connectionId)
      expect(store.getWorkspaceSession).toHaveBeenCalledWith(connectionId ? 'ssh:host' : undefined)
    } finally {
      ptyOwnership.delete(ptyId)
    }
  })
  it('refuses a newly fenced ownerless pane at the final spawn boundary', async () => {
    const { store } = fixture(null)
    const spawn = vi.fn(async () => ({ id: 'must-not-spawn' }))
    const result = await spawnForStablePane({
      store: store as unknown as Store,
      runtime: undefined,
      provider: { spawn } as unknown as IPtyProvider,
      owner: null,
      worktreeId,
      spawnOptions: { cols: 80, rows: 24, paneKey }
    })
    expect(result.result).toMatchObject({ reattachUnverifiable: true })
    expect(spawn).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })
  it('rechecks a fence committed while attachment is awaiting the host', async () => {
    const { store, ptyId } = fixture(null)
    const record = store.getWorkspaceSession().sleepingAgentSessionsByPaneKey[paneKey]
    delete (record as { automaticResumeBlockedBy?: string }).automaticResumeBlockedBy
    const resolveOwner = () =>
      resolveStablePaneOwner(undefined, store as unknown as Store, paneKey, worktreeId, null)
    const owner = resolveOwner()
    let calls = 0
    const spawn = vi.fn(async () => {
      if (++calls === 1) {
        record.automaticResumeBlockedBy = 'legacy-orchestration-worker'
        throw new SessionNotFoundError(ptyId)
      }
      return { id: 'replacement-after-fence' }
    })
    const result = await spawnForStablePane({
      runtime: undefined,
      store: store as unknown as Store,
      provider: { spawn } as unknown as IPtyProvider,
      owner,
      worktreeId,
      connectionId: null,
      resolveOwner,
      spawnOptions: { cols: 80, rows: 24, paneKey }
    })
    expect(result.result).toEqual({ id: ptyId, reattachUnverifiable: true })
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})
