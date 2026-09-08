import { expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { IPtyProvider } from '../../../providers/types'
import { resolveStablePaneOwner, spawnForStablePane } from './stable-owner'

const tabId = 'tab-worker'
const leafId = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b'
const paneKey = makePaneKey(tabId, leafId)
const worktreeId = 'folder-worker'

function fixture(connectionId: string | null) {
  const ptyId = connectionId ? `ssh:${connectionId}@@worker` : 'worker'
  let session = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, type: 'terminal' }] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    },
    sleepingAgentSessionsByPaneKey: {
      [paneKey]: { worktreeId, automaticResumeBlockedBy: 'legacy-orchestration-worker' }
    }
  }
  const store = {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn((next) => {
      session = next
    }),
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

it('a fence queued after retirement still stops fresh fallback', async () => {
  const { store, ptyId } = fixture(null)
  delete (
    store.getWorkspaceSession().sleepingAgentSessionsByPaneKey[paneKey] as {
      automaticResumeBlockedBy?: string
    }
  ).automaticResumeBlockedBy
  const resolveOwner = () => {
    const owner = resolveStablePaneOwner(
      undefined,
      store as unknown as Store,
      paneKey,
      worktreeId,
      null
    )
    if (!owner) {
      queueMicrotask(() => {
        store.getWorkspaceSession().sleepingAgentSessionsByPaneKey[
          paneKey
        ].automaticResumeBlockedBy = 'legacy-orchestration-worker'
      })
    }
    return owner
  }
  const owner = resolveOwner()
  const spawn = vi.fn(async (options) => {
    if (options.attachOnly) {
      throw new SessionNotFoundError(ptyId)
    }
    return { id: 'replacement-despite-new-fence' }
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
  expect(result.result).toMatchObject({ reattachUnverifiable: true })
  expect(spawn).toHaveBeenCalledTimes(1)
})
