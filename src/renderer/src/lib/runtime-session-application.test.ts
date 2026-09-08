import { readAndApplyRuntimeSession, applyReadRuntimeSession } from './runtime-session-application'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

it('publishes sleeping records and their authority in a single subscriber notification', () => {
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

it.each(['resolve', 'reject'] as const)(
  'a later refresh can retire hydration after the older read %ss',
  async (outcome) => {
    let settle!: () => void
    const read = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Record<string, true>>((resolve, reject) => {
            settle = () => (outcome === 'resolve' ? resolve({}) : reject(new Error('offline')))
          })
      )
      .mockResolvedValue({})
    vi.stubGlobal('window', { api: { app: { getLegacyWorkerResumeFences: read } } })
    const pending = refreshLegacyWorkerResumeFences()
    useAppStore.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      legacyWorkerResumeFencesByPaneKey: { [pane]: true }
    })
    settle()
    await pending
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [pane]: true })
    await refreshLegacyWorkerResumeFences()
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
  }
)

describe('runtime snapshot interleavings', () => {
  const initial = useAppStore.getState()
  const pane = 'target:11111111-2222-4333-8444-555555555555'
  const sibling = 'sibling:22222222-2222-4333-8444-555555555555'
  const worktreeId = 'folder:legacy'
  const session = (fences: Record<string, true>) => ({
    ...getDefaultWorkspaceSession(),
    legacyWorkerResumeFencesByPaneKey: fences
  })
  const apply = (s: ReturnType<typeof session>) =>
    applyReadRuntimeSession(s, useAppStore.setState, useAppStore.getState)
  function deferred<T>() {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    return { promise, resolve }
  }
  function scoped(fences?: Record<string, true>) {
    const tab = makeTab({ id: 'target', worktreeId })
    useAppStore.setState({ tabsByWorktree: { [worktreeId]: [tab] } })
    useAppStore.getState().hydrateWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        tabsByWorktree: { [worktreeId]: [tab] },
        ...(fences === undefined ? {} : { legacyWorkerResumeFencesByPaneKey: fences })
      },
      { replaceWorkspaceKeys: [worktreeId], additionalValidWorkspaceKeys: [worktreeId] }
    )
  }
  afterEach(() => {
    useAppStore.setState(initial, true)
    vi.unstubAllGlobals()
  })
  it('queued second read begins after hydration and may retire it', async () => {
    const d = deferred<ReturnType<typeof session>>()
    const first = readAndApplyRuntimeSession(() => d.promise, apply)
    const secondRead = vi.fn(async () => session({}))
    const second = readAndApplyRuntimeSession(secondRead, apply)
    scoped({ [pane]: true })
    expect(secondRead).not.toHaveBeenCalled()
    d.resolve(session({ [sibling]: true }))
    await first
    await second
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({})
  })
  it('scoped supersession rejects in-scope update but applies new sibling', async () => {
    const d = deferred<ReturnType<typeof session>>()
    const first = readAndApplyRuntimeSession(() => d.promise, apply)
    scoped({})
    d.resolve(session({ [pane]: true, [sibling]: true }))
    await first
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [sibling]: true })
  })
  it('full supersession remains full after scoped hydration', async () => {
    const d = deferred<ReturnType<typeof session>>()
    const first = readAndApplyRuntimeSession(() => d.promise, apply)
    useAppStore.getState().hydrateWorkspaceSession(session({ [sibling]: true }))
    scoped({ [pane]: true })
    d.resolve(session({}))
    await first
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({
      [pane]: true,
      [sibling]: true
    })
  })
  it('authority-absent SSH hydration must not suppress a runtime acquisition', async () => {
    const d = deferred<Record<string, true>>()
    vi.stubGlobal('window', { api: { app: { getLegacyWorkerResumeFences: () => d.promise } } })
    const first = refreshLegacyWorkerResumeFences()
    scoped()
    d.resolve({ [pane]: true, [sibling]: true })
    await first
    console.log(
      'absent-source acquisition',
      useAppStore.getState().legacyWorkerResumeFencesByPaneKey
    )
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({
      [pane]: true,
      [sibling]: true
    })
  })
  it('discarded authoritative retirement prevents a real resume sweep', async () => {
    const d = deferred<Record<string, true>>()
    vi.stubGlobal('window', { api: { app: { getLegacyWorkerResumeFences: () => d.promise } } })
    const record = {
      paneKey: pane,
      tabId: 'target',
      worktreeId,
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: 'session-legacy' },
      prompt: 'continue',
      state: 'working' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live' as const
    }
    useAppStore.setState({
      legacyWorkerResumeFencesByPaneKey: { [pane]: true },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'target', worktreeId })] }
    })
    const first = refreshLegacyWorkerResumeFences()
    useAppStore
      .getState()
      .hydrateWorkspaceSession(
        { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: { [pane]: record } },
        { replaceWorkspaceKeys: [worktreeId], additionalValidWorkspaceKeys: [worktreeId] }
      )
    d.resolve({})
    await first
    const count = resumeSleepingAgentSessionsForWorktree(worktreeId)
    console.log('retired main, post-reply sweep', {
      count,
      fences: useAppStore.getState().legacyWorkerResumeFencesByPaneKey,
      recordPresent: !!useAppStore.getState().sleepingAgentSessionsByPaneKey[pane]
    })
    expect(count).toBe(1)
  })
  it('a genuinely newer retirement reply is discarded after a stale canonical hydration', async () => {
    const d = deferred<Record<string, true>>()
    vi.stubGlobal('window', { api: { app: { getLegacyWorkerResumeFences: () => d.promise } } })
    // Snapshot captured before the retirement; delivery happens during its invalidation read.
    const old = session({ [pane]: true })
    const first = refreshLegacyWorkerResumeFences()
    useAppStore.getState().hydrateWorkspaceSession(old)
    d.resolve({})
    await first
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [pane]: true })
  })
  it('two overlapping scoped hydrations retain both scopes and accept a third scope reply', async () => {
    const d = deferred<ReturnType<typeof session>>()
    const first = readAndApplyRuntimeSession(() => d.promise, apply)
    scoped({})
    const other = 'folder:other'
    const tab = makeTab({ id: 'sibling', worktreeId: other })
    useAppStore
      .getState()
      .hydrateWorkspaceSession(
        { ...session({}), tabsByWorktree: { [other]: [tab] } },
        { replaceWorkspaceKeys: [other], additionalValidWorkspaceKeys: [other] }
      )
    const third = 'third:33333333-2222-4333-8444-555555555555'
    d.resolve(session({ [pane]: true, [sibling]: true, [third]: true }))
    await first
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [third]: true })
  })
  it('a different runtime host reply overlapping the target tab respects viewer scope and applies its sibling', async () => {
    const { fetchWorkspaceSessionWithRuntimeHostOwners } =
      await import('./workspace-session-host-hydration')
    const d = deferred<ReturnType<typeof session>>()
    let started!: () => void
    const hostStarted = new Promise<void>((r) => (started = r))
    const first = fetchWorkspaceSessionWithRuntimeHostOwners(
      {
        get: async (host) => {
          if (!host) {
            return session({})
          }
          started()
          return d.promise
        }
      },
      [],
      ['runtime:other-host']
    )
    await hostStarted
    scoped({})
    d.resolve(session({ [pane]: true, [sibling]: true }))
    await first
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [sibling]: true })
  })
})

