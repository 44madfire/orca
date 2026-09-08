import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { refreshLegacyWorkerResumeFences } from './legacy-worker-resume-fence-refresh'

const PANE_KEY = 'tab-1:11111111-2222-4333-8444-555555555555'

function stubFences(...replies: (Record<string, true> | undefined)[]): ReturnType<typeof vi.fn> {
  const get = vi.fn()
  for (const reply of replies) {
    get.mockResolvedValueOnce(reply)
  }
  get.mockResolvedValue(replies.at(-1))
  vi.stubGlobal('window', {
    ...globalThis.window,
    api: { app: { getLegacyWorkerResumeFences: get } }
  })
  return get
}

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: {} })
})

describe('re-reading the fenced-pane set after main invalidates it', () => {
  it('installs the set main reports', async () => {
    stubFences({ [PANE_KEY]: true })

    await refreshLegacyWorkerResumeFences()

    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [PANE_KEY]: true })
  })

  it('replaces the set rather than merging, so a retired pane is dropped', async () => {
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: { [PANE_KEY]: true } })
    stubFences({})

    await refreshLegacyWorkerResumeFences()

    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
  })

  it('keeps the previous set when the read fails', async () => {
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: { [PANE_KEY]: true } })
    const get = vi.fn().mockRejectedValue(new Error('runtime_unavailable'))
    vi.stubGlobal('window', {
      ...globalThis.window,
      api: { app: { getLegacyWorkerResumeFences: get } }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await refreshLegacyWorkerResumeFences()
    } finally {
      warn.mockRestore()
    }

    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [PANE_KEY]: true })
  })
})

it.each(
  ['full', 'scoped', 'two-scopes'].flatMap((scope) =>
    [true, false].map((stale) => ({ scope, stale }))
  )
)(
  'review: stale acquired hint after %s hydration cannot block retirement',
  async ({ scope, stale }) => {
    const key = 'historical:11111111-1111-4111-8111-111111111111',
      wt = 'folder:worker'
    const record = {
      paneKey: key,
      tabId: 'historical',
      worktreeId: wt,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'session-worker' },
      state: 'working' as const,
      prompt: 'continue',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    let reply!: (v: Record<string, true>) => void
    vi.stubGlobal('window', {
      api: {
        app: {
          getLegacyWorkerResumeFences: () => new Promise<Record<string, true>>((r) => (reply = r))
        }
      }
    })
    const pending = refreshLegacyWorkerResumeFences()
    useAppStore.getState().hydrateWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: { [key]: record },
        legacyWorkerResumeFencesByPaneKey: {}
      },
      {
        additionalValidWorkspaceKeys: [wt],
        ...(scope === 'full' ? {} : { replaceWorkspaceKeys: [wt] })
      }
    )
    if (scope === 'two-scopes') {
      useAppStore.getState().hydrateWorkspaceSession(
        { ...getDefaultWorkspaceSession(), legacyWorkerResumeFencesByPaneKey: {} },
        {
          additionalValidWorkspaceKeys: ['folder:sibling'],
          replaceWorkspaceKeys: ['folder:sibling']
        }
      )
    }
    reply(stale ? { [key]: true } : {})
    await pending
    const count = resumeSleepingAgentSessionsForWorktree(wt)
    expect(count).toBe(1)
  }
)

it.each([true, false])(
  'retirement remains eligible with disjoint hydration: %s',
  async (disjoint) => {
    const key = 'historical:11111111-1111-4111-8111-111111111111',
      wt = 'folder:worker'
    const record = {
      paneKey: key,
      tabId: 'historical',
      worktreeId: wt,
      agent: 'codex' as const,
      providerSession: { key: 'session_id' as const, id: 'session-worker' },
      state: 'working' as const,
      prompt: 'continue',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    useAppStore.getState().hydrateWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: { [key]: record },
        legacyWorkerResumeFencesByPaneKey: { [key]: true }
      },
      { additionalValidWorkspaceKeys: [wt] }
    )
    let reply!: (v: Record<string, true>) => void
    vi.stubGlobal('window', {
      api: {
        app: {
          getLegacyWorkerResumeFences: () => new Promise<Record<string, true>>((r) => (reply = r))
        }
      }
    })
    const pending = refreshLegacyWorkerResumeFences()
    if (disjoint) {
      useAppStore.getState().hydrateWorkspaceSession(
        { ...getDefaultWorkspaceSession(), legacyWorkerResumeFencesByPaneKey: {} },
        {
          additionalValidWorkspaceKeys: ['folder:sibling'],
          replaceWorkspaceKeys: ['folder:sibling']
        }
      )
    }
    reply({})
    await pending
    const count = resumeSleepingAgentSessionsForWorktree(wt)
    expect(count).toBe(1)
  }
)
