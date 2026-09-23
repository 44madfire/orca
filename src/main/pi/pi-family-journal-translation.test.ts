// Shared Pi-family journal translation tests (PIF-5, 44madfire/orca#26).
//
// One translator owns the common message/reasoning/tool semantics for both
// providers: the same wire vectors run for Pi and OMP wherever the shape is
// shared, and provider-specific rows exist only for genuine dialect points
// (terminal settlement, OMP-only async records). No live LLM or network.

import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { resolvePiFamilyFlavor } from './pi-family-flavor'
import { applyPiSessionEvent, createPiTurnBuffer } from './pi-event-journal'
import type { PiFamilyProvider } from './rpc/pi-family-rpc-types'
import {
  extractPiFamilyRecordFact,
  mapPiFamilyRecordToSessionEvents
} from './translation/pi-family-record-dialect'
import { PiTranslator } from './translation/pi-turn-translator'

const PROVIDERS = ['pi', 'omp'] as const

type Row = { identityKey: string; identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

function capturingSink(rows: Row[], activity: { current: unknown }): StructuredAgentSessionEventSink {
  return {
    appendItem: (identity, body) => {
      rows.push({ identityKey: agentJournalItemKey(identity), identity, body })
    },
    appendTombstone: () => undefined,
    publish: () => undefined,
    setActivity: (next) => {
      activity.current = next
    }
  }
}

function driveRecords(
  records: Record<string, unknown>[],
  provider: PiFamilyProvider,
  rows: Row[],
  activity: { current: unknown }
): void {
  const sink = capturingSink(rows, activity)
  const translator = new PiTranslator()
  const turn = createPiTurnBuffer()
  const promptTracker = new Map<string, { sessionId: string; requestId: string }>()
  for (const record of records) {
    for (const event of translator.applyPiRecord(record, provider)) {
      applyPiSessionEvent({
        sink,
        orcaSessionId: 'ses-1',
        opId: 'op-1',
        turn,
        event,
        promptTracker,
        provider
      })
    }
  }
}

function textRecords(text: string): Record<string, unknown>[] {
  const mid = Math.max(1, Math.floor(text.length / 2))
  return [
    { type: 'message_update', assistantMessageEvent: { kind: 'text_start', contentIndex: 0 } },
    { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: text.slice(0, mid) } },
    { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: text.slice(mid) } },
    { type: 'message_update', assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: text } }
  ]
}

function assistantRows(rows: Row[]): Row[] {
  return rows.filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
}

function messageText(body: AgentJournalItemBody): string {
  if (body.kind !== 'message') {
    throw new Error('expected a message row')
  }
  return body.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

describe.each(PROVIDERS)('Pi-family shared text streaming (%s)', (provider) => {
  it('streams start/deltas/end into one final assistant item', () => {
    const rows: Row[] = []
    driveRecords(textRecords('hello world'), provider, rows, { current: null })
    const assistant = assistantRows(rows)
    expect(assistant.length).toBeGreaterThanOrEqual(2)
    const keys = new Set(assistant.map((row) => row.identityKey))
    expect(keys.size).toBe(1)
    expect(messageText(assistant.at(-1)!.body)).toBe('hello world')
  })

  it('treats the final frame as authoritative, never a duplicate append', () => {
    const rows: Row[] = []
    driveRecords(
      [
        { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'hel' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'lo' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: 'hello!' } }
      ],
      provider,
      rows,
      { current: null }
    )
    const assistant = assistantRows(rows)
    expect(new Set(assistant.map((row) => row.identityKey)).size).toBe(1)
    expect(messageText(assistant.at(-1)!.body)).toBe('hello!')
  })

  it('keeps concurrent content parts on separate rows', () => {
    const rows: Row[] = []
    driveRecords(
      [
        { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'a' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 1, delta: 'b' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: 'a' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'text_end', contentIndex: 1, content: 'b' } }
      ],
      provider,
      rows,
      { current: null }
    )
    expect(new Set(assistantRows(rows).map((row) => row.identityKey)).size).toBe(2)
  })
})

