import { expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { createNativeChatMessageListProjection } from './native-chat-message-list-projection'
import { orderNativeChatMessages } from './native-chat-message-grouping'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages } from './native-chat-tool-fold'

function message(
  id: string,
  timestamp: number,
  blocks: NativeChatMessage['blocks'],
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, timestamp, blocks, role, source: 'transcript' }
}

it('retains settled folded runs while exposing changed tools, metadata, and attribution boundaries', () => {
  const project = createNativeChatMessageListProjection()
  const prose = message('prose', 1, [{ type: 'text', text: 'Inspecting the workspace' }])
  const call = message('call', 2, [{ type: 'tool-call', name: 'shell', input: { command: 'pwd' } }])
  const result = message('result', 3, [{ type: 'tool-result', output: '/workspace' }], 'tool')
  const prompt = message('prompt', 4, [{ type: 'text', text: 'Next task' }], 'user')
  const tail = message('tail', 5, [{ type: 'text', text: 'Answer' }])
  const initial = project([prose, call, result, prompt, tail])
  expect(project([prose, call, result, prompt, tail])).toBe(initial)
  const streamed = project([
    prose,
    call,
    result,
    prompt,
    { ...tail, blocks: [{ type: 'text', text: 'Answer grows' }] }
  ])
  expect(streamed[0]).toBe(initial[0])
  expect(streamed.at(-1)).not.toBe(initial.at(-1))

  const lateResult = { ...result, blocks: [{ type: 'tool-result' as const, output: '/different' }] }
  const interruption = message(
    'interrupt',
    2.5,
    [{ type: 'text', text: '[Request interrupted by user]' }],
    'user'
  )
  const earlier = message('earlier', 0, [{ type: 'text', text: 'Earlier task' }], 'user')
  const scenarios = [
    [prose, call, lateResult, prompt, tail],
    [prose, call, interruption, result, prompt, tail],
    [tail, result, prompt, call, prose, earlier],
    [prose, result, prompt, tail],
    [prose, call, result],
    [{ ...prose, source: 'hook' as const, turnId: 'different' }, call, result],
    [{ ...prose, timestamp: 4 }, call, result, prompt, tail],
    structuredClone([prose, call, result, prompt, tail]),
    []
  ]
  for (const messages of scenarios) {
    expect(project(messages)).toEqual(
      stripNoiseMessages(foldToolMessages(orderNativeChatMessages(messages)))
    )
  }
  expect(project([prose, call, result])[0]).not.toBe(initial[0])
})
