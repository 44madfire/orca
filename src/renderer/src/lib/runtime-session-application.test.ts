import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import { refreshLegacyWorkerResumeFences } from './legacy-worker-resume-fence-refresh'
import { createTestStore, makeTab } from '../store/slices/store-test-helpers'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

const initialState = useAppStore.getState()
const pane = 'target:11111111-2222-4333-8444-555555555555'
const sibling = 'sibling:22222222-2222-4333-8444-555555555555'
const worktreeId = 'repo::/target'

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})

it('applies startup runtime fields at read time, before delayed catalog hydration', async () => {
  const old = { ...getDefaultWorkspaceSession(), legacyWorkerResumeFencesByPaneKey: {} }
  const read = await fetchWorkspaceSessionWithRuntimeHostOwners({ get: async () => old }, [])
  vi.stubGlobal('window', {
    api: {
      app: {
        getLegacyWorkerResumeFences: async () => ({ [pane]: true })
      }
    }
  })
  await refreshLegacyWorkerResumeFences()
  useAppStore.getState().hydrateWorkspaceSession(read.session)
  expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [pane]: true })
})

it('orders a scoped retirement after an in-flight invalidation and retains its sibling', async () => {
  let resolve!: (value: Record<string, true>) => void
  vi.stubGlobal('window', {
    api: {
      app: {
        getLegacyWorkerResumeFences: () =>
          new Promise<Record<string, true>>((done) => {
            resolve = done
          })
      }
    }
  })
  const refresh = refreshLegacyWorkerResumeFences()
  const tab = makeTab({ id: 'target', worktreeId })
  useAppStore.setState({ tabsByWorktree: { [worktreeId]: [tab] } })
  useAppStore.getState().hydrateWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [worktreeId]: [tab] },
      legacyWorkerResumeFencesByPaneKey: {}
    },
    {
      replaceWorkspaceKeys: [worktreeId],
      additionalValidWorkspaceKeys: [worktreeWorkspaceKey(worktreeId)]
    }
  )
  resolve({ [pane]: true, [sibling]: true })
  await refresh
  expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [sibling]: true })
})

it('an absent direct SSH authority cannot retire a target fence', () => {
  const store = createTestStore()
  const tab = makeTab({ id: 'target', worktreeId })
  store.setState({
    tabsByWorktree: { [worktreeId]: [tab] },
    legacyWorkerResumeFencesByPaneKey: { [pane]: true, [sibling]: true }
  })
  store.getState().hydrateWorkspaceSession(
    {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [worktreeId]: [tab] }
    },
    {
      replaceWorkspaceKeys: [worktreeId],
      additionalValidWorkspaceKeys: [worktreeWorkspaceKey(worktreeId)]
    }
  )
  expect(store.getState().legacyWorkerResumeFencesByPaneKey).toEqual({
    [pane]: true,
    [sibling]: true
  })
})

it('normalizes old-host records before union with an authoritative new-host empty set', async () => {
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
  await fetchWorkspaceSessionWithRuntimeHostOwners(
    {
      get: async (host) =>
        host
          ? { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: { [pane]: record } }
          : { ...getDefaultWorkspaceSession(), legacyWorkerResumeFencesByPaneKey: {} }
    },
    [],
    ['runtime:old-host']
  )
  expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey[pane]).toBe(true)
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