describe.each(PROVIDERS)('Pi-family shared reasoning (%s)', (provider) => {
  it('updates one reasoning row and never collides with answer identity', () => {
    const rows: Row[] = []
    driveRecords(
      [
        { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'answer' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'thinking_delta', contentIndex: 0, delta: 'hmm ' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'thinking_delta', contentIndex: 0, delta: 'ok' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'thinking_end', contentIndex: 0, content: 'hmm ok' } },
        { type: 'message_update', assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: 'answer' } }
      ],
      provider,
      rows,
      { current: null }
    )
    const reasoning = rows.filter((row) => row.body.kind === 'message' && row.body.role === 'reasoning')
    expect(new Set(reasoning.map((row) => row.identityKey)).size).toBe(1)
    expect(messageText(reasoning.at(-1)!.body)).toBe('hmm ok')
    const answerKeys = new Set(assistantRows(rows).map((row) => row.identityKey))
    for (const key of reasoning.map((row) => row.identityKey)) {
      expect(answerKeys.has(key)).toBe(false)
    }
  })

  it('creates no junk row for empty terminal reasoning', () => {
    const rows: Row[] = []
    driveRecords(
      [
        { type: 'message_update', assistantMessageEvent: { kind: 'thinking_start', contentIndex: 2 } },
        { type: 'message_update', assistantMessageEvent: { kind: 'thinking_end', contentIndex: 2 } }
      ],
      provider,
      rows,
      { current: null }
    )
    expect(rows).toHaveLength(0)
  })
})

describe.each(PROVIDERS)('Pi-family shared tools (%s)', (provider) => {
  function toolRecords(callId: string, output: string): Record<string, unknown>[] {
    return [
      { type: 'tool_execution_start', toolCallId: callId, toolName: 'read', args: { path: 'a' } },
      { type: 'tool_execution_update', toolCallId: callId, toolName: 'read', partialResult: output.slice(0, 2) },
      { type: 'tool_execution_end', toolCallId: callId, toolName: 'read', result: output, isError: false }
    ]
  }

  it('maps start/progress/end into one stable tool-call row', () => {
    const rows: Row[] = []
    driveRecords(toolRecords('call-1', 'file-bytes'), provider, rows, { current: null })
    const tools = rows.filter((row) => row.body.kind === 'tool-call')
    expect(tools).toHaveLength(3)
    expect(new Set(tools.map((row) => row.identityKey)).size).toBe(1)
    const end = tools.at(-1)!.body
    if (end.kind !== 'tool-call') {
      throw new Error('expected a tool-call row')
    }
    expect(end.state).toBe('completed')
  })

  it('replaces cumulative progress instead of appending it', () => {
    const rows: Row[] = []
    driveRecords(
      [
        { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'run', args: {} },
        { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'run', partialResult: 'v1' },
        { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'run', partialResult: 'v1+v2' },
        { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'run', result: 'v1+v2', isError: false }
      ],
      provider,
      rows,
      { current: null }
    )
    const tools = rows.filter((row) => row.body.kind === 'tool-call')
    expect(tools).toHaveLength(4)
    expect(new Set(tools.map((row) => row.identityKey)).size).toBe(1)
    const firstProgress = tools[1]!.body
    const latestProgress = tools[2]!.body
    const end = tools[3]!.body
    if (firstProgress.kind !== 'tool-call' || latestProgress.kind !== 'tool-call' || end.kind !== 'tool-call') {
      throw new Error('expected tool-call rows')
    }
    expect(firstProgress.output).toMatchObject({ head: 'v1' })
    expect(latestProgress.output).toMatchObject({ head: 'v1+v2' })
    expect(end.output).toMatchObject({ head: 'v1+v2' })
  })

  it('keeps concurrent tool ids on separate rows', () => {
    const rows: Row[] = []
    driveRecords(
      [
        ...toolRecords('call-a', 'out-a'),
        ...toolRecords('call-b', 'out-b')
      ],
      provider,
      rows,
      { current: null }
    )
    const tools = rows.filter((row) => row.body.kind === 'tool-call')
    expect(new Set(tools.map((row) => row.identityKey)).size).toBe(2)
  })

  it('bounds oversized input and output with existing journal limits', () => {
    const rows: Row[] = []
    const large = 'x'.repeat(DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes * 2)
    driveRecords(
      [
        { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { payload: large } },
        { type: 'tool_execution_update', toolCallId: 'call-1', toolName: 'read', partialResult: large },
        { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'read', result: large, isError: false }
      ],
      provider,
      rows,
      { current: null }
    )
    const tools = rows.filter((row) => row.body.kind === 'tool-call')
    expect(tools).toHaveLength(3)
    for (const row of tools) {
      const body = row.body
      if (body.kind !== 'tool-call') {
        throw new Error('expected a tool-call row')
      }
      expect(body.input).toMatchObject({ truncated: true, digest: expect.any(String) })
    }
    for (const row of tools.slice(1)) {
      const body = row.body
      if (body.kind !== 'tool-call') {
        throw new Error('expected a tool-call row')
      }
      expect(body.output).toMatchObject({ truncated: true, digest: expect.any(String) })
      expect(Buffer.byteLength(body.output!.head, 'utf8')).toBeLessThanOrEqual(
        DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes
      )
    }
  })
})

