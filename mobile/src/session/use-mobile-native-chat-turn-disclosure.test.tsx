import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

function userMessage(id: string, completed = false): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: null,
    source: 'transcript',
    ...(completed
      ? {
          turnTiming: {
            userItemId: id,
            start: { at: 1_000, source: 'provider' as const },
            end: { at: 6_000, source: 'provider' as const }
          }
        }
      : {})
  }
}

function Harness({
  messages,
  enabled,
  isWorking = true,
  scopeKey = 'host\0worktree\0tab-a'
}: {
  messages: readonly NativeChatMessage[]
  enabled: boolean
  isWorking?: boolean
  scopeKey?: string
}): React.JSX.Element {
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled,
    isWorking,
    scopeKey
  })
  return createElement('result', { disclosure })
}

describe('useMobileNativeChatTurnDisclosure', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('does not scan bridge-lane transcripts', () => {
    const messages: NativeChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        blocks: [{ type: 'text', text: 'go' }],
        timestamp: null,
        source: 'transcript'
      }
    ]
    const findLastIndex = vi.spyOn(messages, 'findLastIndex')
    const slice = vi.spyOn(messages, 'slice')
    const filter = vi.spyOn(messages, 'filter')
    const map = vi.spyOn(messages, 'map')

    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: false }))
    })

    expect(findLastIndex).not.toHaveBeenCalled()
    expect(slice).not.toHaveBeenCalled()
    expect(filter).not.toHaveBeenCalled()
    expect(map).not.toHaveBeenCalled()
  })

  it('keeps a settled turn handler stable for NUL-delimited scope keys', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      const messages = [userMessage('u1', true)]
      act(() => {
        renderer = create(createElement(Harness, { messages, enabled: true }))
      })
      vi.setSystemTime(86_400_000)
      act(() => {
        renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
      })
      const first = renderer!.root.findByType('result').props.disclosure.resolveRow(0, messages[0])

      const refreshed = [...messages]
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: refreshed, enabled: true, isWorking: false })
        )
      })
      const second = renderer!.root
        .findByType('result')
        .props.disclosure.resolveRow(0, refreshed[0])

      // The row carries the key; the handler itself lives on the hook and stays
      // stable for the scope, so a re-render never disturbs a row's memo.
      expect(first.turnStatus.workedSeconds).toBe(5)
      expect(second.turnStatus.workedSeconds).toBe(5)
      expect(first.turnKey).toBe('u1')
      expect(second.turnKey).toBe('u1')
      const firstHandler = renderer!.root.findByType('result').props.disclosure.onToggleTurn
      expect(firstHandler).toBeTypeOf('function')
      act(() => {
        renderer?.update(
          createElement(Harness, { messages: [...refreshed], enabled: true, isWorking: false })
        )
      })
      expect(renderer!.root.findByType('result').props.disclosure.onToggleTurn).toBe(firstHandler)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps at most the latest 128 replayed turns expanded', () => {
    const messages = Array.from({ length: 129 }, (_, index) => userMessage(`u${index}`, true))
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true, isWorking: false }))
    })
    for (const [index, message] of messages.entries()) {
      const disclosure = renderer!.root.findByType('result').props.disclosure
      const row = disclosure.resolveRow(index, message)
      expect(row.turnKey).toBe(message.id)
      expect(row.turnStatus.workedSeconds).toBe(5)
      act(() => disclosure.onToggleTurn(row.turnKey))
    }

    const disclosure = renderer!.root.findByType('result').props.disclosure
    const expanded = messages.filter(
      (message, index) => disclosure.resolveRow(index, message).turnExpanded
    )
    expect(expanded).toHaveLength(128)
    expect(disclosure.resolveRow(0, messages[0]).turnExpanded).toBe(false)
    expect(disclosure.resolveRow(128, messages[128]).turnExpanded).toBe(true)
  })

  it('discloses activity under the persisted user turn without expanding the next turn', () => {
    const activity: NativeChatMessage = {
      id: 'tool-1',
      role: 'tool',
      blocks: [{ type: 'tool-call', name: 'Read', input: { path: 'file.ts' }, state: 'completed' }],
      timestamp: null,
      source: 'transcript'
    }
    const messages = [userMessage('u1', true), activity, userMessage('u2', true)]
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true, isWorking: false }))
    })
    const disclosure = renderer!.root.findByType('result').props.disclosure
    act(() => disclosure.onToggleTurn(disclosure.resolveRow(0, messages[0]).turnKey))
    const expanded = renderer!.root.findByType('result').props.disclosure
    expect(expanded.resolveRow(1, activity).turnExpanded).toBe(true)
    expect(expanded.resolveRow(2, messages[2]).turnExpanded).toBe(false)
  })

  it('does not fabricate a duration disclosure when a live turn stops without endpoints', () => {
    const messages = [userMessage('u1')]
    act(() => {
      renderer = create(createElement(Harness, { messages, enabled: true }))
    })
    act(() => {
      renderer?.update(createElement(Harness, { messages, enabled: true, isWorking: false }))
    })
    const row = renderer!.root.findByType('result').props.disclosure.resolveRow(0, messages[0])
    expect(row.turnStatus).toBeNull()
    expect(row.turnKey).toBeUndefined()
    expect(row.activeTurnIsWorking).toBe(false)
  })
})
