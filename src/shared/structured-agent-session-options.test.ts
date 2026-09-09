import { describe, expect, it } from 'vitest'
import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-claude-codex'
import { buildNativeChatSessionOptionSnapshot } from './native-chat-session-option-snapshot'
import { createNativeChatSessionOptionRecord } from './native-chat-session-option-state'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from './structured-agent-session-options'

describe('structured agent session options', () => {
  it('projects native Codex selects while bridge Codex keeps its agent picker', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: true,
            defaultEffort: 'medium',
            efforts: [
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        current: { model: 'account-model', effort: 'medium' }
      }
    )

    const structured = structuredAgentSessionOptionSnapshot(state)
    expect(structured.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    expect(structured[0]).toMatchObject({
      settable: true,
      kind: { type: 'select', currentValue: 'account-model' }
    })
    expect(structured[0]).not.toHaveProperty('action')
    expect(structured[1]).toMatchObject({
      settable: true,
      kind: { type: 'select', currentValue: 'medium' }
    })

    const bridgeRecord = createNativeChatSessionOptionRecord('codex')
    bridgeRecord.model = { value: 'gpt-5.6-sol', source: 'reported' }
    const bridge = buildNativeChatSessionOptionSnapshot({
      catalog: CODEX_SESSION_OPTION_CATALOG,
      models: CODEX_SESSION_OPTION_CATALOG.models,
      record: bridgeRecord,
      mode: 'live',
      modelLabel: 'Model',
      liveTransport: 'catalog'
    })
    // Same catalog, same `dispatched` vocabulary — only the transport separates them.
    expect(structured.every((descriptor) => descriptor.transport === 'agent-session')).toBe(true)
    expect(bridge.every((descriptor) => descriptor.transport === 'catalog')).toBe(true)
    expect(bridge[0]).toMatchObject({ action: { type: 'agent-picker' } })
    expect(bridge.find((descriptor) => descriptor.id === 'effort')).toMatchObject({
      action: { type: 'agent-picker' }
    })
  })

  it('uses provider-scoped models and withholds a current id they do not carry', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: false,
            efforts: []
          }
        ],
        current: { model: 'persisted-unknown' }
      }
    )
    // Was: a fabricated `persisted-unknown` choice. The provider never listed that id,
    // so it is tracked as the running model but never offered and never named.
    const snapshot = structuredAgentSessionOptionSnapshot(state)
    const model = snapshot[0]
    expect(
      model.kind.type === 'select' ? model.kind.choices.map((choice) => choice.value) : []
    ).toEqual(['account-model'])
    expect(model.kind.type === 'select' ? model.kind.currentValue : null).toBeUndefined()
    expect(model).toMatchObject({ valueSource: 'unknown' })
    // The thread still runs it, so effort stays settable off `unknownModelOptions`.
    expect(snapshot.find((descriptor) => descriptor.id === 'effort')).toMatchObject({
      settable: true,
      kind: { type: 'select' }
    })
  })

  it.each([
    { agent: 'codex' as const, seed: CODEX_SESSION_OPTION_CATALOG },
    { agent: 'claude' as const, seed: CLAUDE_SESSION_OPTION_CATALOG }
  ])(
    'keeps the options row when an older host publishes an empty list: $agent',
    ({ agent, seed }) => {
      // Wire case, not a unit case: `structuredAgentSessionOptionCatalog` runs on the client over
      // whatever a host published. A host that predates the readers' own seed floor still sends
      // `models: []` beside a current model for a restored thread, and the row must survive it.
      const state = applyStructuredAgentSessionOptions(
        createStructuredAgentSessionOptionState(agent),
        seed,
        { models: [], current: { model: 'unlisted-from-an-old-host' } }
      )

      const snapshot = structuredAgentSessionOptionSnapshot(state)
      expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
      const model = snapshot[0]!
      // Only official names reach the pill; the raw id is neither offered nor shown.
      expect(model).toMatchObject({ valueSource: 'unknown' })
      expect(model.kind.type === 'select' ? model.kind.choices.map((c) => c.value) : []).toEqual(
        seed.models.map((seeded) => seeded.id)
      )
      expect(snapshot[1]).toMatchObject({ id: 'effort', settable: true, kind: { type: 'select' } })
    }
  )

  it('projects live options as directly settable descriptors', () => {
    const state = applyStructuredAgentSessionOptions(
      createStructuredAgentSessionOptionState('codex'),
      CODEX_SESSION_OPTION_CATALOG,
      {
        models: [
          {
            id: 'account-model',
            label: 'Account Model',
            isDefault: true,
            defaultEffort: 'medium',
            efforts: [
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' }
            ]
          }
        ],
        current: { model: 'account-model', effort: 'medium' }
      }
    )

    const snapshot = structuredAgentSessionOptionSnapshot(state)
    expect(snapshot.map((descriptor) => descriptor.id)).toEqual(['model', 'effort'])
    expect(snapshot.every((descriptor) => descriptor.settable)).toBe(true)
    expect(snapshot.every((descriptor) => descriptor.action === undefined)).toBe(true)
  })
})
