// Transplanted Pi translation unit tests (SNC1.9).
//
// Pin the mapping/translator/history semantics the native driver depends on,
// using inline vectors shaped like `packages/pi-rpc/fixtures/*.jsonl`.
// Proves text/thinking/tool separation, final reconciliation, exactly-once
// tool identity, bounded unknown handling, and active-branch reconstruction.

import { describe, expect, it } from 'vitest'
import {
  mapPiRecordToSessionEvents,
  validatePiDispatch
} from './pi-record-mapping'
import { PiTranslator } from './pi-turn-translator'
import {
  extractActiveBranch,
  translatePiBranchToHistory
} from './pi-branch-history'

describe('mapPiRecordToSessionEvents', () => {
  it('maps text deltas and authoritative finals', () => {
    expect(
      mapPiRecordToSessionEvents({
        type: 'message_update',
        assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'hel' }
      })
    ).toEqual([{ type: 'text_delta', delta: 'hel', contentIndex: 0 }])
    expect(
      mapPiRecordToSessionEvents({
        type: 'message_update',
        assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: 'hello' }
      })
    ).toEqual([{ type: 'text_end', contentIndex: 0, text: 'hello' }])
  })

  it('keeps thinking on its own channel and drops arg-chunk deltas', () => {
    expect(
      mapPiRecordToSessionEvents({
        type: 'message_update',
        assistantMessageEvent: { kind: 'thinking_delta', contentIndex: 1, delta: 'hmm' }
      })
    ).toEqual([{ type: 'thinking_delta', delta: 'hmm', contentIndex: 1 }])
    expect(
      mapPiRecordToSessionEvents({
        type: 'message_update',
        assistantMessageEvent: { kind: 'toolcall_delta', id: 'c1' }
      })
    ).toEqual([])
  })

  it('stabilizes tool identity and preserves abort and error verdicts', () => {
    const start = mapPiRecordToSessionEvents({
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'a' }
    })
    expect(start).toEqual([{ type: 'tool_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a' } }])
    expect(
      mapPiRecordToSessionEvents({ type: 'turn_end', message: { stopReason: 'aborted' } })
    ).toEqual([{ type: 'turn_end', stopReason: 'aborted' }])
    expect(
      mapPiRecordToSessionEvents({ type: 'turn_end', message: { stopReason: 'toolUse' } })
    ).toEqual([{ type: 'turn_end', stopReason: 'stop' }])
    const failure = mapPiRecordToSessionEvents({ type: 'turn_end', message: { stopReason: 'error' } })
    expect(failure).toEqual([{ type: 'turn_end', stopReason: 'error', errorMessage: 'provider dispatch failed' }])
  })

  it('maps dialogs and ignores fire-and-forget chrome and unknown kinds', () => {
    const dialog = mapPiRecordToSessionEvents({
      type: 'extension_ui_request',
      id: 'd1',
      method: 'select',
      title: 'Pick',
      options: ['a', 'b']
    })
    expect(dialog).toEqual([
      { type: 'prompt_request', requestId: 'd1', prompt: { kind: 'select', title: 'Pick', options: ['a', 'b'] } }
    ])
    expect(
      mapPiRecordToSessionEvents({ type: 'extension_ui_request', id: 'd2', method: 'notify' })
    ).toEqual([])
    expect(mapPiRecordToSessionEvents({ type: 'future_pi_kind', payload: 1 })).toEqual([])
    expect(mapPiRecordToSessionEvents({ type: 'response', command: 'prompt', success: true })).toEqual([])
  })

  it('validates dispatches without touching Pi', () => {
    expect(validatePiDispatch({ text: '   ' }, {})).toMatchObject({ ok: false })
    expect(validatePiDispatch({ text: 'hi' }, { thinkingLevel: 'bogus' })).toMatchObject({ ok: false })
    expect(validatePiDispatch({ text: 'hi' }, { thinkingLevel: 'high' })).toMatchObject({ ok: true })
    expect(
      validatePiDispatch({ text: 'hi', images: [{ data: 'eA==', mimeType: 'image/png' }] }, {}, 'gpt-x')
    ).toMatchObject({ ok: true })
    expect(
      validatePiDispatch({ text: 'hi', images: [{ data: 'eA==', mimeType: 'image/png' }] }, {}, 'text-only-9')
    ).toMatchObject({ ok: false })
  })
})

