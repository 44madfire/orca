import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from './runtime-authored-workspace-session-fields'

const row = {
  v: 1 as const,
  browserPageId: 'page-a',
  workspaceId: 'repo-1::wt-a',
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-a:1',
  url: 'https://kept.internal/',
  title: 'Kept',
  pairedDeviceId: 'device-a',
  savedAt: 1_800_000_000_000
}

describe('preserving runtime-authored workspace session fields', () => {
  it('carries the rows across a write that never mentions them', () => {
    // The desktop renderer builds its payload from Zustand, which has no idea the runtime
    // authority sharing this profile persists client-hosted pages.
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      session(),
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
  })

  it('lets the runtime clear its own rows, which it does with an empty map', () => {
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      session({}),
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({})
  })

  it('lets the runtime replace its rows outright', () => {
    const replaced = { 'repo-1::wt-b': [{ ...row, workspaceId: 'repo-1::wt-b' }] }

    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(
        session(replaced),
        session({ 'repo-1::wt-a': [row] })
      ).clientHostedBrowserPagesByWorktree
    ).toEqual(replaced)
  })

  it('treats an explicit undefined as never having mentioned the field', () => {
    // The one ambiguous input: a writer that spreads the field through as undefined is still a
    // writer that knows nothing about it, so it must inherit rather than clear.
    const next = preserveRuntimeAuthoredWorkspaceSessionFields(
      { ...session(), clientHostedBrowserPagesByWorktree: undefined },
      session({ 'repo-1::wt-a': [row] })
    )

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
  })

  // The settled-worker resume fence is the second runtime-authored field, and this is the property
  // the whole design rests on: `sleepingAgentSessionsByPaneKey` is a field the renderer co-authors,
  // so storing the fence there let an ordinary session write erase it on disk. Here the renderer
  // cannot name the field at all, and a write that omits it inherits the runtime's set.
  it('carries the settled-worker resume fences across a renderer write', () => {
    const fences = { 'tab-1:leaf-1': true } as const
    const prior: WorkspaceSessionState = {
      ...session(),
      legacyWorkerResumeFencesByPaneKey: { ...fences }
    }

    const next = preserveRuntimeAuthoredWorkspaceSessionFields(session(), prior)

    expect(next.legacyWorkerResumeFencesByPaneKey).toEqual(fences)
  })

  it('lets the runtime retire a fence by writing an empty set', () => {
    const prior: WorkspaceSessionState = {
      ...session(),
      legacyWorkerResumeFencesByPaneKey: { 'tab-1:leaf-1': true }
    }
    const cleared: WorkspaceSessionState = {
      ...session(),
      legacyWorkerResumeFencesByPaneKey: {}
    }

    expect(
      preserveRuntimeAuthoredWorkspaceSessionFields(cleared, prior)
        .legacyWorkerResumeFencesByPaneKey
    ).toEqual({})
  })

  it('preserves both runtime-authored fields in one write', () => {
    const prior: WorkspaceSessionState = {
      ...session({ 'repo-1::wt-a': [row] }),
      legacyWorkerResumeFencesByPaneKey: { 'tab-1:leaf-1': true }
    }

    const next = preserveRuntimeAuthoredWorkspaceSessionFields(session(), prior)

    expect(next.clientHostedBrowserPagesByWorktree).toEqual({ 'repo-1::wt-a': [row] })
    expect(next.legacyWorkerResumeFencesByPaneKey).toEqual({ 'tab-1:leaf-1': true })
  })

  it('leaves an untouched write alone rather than inventing a field', () => {
    const next = session()

    expect(preserveRuntimeAuthoredWorkspaceSessionFields(next, session())).toBe(next)
    expect(preserveRuntimeAuthoredWorkspaceSessionFields(next, null)).toBe(next)
  })
})

function session(
  clientHostedBrowserPagesByWorktree?: WorkspaceSessionState['clientHostedBrowserPagesByWorktree']
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ...(clientHostedBrowserPagesByWorktree ? { clientHostedBrowserPagesByWorktree } : {})
  }
}
