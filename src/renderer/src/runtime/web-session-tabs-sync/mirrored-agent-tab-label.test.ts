import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { Tab } from '../../../../shared/tab-types'
import { buildMirroredAgentTabs } from './terminal-surfaces'

const WORKTREE = 'repo-1::worktree-1'
const GROUP = 'group-1'

function snapshotWith(agent: 'claude' | 'codex', title: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: GROUP,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'host-tab-1',
        title,
        sessionId: `${agent}-1`,
        agent,
        isActive: false
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function build(
  snapshot: RuntimeMobileSessionTabsResult,
  currentUnifiedTabs: readonly Tab[] = []
): Tab {
  const [mirrored] = buildMirroredAgentTabs(
    snapshot,
    new Map(),
    GROUP,
    0,
    currentUnifiedTabs,
    1_000
  )
  return mirrored.unifiedTab
}

describe('buildMirroredAgentTabs', () => {
  it('falls back to the agent-specific placeholder when the host publishes no title', () => {
    expect(build(snapshotWith('claude', '')).label).toBe('Claude Chat')
    expect(build(snapshotWith('codex', '   ')).label).toBe('Codex Chat')
  })

  it('prefers the host title over the placeholder', () => {
    expect(build(snapshotWith('claude', 'Flaky retry test')).label).toBe('Flaky retry test')
  })

  it('keeps a manual rename across host snapshots', () => {
    const snapshot = snapshotWith('codex', 'Codex Chat')
    const renamed = build(snapshot)
    const existing: Tab = { ...renamed, customLabel: 'My rename' }
    expect(build(snapshot, [existing]).customLabel).toBe('My rename')
  })

  it('leaves customLabel null when the tab was never renamed', () => {
    expect(build(snapshotWith('codex', 'Codex Chat')).customLabel).toBeNull()
  })
})