describe('PiTranslator', () => {
  it('coalesces deltas and reconciles finals without duplication', () => {
    const translator = new PiTranslator()
    translator.applyPiRecord({
      type: 'message_update',
      assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'hel' }
    })
    translator.applyPiRecord({
      type: 'message_update',
      assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'lo' }
    })
    translator.applyPiRecord({
      type: 'message_update',
      assistantMessageEvent: { kind: 'text_end', contentIndex: 0, content: 'hello!' }
    })
    expect(translator.currentAssistantText()).toBe('hello!')
  })

  it('dedupes same-id tool re-announces and keeps tool output out of prose', () => {
    const translator = new PiTranslator()
    const first = translator.applyPiRecord({
      type: 'message_update',
      assistantMessageEvent: { kind: 'toolcall_start', id: 'c1', toolName: 'read' }
    })
    const second = translator.applyPiRecord({
      type: 'message_update',
      assistantMessageEvent: { kind: 'toolcall_end', toolCall: { id: 'c1', name: 'read', arguments: { path: 'a' } } }
    })
    const third = translator.applyPiRecord({ type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a' } })
    expect(first.filter((event) => event.type === 'tool_start')).toHaveLength(1)
    expect(second.filter((event) => event.type === 'tool_start')).toHaveLength(1)
    expect(third).toEqual([])
    translator.applyPiRecord({ type: 'tool_execution_end', toolCallId: 'c1', toolName: 'read', result: 'file-bytes', isError: false })
    expect(translator.currentAssistantText()).toBe('')
    const drained = translator.drainTurnEnd()
    expect(drained.filter((entry) => entry.role === 'tool')).toHaveLength(1)
  })

  it('settles with no retained transient', () => {
    const translator = new PiTranslator()
    translator.notePendingUser('hello')
    translator.applyPiRecord({ type: 'turn_start' })
    translator.applyPiRecord({
      type: 'message_update',
      assistantMessageEvent: { kind: 'text_delta', contentIndex: 0, delta: 'hi' }
    })
    expect(translator.hasTransient()).toBe(true)
    translator.settle()
    expect(translator.hasTransient()).toBe(false)
  })
})

describe('pi-branch-history', () => {
  const branch = [
    { type: 'message', id: 'e1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
    { type: 'message', id: 'e2', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    { type: 'message', id: 'e3', parentId: 'e2', message: { role: 'toolResult', content: [{ type: 'text', text: 'out' }] } },
    { type: 'message', id: 'sibling', parentId: 'e1', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }] } },
    { type: 'model_change', id: 'meta', parentId: 'e3', message: {} }
  ]

  it('extracts only the root-to-leaf chain', () => {
    const result = extractActiveBranch(branch, 'meta')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.branch.map((entry) => entry.id)).toEqual(['e1', 'e2', 'e3', 'meta'])
    }
  })

  it('translates roles with channel separation and stable ids', () => {
    const rows = translatePiBranchToHistory(branch.slice(0, 3))
    expect(rows.map((row) => [row.role, row.text])).toEqual([
      ['user', 'first'],
      ['assistant', 'second'],
      ['tool', 'out']
    ])
    expect(rows[0]?.id).toBe('e1')
  })

  it('fails closed on broken chains, cycles, and missing leaves', () => {
    expect(extractActiveBranch(branch, 'nope').ok).toBe(false)
    expect(extractActiveBranch([], 'e1').ok).toBe(false)
    const cyclic = [
      { type: 'message', id: 'a', parentId: 'b', message: { role: 'user', content: 'x' } },
      { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'y' } }
    ]
    expect(extractActiveBranch(cyclic, 'a').ok).toBe(false)
  })
})
