import {
  normalizeNativeChatTaskList,
  type NativeChatTaskList
} from '../../../../shared/native-chat-task-list'
import type { NativeChatBlock, NativeChatMessage } from '../../../../shared/native-chat-types'
import { pairToolBlocks } from './native-chat-tool-fold'

const projections = new WeakMap<
  NativeChatMessage,
  { message: NativeChatMessage; list: NativeChatTaskList | null }
>()

function projectMessage(message: NativeChatMessage): {
  message: NativeChatMessage
  list: NativeChatTaskList | null
} {
  const cached = projections.get(message)
  if (cached) {
    return cached
  }
  let list: NativeChatTaskList | null = null
  const consumed = new Set<NativeChatBlock>()
  if (message.role === 'assistant') {
    for (const { call, result } of pairToolBlocks(message.blocks)) {
      if (!call || call.state === 'failed' || result?.isError) {
        continue
      }
      const snapshot = normalizeNativeChatTaskList(call.name, call.input)
      if (!snapshot) {
        continue
      }
      list = snapshot
      consumed.add(call)
      if (result) {
        consumed.add(result)
      }
    }
  }
  const projection = {
    message: consumed.size
      ? { ...message, blocks: message.blocks.filter((block) => !consumed.has(block)) }
      : message,
    list
  }
  projections.set(message, projection)
  return projection
}

/** Task updates are session chrome; keep provider history intact for replay. */
export function nativeChatTaskListState(messages: readonly NativeChatMessage[]): {
  messages: NativeChatMessage[]
  list: NativeChatTaskList | null
} {
  let list: NativeChatTaskList | null = null
  for (const message of messages) {
    const projection = projectMessage(message)
    if (projection.list) list = projection.list
  }
  return { messages: [...messages], list }
}
