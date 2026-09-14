import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { DEFAULT_JOURNAL_PAYLOAD_LIMITS } from '../native-chat/agent-session-journal/journal-payload-bounds'
import { applyPiSessionEvent, createPiTurnBuffer } from './pi-event-journal'

type Row = { body: AgentJournalItemBody }

function testSink(rows: Row[]): StructuredAgentSessionEventSink {
  return {
    appendItem: (_identity, body) => rows.push({ body }),
    appendTombstone: () => undefined,
    publish: () => undefined
  }
}

describe('Pi event journal payload bounds', () => {
  it('bounds tool arguments and partial/final results before journaling', () => {
    const rows: Row[] = []
    const sink = testSink(rows)
    const turn = createPiTurnBuffer()
    const promptTracker = new Map<string, { sessionId: string; requestId: string }>()
    const large = 'x'.repeat(DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes * 2)
    const args = { payload: large }
    const argsBytes = Buffer.byteLength(JSON.stringify(args), 'utf8')

    const apply = (event: Parameters<typeof applyPiSessionEvent>[0]['event']): void => {
      applyPiSessionEvent({
        sink,
        orcaSessionId: 'ses-bounds',
        opId: 'op-bounds',
        turn,
        event,
        promptTracker
      })
    }

    apply({ type: 'tool_start', toolCallId: 'call-1', toolName: 'read', args })
    apply({ type: 'tool_progress', toolCallId: 'call-1', partialResult: large })
    apply({ type: 'tool_end', toolCallId: 'call-1', result: large, isError: false })

    expect(rows).toHaveLength(3)
    const start = rows[0].body
    const progress = rows[1].body
    const end = rows[2].body
    if (start.kind !== 'tool-call' || progress.kind !== 'tool-call' || end.kind !== 'tool-call') {
      throw new Error('expected tool-call rows')
    }
    expect(start.input).toMatchObject({
      head: expect.any(String),
      byteLength: argsBytes,
      digest: expect.any(String),
      truncated: true
    })
    expect(progress.input).toEqual(start.input)
    expect(end.input).toEqual(start.input)
    for (const row of [progress, end]) {
      expect(row.output).toMatchObject({
        head: expect.any(String),
        byteLength: Buffer.byteLength(large, 'utf8'),
        digest: expect.any(String),
        truncated: true
      })
      expect(Buffer.byteLength(row.output!.head, 'utf8')).toBeLessThanOrEqual(
        DEFAULT_JOURNAL_PAYLOAD_LIMITS.inlineHeadBytes
      )
    }
  })
})