describe('Pi-family settlement dialect', () => {
  it('settles Pi only on agent_settled, never on low-level events', () => {
    expect(mapPiFamilyRecordToSessionEvents({ type: 'agent_settled', willRetry: false }, 'pi')).toEqual([
      { type: 'settled', willRetry: false }
    ])
    expect(mapPiFamilyRecordToSessionEvents({ type: 'agent_end', isTerminal: true }, 'pi')).toEqual([])
    expect(
      mapPiFamilyRecordToSessionEvents({ type: 'turn_end', message: { stopReason: 'stop' } }, 'pi')
    ).toEqual([{ type: 'turn_end', stopReason: 'stop' }])
    expect(
      mapPiFamilyRecordToSessionEvents(
        { type: 'message_update', assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'x' } },
        'pi'
      )
    ).toHaveLength(1)
  })

  it('settles OMP on terminal agent_end and keeps non-terminal turns active', () => {
    expect(mapPiFamilyRecordToSessionEvents({ type: 'agent_end', isTerminal: true }, 'omp')).toEqual([
      { type: 'settled' }
    ])
    expect(mapPiFamilyRecordToSessionEvents({ type: 'agent_end' }, 'omp')).toEqual([{ type: 'settled' }])
    expect(mapPiFamilyRecordToSessionEvents({ type: 'agent_end', isTerminal: false }, 'omp')).toEqual([])
  })

  it('agrees with the flavor predicate on every settle shape', () => {
    const settledRecords: { record: Record<string, unknown>; provider: PiFamilyProvider; settled: boolean }[] = [
      { record: { type: 'agent_settled' }, provider: 'pi', settled: true },
      { record: { type: 'turn_end' }, provider: 'pi', settled: false },
      { record: { type: 'agent_end', isTerminal: true }, provider: 'omp', settled: true },
      { record: { type: 'agent_end' }, provider: 'omp', settled: true },
      { record: { type: 'agent_end', isTerminal: false }, provider: 'omp', settled: false }
    ]
    for (const { record, provider, settled } of settledRecords) {
      const flavor = resolvePiFamilyFlavor(provider)
      expect(
        flavor.isSettled({ type: String(record['type']), isTerminal: record['isTerminal'] })
      ).toBe(settled)
      const mapped = mapPiFamilyRecordToSessionEvents(record, provider)
      expect(mapped.some((event) => event.type === 'settled')).toBe(settled)
    }
  })
})

