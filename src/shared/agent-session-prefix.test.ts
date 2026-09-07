import { describe, expect, it } from 'vitest'
import { selectAgentSessionPrefix, structuredForkEligibleItems } from './agent-session-prefix'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  AGENT_SESSION_PREFIX_MAX_BYTES,
  AGENT_SESSION_PREFIX_MAX_ENTRIES,
  agentSessionPrefixWithinBounds
} from './agent-session-prefix-bounds'

function items(provider: 'claude' | 'codex'): AgentJournalRenderItem[] {
  return ['a', 'b'].flatMap(
    (turnId, turn) =>
      [
        {
          itemId:
            provider === 'codex' ? `codex:parent:${turnId}:0` : `claude:parent:${turnId}-prompt`,
          body: { kind: 'message', role: 'user', blocks: [] },
          sequence: turn * 3,
          observedAt: 1
        },
        {
          itemId:
            provider === 'codex' ? `codex:parent:${turnId}:1` : `claude:parent:${turnId}-answer`,
          body: { kind: 'message', role: 'assistant', blocks: [] },
          sequence: turn * 3 + 1,
          observedAt: 1
        },
        {
          itemId: `orca:${turnId}`,
          body: { kind: 'status', text: 'Done', turnLifecycle: { turnId, state: 'completed' } },
          sequence: turn * 3 + 2,
          observedAt: 1
        }
      ] as AgentJournalRenderItem[]
  )
}

describe('bounded conversation prefix', () => {
  it.each(['claude', 'codex'] as const)(
    'retains the selected %s turn inclusively and excludes the later turn',
    (provider) => {
      const history = items(provider)
      const handle =
        provider === 'codex'
          ? ({ provider, threadId: 'parent' } as const)
          : ({ provider, sessionId: 'parent', leafUuid: 'b-answer' } as const)
      const result = selectAgentSessionPrefix({
        items: history,
        itemId: history[1]!.itemId,
        handle,
        boundary: 'through'
      })
      expect(result).toMatchObject({ ok: true, throughId: provider === 'codex' ? 'a' : 'a-answer' })
      if (result.ok) {
        expect(result.retained.map((item) => item.itemId)).toEqual(
          history.slice(0, 3).map((item) => item.itemId)
        )
      }
      expect(structuredForkEligibleItems(history)).toEqual(
        new Set([history[1]!.itemId, history[4]!.itemId])
      )
    }
  )

  it('preserves rewind boundaries for a whole Codex turn and a Claude item', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const history = items(provider)
      const handle =
        provider === 'codex'
          ? ({ provider, threadId: 'parent' } as const)
          : ({ provider, sessionId: 'parent', leafUuid: 'b-answer' } as const)
      const result = selectAgentSessionPrefix({
        items: history,
        itemId: history[4]!.itemId,
        handle,
        boundary: 'before'
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.retained).toHaveLength(provider === 'codex' ? 3 : 4)
      }
    }
  })

  it('refuses missing, foreign, and unfinished targets', () => {
    const history = items('codex')
    const args = {
      items: history,
      itemId: history[1]!.itemId,
      handle: { provider: 'codex', threadId: 'parent' },
      boundary: 'through'
    } as const
    expect(selectAgentSessionPrefix({ ...args, itemId: 'missing' })).toMatchObject({
      ok: false,
      reason: 'invalid-target'
    })
    expect(
      selectAgentSessionPrefix({ ...args, handle: { provider: 'codex', threadId: 'foreign' } })
    ).toMatchObject({ ok: false, reason: 'invalid-target' })
    history[2]!.body = {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'a', state: 'running' }
    }
    expect(selectAgentSessionPrefix(args)).toMatchObject({ ok: false, reason: 'busy' })
    expect(structuredForkEligibleItems(history).has(history[1]!.itemId)).toBe(false)
  })

  it('inherits the retained entry and UTF-8 byte bounds', () => {
    expect(
      agentSessionPrefixWithinBounds(Array(AGENT_SESSION_PREFIX_MAX_ENTRIES + 1).fill(null))
    ).toBe(false)
    expect(agentSessionPrefixWithinBounds(['é'.repeat(AGENT_SESSION_PREFIX_MAX_BYTES / 2)])).toBe(
      false
    )
  })
})
