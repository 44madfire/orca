import { expect, it, vi } from 'vitest'
import { extractPendingAsk } from './native-chat-ask'
import type { NativeChatMessage } from './native-chat-types'

it('replays large call/result batches without shifting outstanding questions', () => {
  const blocks: NativeChatMessage['blocks'] = Array.from({ length: 2000 }, () => ({
    type: 'tool-call',
    name: 'AskUserQuestion',
    input: { questions: [{ question: 'Continue?' }] }
  }))
  blocks.push(
    ...Array.from({ length: 2000 }, () => ({ type: 'tool-result' as const, output: 'yes' }))
  )
  const original = Array.prototype.shift
  let shifted = 0
  const spy = vi.spyOn(Array.prototype, 'shift').mockImplementation(function (this: unknown[]) {
    const first = this[0]
    if (first && typeof first === 'object' && 'questions' in first) {
      shifted += this.length - 1
    }
    return original.call(this)
  })
  let result: ReturnType<typeof extractPendingAsk>
  try {
    result = extractPendingAsk([
      { id: 'm', role: 'assistant', timestamp: 1, source: 'transcript', blocks }
    ])
  } finally {
    spy.mockRestore()
  }
  expect(result!).toBeNull()
  expect(shifted).toBe(0)
})
