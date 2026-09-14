import { describe, expect, it } from 'vitest'
import {
  classifyPiHandoffFailure,
  decidePiHandoffQuiesce,
  decidePiHistoryReconciliation,
  validatePiHandoffIdentity
} from './pi-structured-handoff-policy'

describe('Pi handoff quiesce policy', () => {
  it('proceeds when idle and refuses busy `now` without killing the turn', () => {
    expect(
      decidePiHandoffQuiesce({ hasActiveTurn: false, hasPendingPrompt: false, mode: 'now', direction: 'to-tui' })
    ).toEqual({ kind: 'proceed' })
    expect(
      decidePiHandoffQuiesce({ hasActiveTurn: true, hasPendingPrompt: false, mode: 'now', direction: 'to-tui' })
    ).toMatchObject({ kind: 'refuse-busy' })
    expect(
      decidePiHandoffQuiesce({ hasActiveTurn: true, hasPendingPrompt: false, mode: 'after-turn', direction: 'to-tui' })
    ).toEqual({ kind: 'queue-after-turn' })
  })

  it('refuses pending prompts before switching and never interrupts a TUI turn via stop-turn', () => {
    expect(
      decidePiHandoffQuiesce({ hasActiveTurn: false, hasPendingPrompt: true, mode: 'now', direction: 'to-native' })
    ).toMatchObject({ kind: 'refuse-prompt' })
    expect(
      decidePiHandoffQuiesce({ hasActiveTurn: true, hasPendingPrompt: false, mode: 'stop-turn', direction: 'to-native' })
    ).toMatchObject({ kind: 'refuse-busy' })
  })
})

describe('Pi handoff identity', () => {
  it('resumes the exact same Pi session while the leaf advances', () => {
    expect(
      validatePiHandoffIdentity({
        from: { provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' },
        to: { provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-10' }
      })
    ).toMatchObject({ ok: true })
  })

  it('fails closed when the Pi session changes, the handle is missing, or the provider mismatches', () => {
    expect(
      validatePiHandoffIdentity({
        from: { provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' },
        to: { provider: 'pi', sessionId: 'pi-ses-2', leafId: 'leaf-9' }
      })
    ).toMatchObject({ ok: false, code: 'PI_HANDOFF_SESSION_MISMATCH' })
    expect(
      validatePiHandoffIdentity({
        from: { provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' },
        to: null
      })
    ).toMatchObject({ ok: false, code: 'PI_HANDOFF_UNKNOWN_DISPATCH' })
    expect(
      validatePiHandoffIdentity({
        from: { provider: 'pi', sessionId: 'pi-ses-1', leafId: 'leaf-9' },
        to: { provider: 'codex', threadId: 'thread-1' }
      })
    ).toMatchObject({ ok: false, code: 'PI_HANDOFF_PROVIDER_MISMATCH' })
  })
})

describe('Pi history reconciliation', () => {
  it('reconciles via provider-resume and never via legacy import', () => {
    expect(decidePiHistoryReconciliation({ historySource: 'provider-resume' })).toMatchObject({
      kind: 'provider-resume'
    })
    expect(
      decidePiHistoryReconciliation({ transcriptPath: '/tmp/pi-session.jsonl', piSessionId: 'pi-ses-1' })
    ).toMatchObject({ kind: 'fail-closed', code: 'PI_HISTORY_INCOMPATIBLE' })
    expect(decidePiHistoryReconciliation({})).toMatchObject({
      kind: 'fail-closed',
      code: 'PI_HISTORY_MISSING'
    })
  })
})

describe('Pi recoverable failures', () => {
  it('maps ambiguous teardown to manual recovery, never to a silent retry', () => {
    expect(classifyPiHandoffFailure('agent_session_acquisition_exit_unproven')).toBe('manual-recovery')
    expect(classifyPiHandoffFailure('PI_EXITED')).toBe('manual-recovery')
    expect(classifyPiHandoffFailure('PI_RESUME_CWD_MISMATCH')).toBe('manual-recovery')
  })
})