describe('legacy-only hydration authority', () => {
  const workspace = 'folder:legacy'
  const acquired = 'target:33333333-2222-4333-8444-555555555555'
  const retired = 'target:44444444-2222-4333-8444-555555555555'
  const tab = makeTab({ id: 'target', worktreeId: workspace })
  const scopedOptions = {
    replaceWorkspaceKeys: [workspace],
    additionalValidWorkspaceKeys: [workspace]
  } as const
  function legacySession(keys: string[]) {
    return {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [workspace]: [tab] },
      sleepingAgentSessionsByPaneKey: Object.fromEntries(
        keys.map((key) => [
          key,
          {
            paneKey: key,
            tabId: key.split(':')[0],
            worktreeId: workspace,
            agent: 'claude' as const,
            providerSession: { key: 'session_id' as const, id: key },
            prompt: '',
            state: 'working' as const,
            capturedAt: 1,
            updatedAt: 1,
            origin: 'live' as const,
            automaticResumeBlockedBy: 'legacy-orchestration-worker' as const
          }
        ])
      )
    }
  }
  function pendingRefresh() {
    let resolve!: (fences: Record<string, true>) => void
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
    return {
      pending: refreshLegacyWorkerResumeFences(),
      resolve: (fences: Record<string, true>) => resolve(fences)
    }
  }
  it.each([false, true])(
    'protects only supplied panes while allowing same-tab acquisition and retirement (scoped=%s)',
    async (scoped) => {
      useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: { [retired]: true } })
      const read = pendingRefresh()
      useAppStore
        .getState()
        .hydrateWorkspaceSession(legacySession([pane]), scoped ? scopedOptions : undefined)
      read.resolve({ [acquired]: true, [sibling]: true })
      await read.pending
      expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({
        [pane]: true,
        [acquired]: true,
        [sibling]: true
      })
    }
  )
  it('does not supersede a legacy pane outside the hydrated scope', async () => {
    useAppStore.setState({ legacyWorkerResumeFencesByPaneKey: { [sibling]: true } })
    const read = pendingRefresh()
    useAppStore.getState().hydrateWorkspaceSession(legacySession([pane, sibling]), scopedOptions)
    read.resolve({})
    await read.pending
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [pane]: true })
  })
  it('accumulates legacy panes without losing earlier protection', async () => {
    const read = pendingRefresh()
    useAppStore.getState().hydrateWorkspaceSession(legacySession([pane]))
    useAppStore.getState().hydrateWorkspaceSession(legacySession([acquired]))
    read.resolve({})
    await read.pending
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({
      [pane]: true,
      [acquired]: true
    })
  })
  it('lets a later canonical retirement replace earlier legacy protection', async () => {
    const read = pendingRefresh()
    useAppStore.getState().hydrateWorkspaceSession(legacySession([pane]))
    useAppStore
      .getState()
      .hydrateWorkspaceSession(
        { ...legacySession([]), legacyWorkerResumeFencesByPaneKey: {} },
        scopedOptions
      )
    read.resolve({ [pane]: true, [sibling]: true })
    await read.pending
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({ [sibling]: true })
  })
  it('preserves full canonical supersession through a later legacy snapshot', async () => {
    const read = pendingRefresh()
    useAppStore.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      legacyWorkerResumeFencesByPaneKey: { [sibling]: true }
    })
    useAppStore.getState().hydrateWorkspaceSession(legacySession([pane]), scopedOptions)
    read.resolve({})
    await read.pending
    expect(useAppStore.getState().legacyWorkerResumeFencesByPaneKey).toEqual({
      [pane]: true,
      [sibling]: true
    })
  })
})
