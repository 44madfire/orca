import { expect, it } from 'vitest'
import type { RuntimeTerminalOrphanAdoptionRequest } from '../../shared/runtime-types'
import { validateRuntimeTerminalOrphanTopology } from './runtime-terminal-orphan-topology-validation'

function fixture(count: number): RuntimeTerminalOrphanAdoptionRequest {
  const ids = Array.from({ length: count }, (_, index) => `tab-${index}`)
  return {
    worktree: 'folder-workspace',
    expectedTopologyRevision: 1,
    claims: ids.map((tabId) => ({
      tabId,
      leafId: tabId,
      terminal: tabId,
      ptyId: tabId,
      incarnationId: tabId
    })) as RuntimeTerminalOrphanAdoptionRequest['claims'],
    topology: {
      tabs: ids.map((tabId) => ({
        tabId,
        root: { type: 'leaf', leafId: tabId },
        activeLeafId: tabId,
        expandedLeafId: null
      })),
      groups: [{ id: 'g', activeTabId: ids[0], tabOrder: ids, recentTabIds: ids.toReversed() }]
    }
  }
}

it('validates large restored MRU lists with linear tab-order reads', () => {
  const request = fixture(1000)
  let reads = 0
  const group = request.topology!.groups[0]
  group.tabOrder = new Proxy(group.tabOrder, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
  expect(
    validateRuntimeTerminalOrphanTopology(
      request,
      request.claims.map((claim) => ({ claim }))
    ).topologyTabsById.size
  ).toBe(1000)
  expect(reads).toBeLessThanOrEqual(3000)
})

it.each(['duplicate', 'foreign-recent', 'foreign-active'])(
  'rejects %s group membership',
  (kind) => {
    const request = fixture(2)
    const group = request.topology!.groups[0]
    if (kind === 'duplicate') {
      group.tabOrder.push(group.tabOrder[0])
    }
    if (kind === 'foreign-recent') {
      group.recentTabIds = ['foreign']
    }
    if (kind === 'foreign-active') {
      group.activeTabId = 'foreign'
    }
    expect(() =>
      validateRuntimeTerminalOrphanTopology(
        request,
        request.claims.map((claim) => ({ claim }))
      )
    ).toThrow('terminal_orphan_topology_invalid')
  }
)