describe('Pi-family OMP-only async records', () => {
  it('hands prompt results to the owning subsystem without journaling them', () => {
    expect(extractPiFamilyRecordFact({ type: 'prompt_result', id: 'r1', agentInvoked: true })).toEqual({
      kind: 'prompt-result',
      agentInvoked: true
    })
    expect(extractPiFamilyRecordFact({ type: 'prompt_result', id: 'r2', agentInvoked: false })).toEqual({
      kind: 'prompt-result',
      agentInvoked: false
    })
    expect(mapPiFamilyRecordToSessionEvents({ type: 'prompt_result', agentInvoked: true }, 'omp')).toEqual([])
    const rows: Row[] = []
    driveRecords([{ type: 'prompt_result', id: 'r1', agentInvoked: true }], 'omp', rows, { current: null })
    expect(rows).toHaveLength(0)
  })

  it('hands command updates to the owning subsystem as bounded counts', () => {
    expect(
      extractPiFamilyRecordFact({
        type: 'available_commands_update',
        commands: [{ name: 'a' }, { name: 'b' }]
      })
    ).toEqual({ kind: 'commands-update', count: 2 })
    expect(mapPiFamilyRecordToSessionEvents({ type: 'available_commands_update', commands: [] }, 'omp')).toEqual(
      []
    )
  })

  it('ignores host-tool, URI, subagent, notice, and protocol records without persisting them', () => {
    const extras: Record<string, unknown>[] = [
      { type: 'host_tool_call', toolCallId: 'ht-1', toolName: 'x' },
      { type: 'host_tool_result', toolCallId: 'ht-1' },
      { type: 'host_uri_request', id: 'u-1', uri: 'https://example.invalid' },
      { type: 'subagent_lifecycle', payload: { id: 'child-1' } },
      { type: 'subagent_event', payload: { text: 'child says hi' } },
      { type: 'notice', message: 'maintenance window' },
      { type: 'session_info_update', name: 'renamed' },
      { type: 'config_update', key: 'theme' },
      { type: 'command_output', text: 'output bytes' },
      { type: 'omp_future_xyz', future: true }
    ]
    for (const record of extras) {
      expect(extractPiFamilyRecordFact(record)).toBeNull()
      expect(mapPiFamilyRecordToSessionEvents(record, 'omp')).toEqual([])
    }
    const rows: Row[] = []
    driveRecords(extras, 'omp', rows, { current: null })
    expect(rows).toHaveLength(0)
  })
})

describe('Pi-family provider errors', () => {
  it('maps failures to bounded generic rows without leaking payloads', () => {
    const secret = 'sk-proj-abcdef1234567890 /home/fixtureuser/secret prompt bytes'
    for (const record of [
      { type: 'error', code: 'AUTH_FAILED', message: secret },
      { type: 'extension_error', message: secret, detail: { prompt: secret } }
    ]) {
      const events = mapPiFamilyRecordToSessionEvents(record, 'omp')
      expect(events).toHaveLength(1)
      const event = events[0]
      if (!event || event.type !== 'error') {
        throw new Error('expected an error event')
      }
      expect(JSON.stringify(event)).not.toContain('sk-proj')
      const rows: Row[] = []
      driveRecords([record], 'omp', rows, { current: null })
      expect(rows).toHaveLength(1)
      expect(rows[0]!.body).toMatchObject({ kind: 'status' })
      expect(JSON.stringify(rows)).not.toContain('sk-proj')
      expect(JSON.stringify(rows)).not.toContain('fixtureuser')
    }
  })

  it('keeps the error code for actionable diagnostics', () => {
    const events = mapPiFamilyRecordToSessionEvents({ type: 'error', code: 'AUTH_FAILED' }, 'pi')
    expect(events).toEqual([{ type: 'error', code: 'AUTH_FAILED', message: 'provider dispatch failed' }])
  })
})

describe('Pi-family journal provider identity', () => {
  it('carries the discriminant on journal rows instead of a fixed agent', () => {
    for (const provider of PROVIDERS) {
      const rows: Row[] = []
      driveRecords(textRecords('hi'), provider, rows, { current: null })
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        const identity = row.identity
        if (identity.provider !== 'legacy') {
          throw new Error('expected a legacy journal identity')
        }
        expect(identity.agent).toBe(provider)
      }
    }
  })
})
