import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  recoveryRecordMatches,
  sleepingRecordsEquivalentIgnoringCaptureTime
} from './agent-status-recovery-equivalence'

const PANE_KEY = 'tab-1:11111111-2222-4333-8444-555555555555'

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    prompt: '',
    state: 'done',
    capturedAt: 1_000,
    updatedAt: 2_000,
    origin: 'live',
    ...overrides
  }
}

const fenced = record({ automaticResumeBlockedBy: 'legacy-orchestration-worker' })

// Both predicates are equality shortcuts that suppress a write. Ignoring the fence let a rebuild
// that had dropped it count as equal, so the fenced record was quietly kept out of the update path
// that would have restored the flag — and out of the write that persists it.
describe('resume-fence significance in sleeping-record equality', () => {
  it('rejects a rebuild that dropped the fence as a recovery match', () => {
    expect(recoveryRecordMatches(fenced, record())).toBe(false)
  })

  it('rejects a rebuild that added the fence as a recovery match', () => {
    expect(recoveryRecordMatches(record(), fenced)).toBe(false)
  })

  it('rejects a capture that dropped the fence as capture-time equivalent', () => {
    expect(sleepingRecordsEquivalentIgnoringCaptureTime(fenced, record())).toBe(false)
  })

  it('rejects a capture that added the fence as capture-time equivalent', () => {
    expect(sleepingRecordsEquivalentIgnoringCaptureTime(record(), fenced)).toBe(false)
  })

  // Controls: a stable fence must stay equal, or every pass would rewrite an unchanged record.
  it('keeps two fenced records equal', () => {
    expect(recoveryRecordMatches(fenced, { ...fenced, capturedAt: 9_999 })).toBe(true)
    expect(
      sleepingRecordsEquivalentIgnoringCaptureTime(fenced, { ...fenced, capturedAt: 9_999 })
    ).toBe(true)
  })

  it('keeps two unfenced records equal', () => {
    expect(recoveryRecordMatches(record(), record({ capturedAt: 9_999 }))).toBe(true)
  })
})
