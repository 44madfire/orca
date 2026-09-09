import { beforeEach, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
vi.mock('../transport/host-store', () => ({ loadHostCatalog: vi.fn() }))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => {} }
}))
const publicKeyB64 = Buffer.alloc(32, 1).toString('base64')
const hostFingerprint = deriveHostFingerprint(publicKeyB64)
const id = {
  notificationId: 'old-alert',
  notificationEpoch: 'previous-host-process',
  notificationSeq: 12
}
function presented(identifier: string, overrides = {}) {
  return { request: { identifier, content: { data: { hostFingerprint, ...id, ...overrides } } } }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadHostCatalog).mockResolvedValue([{ id: 'host-a', publicKeyB64 }] as never)
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    presented('old'),
    presented('new', { notificationSeq: 14 }),
    presented('other', { hostFingerprint: 'other-host' })
  ] as never)
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
})
it('clears a confirmed prior-epoch alert even with empty replay and preserves newer and other-host entries', async () => {
  const sendRequest = vi.fn(async () => ({
    ok: true,
    result: { notifications: [], epoch: 'new-process', dismissedPushes: [id] }
  }))
  await requestNotificationCatchup(
    { sendRequest } as never,
    'host-a',
    { lastSeenSeq: 20 },
    () => false
  )
  expect(sendRequest).toHaveBeenCalledWith('notifications.getMissedSince', {
    lastSeenSeq: 20,
    deliveredPushes: [id, { ...id, notificationSeq: 14 }]
  })
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('old')
})
it('keeps alerts when an old host omits reconciliation or the request fails', async () => {
  for (const response of [{ ok: true, result: { notifications: [] } }, { ok: false }]) {
    await requestNotificationCatchup(
      { sendRequest: async () => response } as never,
      'host-a',
      { lastSeenSeq: 0 },
      () => false
    )
  }
  expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
})
it('ignores unrequested identities and a response arriving after disconnect', async () => {
  const sendRequest = vi.fn(async () => ({
    ok: true,
    result: { dismissedPushes: [{ ...id, notificationSeq: 99 }] }
  }))
  await requestNotificationCatchup(
    { sendRequest } as never,
    'host-a',
    { lastSeenSeq: 0 },
    () => false
  )
  sendRequest.mockResolvedValue({ ok: true, result: { dismissedPushes: [id] } })
  await requestNotificationCatchup(
    { sendRequest } as never,
    'host-a',
    { lastSeenSeq: 0 },
    () => true
  )
  expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
})

it('pages individual tray identities without replaying history twice', async () => {
  const all = Array.from({ length: 288 }, (_, index) => ({
    hostFingerprint,
    notificationId: `paged-${index}`,
    notificationEpoch: 'previous-host-process',
    notificationSeq: index
  }))
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue(
    all.map((payload) => presented(payload.notificationId, payload)) as never
  )
  const sendRequest = vi.fn(async (_method: string, params: { deliveredPushes?: typeof all }) => ({
    ok: true,
    result: { notifications: [], dismissedPushes: params.deliveredPushes ?? [] }
  }))
  await requestNotificationCatchup(
    { sendRequest } as never,
    'host-a',
    { lastSeenSeq: 4 },
    () => false
  )
  expect(sendRequest).toHaveBeenCalledTimes(2)
  expect(sendRequest.mock.calls[0]?.[1].deliveredPushes).toHaveLength(256)
  expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({
    lastSeenSeq: Number.MAX_SAFE_INTEGER,
    deliveredPushes: all
      .slice(256)
      .map(({ notificationId, notificationEpoch, notificationSeq }) => ({
        notificationId,
        notificationEpoch,
        notificationSeq
      }))
  })
  expect(vi.mocked(Notifications.dismissNotificationAsync)).toHaveBeenCalledTimes(288)
})
