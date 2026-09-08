import { describe, expect, it } from 'vitest'
import {
  nativeChatTaskLabel,
  normalizeNativeChatTaskList,
  type NativeChatTask,
  type NativeChatTaskList
} from './native-chat-task-list'

const task = (content: string, status: NativeChatTask['status'] = 'pending'): NativeChatTask => ({
  content,
  status
})
const list = (...tasks: NativeChatTask[]): NativeChatTaskList => ({ tasks })

describe('normalizeNativeChatTaskList', () => {
  it('normalizes Claude tasks and uses activeForm only while in progress', () => {
    const result = normalizeNativeChatTaskList('TodoWrite', {
      todos: [
        { content: 'Read', status: 'completed', activeForm: 'Reading' },
        { content: 'Write', status: 'in_progress', activeForm: 'Writing' },
        { content: 'Test', status: 'pending', activeForm: 'Testing' }
      ]
    })!
    expect(result.tasks.map(nativeChatTaskLabel)).toEqual(['Read', 'Writing', 'Test'])
    expect(result.tasks.map((entry) => entry.status)).toEqual([
      'completed',
      'in_progress',
      'pending'
    ])
  })

  it('normalizes Codex JSON-string arguments and explanation', () => {
    expect(
      normalizeNativeChatTaskList(
        'update_plan',
        JSON.stringify({
          explanation: 'Proceed with verification',
          plan: [{ step: 'Test', status: 'in_progress' }]
        })
      )
    ).toEqual({ explanation: 'Proceed with verification', tasks: [task('Test', 'in_progress')] })
  })

  it('defaults unknown/missing statuses and ignores invalid entries', () => {
    expect(
      normalizeNativeChatTaskList(' TodoWrite ', {
        todos: [
          null,
          [],
          4,
          {},
          { content: ' ' },
          { content: 7 },
          { content: ' One ', status: 'unknown', activeForm: 4 },
          { content: 'Two' }
        ]
      })
    ).toEqual(list(task('One'), task('Two')))
  })

  it.each([undefined, null, 42, [], '{', '{}', { todos: null }, { todos: [{}] }])(
    'returns null for malformed input %j',
    (input) => {
      expect(normalizeNativeChatTaskList('TodoWrite', input)).toBeNull()
    }
  )

  it('keeps empty lists valid and recognizes only exact tool families', () => {
    expect(normalizeNativeChatTaskList('update_plan', { plan: [] })).toEqual(list())
    expect(normalizeNativeChatTaskList('TodoWrite', { todos: [] })).toEqual(list())
    expect(normalizeNativeChatTaskList('mcp__server__TodoWrite', { todos: [] })).toBeNull()
    expect(normalizeNativeChatTaskList('ExitPlanMode', { plan: [] })).toBeNull()
    expect(normalizeNativeChatTaskList('update_plan', { todos: [] })).toBeNull()
  })
})
