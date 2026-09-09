import { beforeEach, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { readOrcaPushPayload } from './push-payload'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import { requestNotificationCatchup } from './push-dismissal-reconciliation'
import { areLegacySummaryPushesDismissed } from './push-dismissal-watermarks'

const storage = new Map<string, string>()
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      storage.set(key, value)
    }
  }
}))
vi.mock('expo-notifications', () => ({
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))
vi.mock('../transport/host-store', () => ({
  loadHostCatalog: async () => [
    { id: 'host', publicKeyB64: Buffer.alloc(32, 1).toString('base64') }
  ]
}))
const hostFingerprint = deriveHostFingerprint(Buffer.alloc(32, 1).toString('base64'))
const members = [1, 2].map((notificationSeq) => ({
  notificationId: `agent-${notificationSeq}`,
  notificationEpoch: 'epoch',
  notificationSeq
}))
const summary = { hostFingerprint, ...members[1], coalescedCount: 2, summaryMembers: members }
const entry = (identifier: string, data = summary) => ({
  request: { identifier, content: { data } }
})
beforeEach(() => {
  vi.clearAllMocks()
  storage.clear()
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue([
    entry('summary'),
    entry('newer', {
      ...summary,
      summaryMembers: [members[0]!, { ...members[1]!, notificationSeq: 3 }]
    }),
    entry('legacy', { ...summary, summaryMembers: undefined } as never),
    entry('other-host', { ...summary, hostFingerprint: 'other-host' })
  ] as never)
  vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
})
it('preserves partially handled summaries and clears only fully handled membership', async () => {
  await dismissPresentedPushNotification(members[0]!.notificationId, hostFingerprint, members[0])
  expect(Notifications.dismissNotificationAsync).not.toHaveBeenCalled()
  expect(await areLegacySummaryPushesDismissed(summary)).toBe(false)
  await dismissPresentedPushNotification(members[1]!.notificationId, hostFingerprint, members[1])
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('summary')
  expect(await areLegacySummaryPushesDismissed(summary)).toBe(true)
})
it('reconciles every summary member, preserving a summary containing a newer unread event', async () => {
  const sendRequest = vi.fn(async () => ({
    ok: true,
    result: { notifications: [], dismissedPushes: members }
  }))
  await requestNotificationCatchup({ sendRequest } as never, 'host', undefined, () => false)
  expect(sendRequest.mock.calls[0]).toEqual([
    'notifications.getMissedSince',
    {
      lastSeenSeq: Number.MAX_SAFE_INTEGER,
      deliveredPushes: [...members, { ...members[1], notificationSeq: 3 }]
    }
  ])
  expect(Notifications.dismissNotificationAsync).toHaveBeenCalledExactlyOnceWith('summary')
})
it('accepts APNs arrays and FCM JSON strings but never treats incomplete or malformed membership as complete', async () => {
  expect(readOrcaPushPayload({ orca: summary })?.summaryMembers).toEqual(members)
  expect(
    readOrcaPushPayload({
      ...summary,
      coalescedCount: '2',
      summaryMembers: JSON.stringify(members)
    })?.summaryMembers
  ).toEqual(members)
  for (const bad of [
    members.slice(0, 1),
    'invalid',
    [{ ...members[0], notificationSeq: true }, members[1]]
  ]) {
    expect(readOrcaPushPayload({ ...summary, summaryMembers: bad })?.summaryMembers).toBeUndefined()
  }
  expect(
    await areLegacySummaryPushesDismissed({ ...summary, summaryMembers: members.slice(0, 1) })
  ).toBe(false)
})

it('pages summary identities without replaying history twice or trusting identities from another page', async () => {
  const all = Array.from({ length: 288 }, (_, index) => ({
    notificationId: `paged-${index}`,
    notificationEpoch: 'epoch',
    notificationSeq: index
  }))
  vi.mocked(Notifications.getPresentedNotificationsAsync).mockResolvedValue(
    Array.from({ length: 9 }, (_, index) =>
      entry(`group-${index}`, {
        ...summary,
        coalescedCount: 32,
        summaryMembers: all.slice(index * 32, index * 32 + 32)
      })
    ) as never
  )
  const sendRequest = vi.fn(async (_method: string, params: { deliveredPushes: typeof all }) => ({
    ok: true,
    result: { notifications: [], dismissedPushes: [...params.deliveredPushes, all[287]] }
  }))
  await requestNotificationCatchup(
    { sendRequest } as never,
    'host',
    { lastSeenSeq: 4 },
    () => false
  )
  expect(sendRequest).toHaveBeenCalledTimes(2)
  expect(sendRequest.mock.calls[0]?.[1].deliveredPushes).toHaveLength(256)
  expect(sendRequest.mock.calls[1]?.[1]).toMatchObject({
    lastSeenSeq: Number.MAX_SAFE_INTEGER,
    deliveredPushes: all.slice(256)
  })
  expect(
    vi.mocked(Notifications.dismissNotificationAsync).mock.calls.filter(([id]) => id === 'group-8')
  ).toHaveLength(1)
})
