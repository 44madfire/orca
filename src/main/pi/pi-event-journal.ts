// Pi session events → journal appends + Native Chat renders (SNC1.9).
//
// Renders one Pi turn through Orca's existing shared Native Chat UI with no
// renderer fork: assistant text streams as message bubbles, thinking as the
// reasoning channel, tools as tool-call cards, and Pi dialogs as the normal
// approval/question affordances. Journal identities use the `legacy` provider
// with agent `pi` (Pi entry ids are stable per session but not journal keys;
// the recordId names the turn-scoped row so retries reconcile by key).

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundPayload,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { PiSessionEvent } from './translation/pi-session-events'

export const PI_JOURNAL_AGENT = 'pi'

type PiTurnBuffer = {
  textByIndex: Map<number, string>
  thinkingByIndex: Map<number, string>
  tools: Map<
    string,
    { name: string; input: unknown; output: string; done: boolean; isError: boolean }
  >
}

function newTurnBuffer(): PiTurnBuffer {
  return { textByIndex: new Map(), thinkingByIndex: new Map(), tools: new Map() }
}

function messageIdentity(
  orcaSessionId: string,
  recordId: string
): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: PI_JOURNAL_AGENT, sessionId: orcaSessionId, recordId }
}

/** Tracks Pi dialog requests journaled as prompt items so answers route exactly once. */
export type PiPromptTracker = Map<string, { sessionId: string; requestId: string }>

export function applyPiSessionEvent(input: {
  sink: StructuredAgentSessionEventSink
  orcaSessionId: string
  opId: string
  turn: PiTurnBuffer
  event: PiSessionEvent
  promptTracker: PiPromptTracker
}): void {
  const { sink, orcaSessionId, opId, turn, event, promptTracker } = input
  switch (event.type) {
    case 'turn_start': {
      sink.setActivity?.({ turnId: opId, text: '' })
      sink.publish()
      break
    }
    case 'text_start': {
      const index = event.contentIndex ?? 0
      if (!turn.textByIndex.has(index)) {
        turn.textByIndex.set(index, '')
      }
      break
    }
    case 'text_delta': {
      const index = event.contentIndex ?? 0
      const next = (turn.textByIndex.get(index) ?? '') + event.delta
      turn.textByIndex.set(index, next)
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-text-${index}`), {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: next }]
      })
      sink.setActivity?.({ turnId: opId, text: next.slice(-280) })
      sink.publish()
      break
    }
    case 'text_end': {
      const index = event.contentIndex ?? 0
      const finalText = event.text ?? turn.textByIndex.get(index) ?? ''
      turn.textByIndex.set(index, finalText)
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-text-${index}`), {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: finalText }]
      })
      sink.publish()
      break
    }
    case 'thinking_start': {
      break
    }
    case 'thinking_delta': {
      const index = event.contentIndex ?? 0
      const next = (turn.thinkingByIndex.get(index) ?? '') + event.delta
      turn.thinkingByIndex.set(index, next)
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-thinking-${index}`), {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: next }]
      })
      sink.publish()
      break
    }
    case 'thinking_end': {
      const index = event.contentIndex ?? 0
      const finalText = event.thinking ?? turn.thinkingByIndex.get(index) ?? ''
      turn.thinkingByIndex.set(index, finalText)
      if (finalText === '') {
        break
      }
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-thinking-${index}`), {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: finalText }]
      })
      sink.publish()
      break
    }
    case 'tool_start': {
      const input = boundToolInput(event.args ?? {}, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
      turn.tools.set(event.toolCallId, {
        name: event.toolName,
        input,
        output: '',
        done: false,
        isError: false
      })
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-tool-${event.toolCallId}`), {
        kind: 'tool-call',
        name: event.toolName,
        input,
        state: 'running'
      })
      sink.publish()
      break
    }
    case 'tool_progress': {
      const tool = turn.tools.get(event.toolCallId)
      if (tool) {
        tool.output = event.partialResult
      }
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-tool-${event.toolCallId}`), {
        kind: 'tool-call',
        name: tool?.name ?? 'tool',
        input: tool?.input ?? {},
        state: 'running',
        output: boundPayload(event.partialResult, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
      })
      sink.publish()
      break
    }
    case 'tool_end': {
      const tool = turn.tools.get(event.toolCallId)
      if (tool) {
        tool.output = event.result
        tool.done = true
        tool.isError = event.isError
      }
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-tool-${event.toolCallId}`), {
        kind: 'tool-call',
        name: tool?.name ?? 'tool',
        input: tool?.input ?? {},
        state: event.isError ? 'failed' : 'completed',
        output: boundPayload(event.result, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
      })
      sink.publish()
      break
    }
    case 'prompt_request': {
      const prompt = event.prompt
      let body: AgentJournalItemBody
      if (prompt.kind === 'confirm') {
        body = {
          kind: 'approval',
          title: prompt.title,
          detail: prompt.message,
          options: [
            { id: 'confirm', label: 'Confirm' },
            { id: 'cancel', label: 'Cancel' }
          ],
          resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
        }
      } else if (prompt.kind === 'select') {
        body = {
          kind: 'question',
          question: prompt.title,
          options: prompt.options.map((option) => ({ id: option, label: option })),
          resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
        }
      } else {
        body = {
          kind: 'question',
          question: prompt.title,
          options: [{ id: 'submit', label: 'Submit' }],
          freeTextQuestionId: 'input',
          resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
        }
      }
      const identity = messageIdentity(orcaSessionId, `${opId}-prompt-${event.requestId}`)
      sink.appendItem(identity, body)
      sink.publish()
      promptTracker.set(agentJournalItemKey(identity), {
        sessionId: orcaSessionId,
        requestId: event.requestId
      })
      break
    }
    case 'turn_end': {
      if (event.stopReason === 'error') {
        sink.appendItem(messageIdentity(orcaSessionId, `${opId}-error`), {
          kind: 'status',
          text: 'provider dispatch failed'
        })
      }
      sink.publish()
      break
    }
    case 'settled': {
      sink.setActivity?.(null)
      sink.publish()
      break
    }
    case 'error': {
      sink.appendItem(messageIdentity(orcaSessionId, `${opId}-pi-error`), {
        kind: 'status',
        text: 'provider dispatch failed'
      })
      sink.publish()
      break
    }
  }
}

export function createPiTurnBuffer(): PiTurnBuffer {
  return newTurnBuffer()
}
