// Bridge turn-event translation for the external structured-session adapter.
//
// Split from `external-structured-session-adapter` (line budget): routing provider
// `session_event` records into per-turn buffers and Orca journal appends. Stateless
// over caller-owned maps, so the adapter keeps only a thin routing wrapper.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
} from '../../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../structured-agent-session-event-sink'
import type { BridgeProviderEvent } from './bridge-protocol'
import { EXTERNAL_BRIDGE_AGENT, boundedPayload, type TurnBuffer } from './external-structured-session-payloads'

export function applyBridgeTurnEvent(input: {
  sink: StructuredAgentSessionEventSink
  orcaSessionId: string
  opId: string
  turn: TurnBuffer
  event: BridgeProviderEvent
  promptRequests: Map<string, { sessionId: string; requestId: string }>
}): void {
  const { sink, orcaSessionId, opId, turn, event, promptRequests } = input
  switch (event.type) {
    case 'turn_start': {
      sink.setActivity?.({ turnId: opId, text: '' })
      sink.publish()
      break
    }
    case 'text_start': {
      const index = event.contentIndex ?? 0
      if (!turn.textByIndex.has(index)) {turn.textByIndex.set(index, '')}
      break
    }
    case 'text_delta': {
      const index = event.contentIndex ?? 0
      const next = (turn.textByIndex.get(index) ?? '') + event.delta
      turn.textByIndex.set(index, next)
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-text-${index}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: next }],
      }
      sink.appendItem(identity, body)
      sink.setActivity?.({ turnId: opId, text: next.slice(-280) })
      sink.publish()
      break
    }
    case 'text_end': {
      const index = event.contentIndex ?? 0
      const finalText = event.text ?? turn.textByIndex.get(index) ?? ''
      turn.textByIndex.set(index, finalText)
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-text-${index}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: finalText }],
      }
      sink.appendItem(identity, body)
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
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-thinking-${index}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: next }],
      }
      sink.appendItem(identity, body)
      sink.publish()
      break
    }
    case 'thinking_end': {
      const index = event.contentIndex ?? 0
      const finalText = event.thinking ?? turn.thinkingByIndex.get(index) ?? ''
      turn.thinkingByIndex.set(index, finalText)
      if (finalText === '') {break}
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-thinking-${index}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: finalText }],
      }
      sink.appendItem(identity, body)
      sink.publish()
      break
    }
    case 'tool_start': {
      turn.tools.set(event.toolCallId, {
        name: event.toolName,
        output: '',
        done: false,
        isError: false,
      })
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-tool-${event.toolCallId}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'tool-call',
        name: event.toolName,
        input: event.args ?? {},
        state: 'running',
      }
      sink.appendItem(identity, body)
      sink.publish()
      break
    }
    case 'tool_progress': {
      const tool = turn.tools.get(event.toolCallId)
      if (tool) {tool.output = event.partialResult}
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-tool-${event.toolCallId}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'tool-call',
        name: tool?.name ?? 'tool',
        input: {},
        state: 'running',
        output: boundedPayload(event.partialResult),
      }
      sink.appendItem(identity, body)
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
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-tool-${event.toolCallId}`,
      }
      const body: AgentJournalItemBody = {
        kind: 'tool-call',
        name: tool?.name ?? 'tool',
        input: {},
        state: event.isError ? 'failed' : 'completed',
        output: boundedPayload(event.result),
      }
      sink.appendItem(identity, body)
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
            { id: 'cancel', label: 'Cancel' },
          ],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null,
          },
        }
      } else if (prompt.kind === 'select') {
        body = {
          kind: 'question',
          question: prompt.title,
          options: prompt.options.map((option) => ({ id: option, label: option })),
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null,
          },
        }
      } else {
        body = {
          kind: 'question',
          question: prompt.title,
          options: [{ id: 'submit', label: 'Submit' }],
          freeTextQuestionId: 'input',
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null,
          },
        }
      }
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-prompt-${event.requestId}`,
      }
      sink.appendItem(identity, body)
      sink.publish()
      promptRequests.set(agentJournalItemKey(identity), {
        sessionId: orcaSessionId,
        requestId: event.requestId,
      })
      break
    }
    case 'turn_end': {
      if (event.stopReason === 'error') {
        const identity: AgentJournalItemIdentity = {
          provider: 'legacy',
          agent: EXTERNAL_BRIDGE_AGENT,
          sessionId: orcaSessionId,
          recordId: `${opId}-error`,
        }
        const body: AgentJournalItemBody = {
          kind: 'status',
          text: 'provider dispatch failed',
        }
        sink.appendItem(identity, body)
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
      const identity: AgentJournalItemIdentity = {
        provider: 'legacy',
        agent: EXTERNAL_BRIDGE_AGENT,
        sessionId: orcaSessionId,
        recordId: `${opId}-bridge-error`,
      }
      const body: AgentJournalItemBody = { kind: 'status', text: 'provider dispatch failed' }
      sink.appendItem(identity, body)
      sink.publish()
      break
    }
  }
}
