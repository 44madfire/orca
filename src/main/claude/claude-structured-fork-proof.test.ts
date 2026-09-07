import { describe, expect, it } from 'vitest'
import { verifyClaudeForkTranscript } from './claude-structured-fork-proof'
const fork = {
  source: { provider: 'claude', sessionId: 'parent', leafUuid: 'later' },
  throughId: 'selected',
  retainedItemIds: ['claude:parent:prompt', 'claude:parent:selected']
} as const
const line = (row: object) => `${JSON.stringify(row)}\n`
const prefix =
  line({ type: 'user', sessionId: 'parent', uuid: 'prompt', parentUuid: null }) +
  line({ type: 'assistant', sessionId: 'parent', uuid: 'selected', parentUuid: 'prompt' })

describe('Claude fork prefix proof', () => {
  it('accepts copied UUIDs and original session IDs at the selected leaf', () => {
    expect(() =>
      verifyClaudeForkTranscript(
        prefix + line({ type: 'last-prompt', sessionId: 'child', leafUuid: 'selected' }),
        'child',
        fork
      )
    ).not.toThrow()
  })
  it('refuses a fork that includes a later turn', () => {
    const contents =
      prefix +
      line({ type: 'user', sessionId: 'parent', uuid: 'later', parentUuid: 'selected' }) +
      line({ type: 'last-prompt', sessionId: 'child', leafUuid: 'later' })
    expect(() => verifyClaudeForkTranscript(contents, 'child', fork)).toThrow('proof-mismatch')
  })
  it('refuses a missing retained UUID and foreign ancestry', () => {
    expect(() =>
      verifyClaudeForkTranscript(
        line({ type: 'last-prompt', sessionId: 'child', leafUuid: 'selected' }),
        'child',
        fork
      )
    ).toThrow()
    const foreign =
      line({ type: 'user', sessionId: 'foreign', uuid: 'prompt', parentUuid: null }) +
      line({ type: 'assistant', sessionId: 'parent', uuid: 'selected', parentUuid: 'prompt' }) +
      line({ type: 'last-prompt', sessionId: 'child', leafUuid: 'selected' })
    expect(() => verifyClaudeForkTranscript(foreign, 'child', fork)).toThrow('missing ancestor')
  })
  it('refuses sidechain targets through the existing branch proof', () => {
    const contents =
      line({
        type: 'assistant',
        sessionId: 'parent',
        uuid: 'selected',
        parentUuid: null,
        isSidechain: true
      }) + line({ type: 'last-prompt', sessionId: 'child', leafUuid: 'selected' })
    expect(() => verifyClaudeForkTranscript(contents, 'child', fork)).toThrow()
  })
  it('refuses a truncated ancestry even when the selected leaf still exists', () => {
    const contents =
      line({ type: 'assistant', sessionId: 'parent', uuid: 'selected', parentUuid: null }) +
      line({ type: 'last-prompt', sessionId: 'child', leafUuid: 'selected' })
    expect(() => verifyClaudeForkTranscript(contents, 'child', fork)).toThrow(
      'retained record is missing'
    )
  })
})
