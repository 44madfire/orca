import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { createTestStore } from '../store/slices/store-test-helpers'

const initialState = useAppStore.getState()
const pane = 'target:11111111-2222-4333-8444-555555555555'
const worktreeId = 'repo::/target'

afterEach(() => {
  useAppStore.setState(initialState, true)
})

it('an authoritative empty set retires a legacy flag while an absent set preserves it', () => {
  const store = createTestStore()
  const record = {
    paneKey: pane,
    tabId: 'target',
    worktreeId,
    agent: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'provider' },
    prompt: '',
    state: 'done' as const,
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live' as const,
    automaticResumeBlockedBy: 'legacy-orchestration-worker' as const
  }
  const oldSession = {
    ...getDefaultWorkspaceSession(),
    sleepingAgentSessionsByPaneKey: { [pane]: record }
  }
  store.getState().hydrateWorkspaceSession(oldSession)
  expect(store.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
  store.getState().hydrateWorkspaceSession({ ...oldSession, legacyWorkerResumeFencesByPaneKey: {} })
  expect(store.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
})

it('publishes sleeping records and their fence hint in a single subscriber notification', () => {
  const session = {
    ...getDefaultWorkspaceSession(),
    legacyWorkerResumeFencesByPaneKey: { [pane]: true as const },
    sleepingAgentSessionsByPaneKey: {
      [pane]: {
        paneKey: pane,
        tabId: 'target',
        worktreeId: 'folder:legacy',
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: 'provider' },
        prompt: '',
        state: 'working' as const,
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live' as const
      }
    }
  }
  const observed: boolean[][] = []
  const unsubscribe = useAppStore.subscribe((state) => {
    observed.push([
      !!state.sleepingAgentSessionsByPaneKey[pane],
      !!state.legacyWorkerResumeFencesByPaneKey[pane]
    ])
  })
  try {
    useAppStore.getState().hydrateWorkspaceSession(session, {
      additionalValidWorkspaceKeys: ['folder:legacy']
    })
    expect(observed).toEqual([[true, true]])
  } finally {
    unsubscribe()
  }
})
