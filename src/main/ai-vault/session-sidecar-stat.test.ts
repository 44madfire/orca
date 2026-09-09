import { expect, it } from 'vitest'
import { sidecarUnchanged, type SessionSidecarStat } from './session-sidecar-stat'

const META: SessionSidecarStat = { path: '/chats/a/meta.json', mtimeMs: 100, sizeBytes: 20 }

it('holds when the agent has no sidecar at all', () => {
  expect(sidecarUnchanged('none', 'none')).toBe(true)
  expect(sidecarUnchanged(undefined, undefined)).toBe(true)
  expect(sidecarUnchanged(undefined, 'none')).toBe(true)
})

it('holds only for an identical observation', () => {
  expect(sidecarUnchanged({ ...META }, META)).toBe(true)
  expect(sidecarUnchanged({ ...META, mtimeMs: 101 }, META)).toBe(false)
  expect(sidecarUnchanged({ ...META, sizeBytes: 21 }, META)).toBe(false)
  expect(sidecarUnchanged({ ...META, path: '/chats/b/meta.json' }, META)).toBe(false)
})

it('never concludes anything from an unreadable sidecar', () => {
  expect(sidecarUnchanged('unknown', META)).toBe(false)
  expect(sidecarUnchanged(META, 'unknown')).toBe(false)
  expect(sidecarUnchanged('unknown', 'unknown')).toBe(false)
})

it('reads a missing cached observation as unknown, not as absent', () => {
  // An entry seeded from a cache file older than the field.
  expect(sidecarUnchanged(undefined, META)).toBe(false)
  expect(sidecarUnchanged('none', META)).toBe(false)
})
