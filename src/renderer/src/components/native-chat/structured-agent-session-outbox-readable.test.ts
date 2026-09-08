// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import {
  enqueueStructuredAgentSessionLaunchPrompt,
  discardStructuredAgentSessionLaunchOutbox
} from './structured-agent-session-launch-outbox'
import {
  readOutboxEvidence,
  readOutbox,
  storageKey
} from './structured-agent-session-outbox-storage'
import {
  claimOutboxDispatch,
  transitionOutbox,
  transitionOutboxEntry
} from './structured-agent-session-outbox-transitions'
import { observeOutboxSettlement } from './structured-agent-session-outbox-settlement'

const storageSpies: { mockRestore: () => void }[] = []
function spyStorage<K extends 'getItem' | 'setItem' | 'removeItem'>(method: K) {
  const spy = vi.spyOn(localStorage, method)
  storageSpies.push(spy)
  return spy
}

afterEach(() => {
  for (const spy of storageSpies.splice(0).toReversed()) {
    spy.mockRestore()
  }
  vi.restoreAllMocks()
  localStorage.clear()
})

it.each(['enqueue', 'discard', 'claim', 'completion', 'journal'] as const)(
  'refuses %s when the durable queue cannot be read',
  async (action) => {
    const entry = enqueueStructuredAgentSessionLaunchPrompt(action, 'retained')!
    const raw = localStorage.getItem(storageKey(action))
    const read = spyStorage('getItem').mockImplementation(() => {
      throw new Error('synthetic read failure')
    })
    const set = spyStorage('setItem')
    const remove = spyStorage('removeItem')
    const update = vi.fn(() => [])
    expect(readOutboxEvidence(action)).toEqual({ status: 'unavailable' })
    if (action === 'enqueue') {
      expect(enqueueStructuredAgentSessionLaunchPrompt(action, 'new')).toBeNull()
    }
    if (action === 'discard') {
      expect(discardStructuredAgentSessionLaunchOutbox(action)).toBe(false)
    }
    if (action === 'claim') {
      expect(claimOutboxDispatch(entry).ok).toBe(false)
    }
    if (action === 'completion') {
      expect(transitionOutboxEntry(entry, () => null, true).ok).toBe(false)
    }
    if (action === 'journal') {
      expect(transitionOutbox(action, update, [entry]).ok).toBe(false)
    }
    expect(update).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    await expect(observeOutboxSettlement(entry)).resolves.toBe('unavailable')
    read.mockRestore()
    expect(localStorage.getItem(storageKey(action))).toBe(raw)
    expect(transitionOutboxEntry(entry, () => null, true).ok).toBe(true)
    await expect(observeOutboxSettlement(entry)).resolves.toBe('unavailable')
  }
)

it.each(['{', '{}', 'null', '[null]', '[{"sessionId":"wrong"}]'])(
  'preserves invalid envelope %s without claiming absence',
  (raw) => {
    localStorage.setItem(storageKey('invalid'), raw)
    const remove = spyStorage('removeItem')
    const set = spyStorage('setItem')
    expect(readOutboxEvidence('invalid')).toEqual({ status: 'invalid' })
    expect(readOutbox('invalid')).toEqual([])
    expect(discardStructuredAgentSessionLaunchOutbox('invalid')).toBe(false)
    expect(enqueueStructuredAgentSessionLaunchPrompt('invalid', 'new')).toBeNull()
    expect(remove).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    expect(localStorage.getItem(storageKey('invalid'))).toBe(raw)
  }
)

it('does not rewrite a partially valid queue after filtering its invalid member', () => {
  const entry = enqueueStructuredAgentSessionLaunchPrompt('mixed', 'retained')!
  const raw = JSON.stringify([entry, null])
  localStorage.setItem(storageKey('mixed'), raw)
  expect(transitionOutboxEntry(entry, () => null, true).ok).toBe(false)
  expect(localStorage.getItem(storageKey('mixed'))).toBe(raw)
})

it('authorizes no-op success only from readable empty or positively replaced state', () => {
  expect(readOutboxEvidence('empty')).toEqual({
    status: 'readable',
    entries: []
  })
  expect(discardStructuredAgentSessionLaunchOutbox('empty')).toBe(true)
  localStorage.setItem(storageKey('empty'), '[]')
  expect(discardStructuredAgentSessionLaunchOutbox('empty')).toBe(true)
  const old = enqueueStructuredAgentSessionLaunchPrompt('replace', 'old')!
  expect(
    transitionOutboxEntry(old, (entry) => ({
      ...entry,
      deliveryIncarnation: 1
    })).changed
  ).toBe(true)
  expect(transitionOutboxEntry(old, () => null, true)).toMatchObject({
    ok: true,
    changed: false
  })
  expect(readOutbox('replace')[0].deliveryIncarnation).toBe(1)
})

it('does not settle a replacement observation from an unreadable stale completion', async () => {
  const { retainOutboxSettlement } = await import('./structured-agent-session-outbox-settlement')
  const old = enqueueStructuredAgentSessionLaunchPrompt('stale-read', 'old')!
  const result = transitionOutboxEntry(old, (entry) => ({ ...entry, deliveryIncarnation: 1 }))
  const replacement = result.entry!
  retainOutboxSettlement(replacement)
  const settled = vi.fn()
  void observeOutboxSettlement(replacement).then(settled)
  const read = spyStorage('getItem').mockImplementation(() => {
    throw new Error('synthetic read failure')
  })
  expect(transitionOutboxEntry(old, () => null, true).ok).toBe(false)
  await Promise.resolve()
  expect(settled).not.toHaveBeenCalled()
  read.mockRestore()
  expect(transitionOutboxEntry(replacement, () => null, true).changed).toBe(true)
  await expect(observeOutboxSettlement(replacement)).resolves.toBe('accepted')
})

it('retains the existing conservative optional-recovery normalization without declaring the envelope invalid', () => {
  const entry = enqueueStructuredAgentSessionLaunchPrompt('metadata', 'retained')!
  localStorage.setItem(
    storageKey('metadata'),
    JSON.stringify([{ ...entry, recovery: { attempts: 'bad' } }])
  )
  expect(readOutboxEvidence('metadata')).toMatchObject({
    status: 'readable',
    entries: [{ recovery: { attempts: 8, nextProbeAt: null, parkedReason: 'budget-exhausted' } }]
  })
})

it('confines unreadable bulk settlement to its session', async () => {
  const target = enqueueStructuredAgentSessionLaunchPrompt('failed-session', 'target')!
  const other = enqueueStructuredAgentSessionLaunchPrompt('healthy-session', 'other')!
  const settled = vi.fn()
  void observeOutboxSettlement(other).then(settled)
  const read = spyStorage('getItem').mockImplementation(() => {
    throw new Error('synthetic read failure')
  })
  expect(discardStructuredAgentSessionLaunchOutbox(target.sessionId)).toBe(false)
  await expect(observeOutboxSettlement(target)).resolves.toBe('unavailable')
  expect(settled).not.toHaveBeenCalled()
  read.mockRestore()
  expect(transitionOutboxEntry(other, () => null, true).changed).toBe(true)
  await expect(observeOutboxSettlement(other)).resolves.toBe('accepted')
})
