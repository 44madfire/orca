import { afterEach, describe, expect, it } from 'vitest'
import { openInMemoryPushDatabase, openPushDatabase, type PushDatabase } from './push-database.js'
import { DurablePushStore, DELIVERY_LEASE_MS } from './durable-push-store.js'
import type { PushNotification } from '@orca-cloud/push-contract'

const databases: PushDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()))
})
const notification = (seq: number, kind: 'alert' | 'dismiss' = 'alert'): PushNotification => ({
  notificationId: `notification-${seq}`,
  notificationEpoch: 'epoch',
  notificationSeq: seq,
  source: 'agent-task-complete',
  agentState: 'finished',
  title: 'Done',
  body: '',
  kind
})
async function fixture() {
  const databaseUrl =
    process.env.ORCA_PUSH_DURABLE_TEST_POSTGRES_URL ?? process.env.ORCA_PUSH_TEST_DATABASE_URL
  if (databaseUrl && !process.env.CI && new URL(databaseUrl).port !== '55440')
    throw new Error('isolated_postgres_port_required')
  const db = databaseUrl
    ? await openPushDatabase({ databaseUrl, dataDir: '', poolMax: 4 })
    : await openInMemoryPushDatabase()
  databases.push(db)
  for (const table of [
    'push_dismissed_events',
    'push_event_recipients',
    'push_delivery_batches',
    'push_events'
  ])
    await db.query(`DELETE FROM ${table}`)
  let now = 1_000_000
  const clock = () => now
  return {
    db,
    store: new DurablePushStore(db, clock),
    clock,
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('durable push acceptance', () => {
  it('counts a logical event once across phones and separates the 300/15min dismissal budget', async () => {
    const { store, advance } = await fixture()
    for (let i = 0; i < 300; i++) {
      expect(await store.accept('host', 'phone1', notification(i))).toBe('queued')
      expect(await store.accept('host', 'phone2', notification(i))).toBe('queued')
      expect(await store.accept('host', 'phone1', notification(i, 'dismiss'))).toBe('queued')
    }
    expect(await store.accept('host', 'phone1', notification(300))).toBe('rate_limited')
    expect(await store.accept('host', 'phone1', notification(300, 'dismiss'))).toBe('rate_limited')
    expect(await store.accept('another-host', 'phone3', notification(300))).toBe('queued')
    advance(15 * 60_000)
    expect(await store.accept('host', 'phone1', notification(301))).toBe('queued')
  })

  it('recovers acknowledged work and coalesces across independent service instances', async () => {
    const { db, store, clock, advance } = await fixture()
    await store.accept('host', 'phone', notification(1))
    const restarted = new DurablePushStore(db, clock)
    await restarted.accept('host', 'phone', notification(1))
    await restarted.accept('host', 'phone', notification(2))
    advance(3000)
    const batch = await restarted.claim()
    expect(batch?.notifications).toHaveLength(2)
    expect(await store.claim()).toBeNull()
    advance(DELIVERY_LEASE_MS)
    const reclaimed = await store.claim()
    expect(reclaimed?.id).toBe(batch?.id)
    expect(reclaimed?.lease).not.toBe(batch?.lease)
    await restarted.finish(batch!)
    expect(await store.claim()).toBeNull()
    await store.finish(reclaimed!)
    advance(DELIVERY_LEASE_MS)
    expect(await restarted.claim()).toBeNull()
  })

  it('never extends expiry and refuses conflicting duplicate content', async () => {
    const { store, advance } = await fixture()
    await store.accept('host', 'phone', notification(1))
    expect(await store.accept('host', 'phone', { ...notification(1), body: 'changed' })).toBe(
      'error'
    )
    advance(3000)
    const batch = (await store.claim())!
    await store.finish(batch, 10 * 60_000)
    advance(60_000)
    expect(await store.claim()).toBeNull()
    advance(5 * 60_000)
    expect(await store.accept('host', 'phone', notification(1))).toBe('error')
  })

  it('rolls quota and payload back together if persistence fails', async () => {
    const { db, store } = await fixture()
    await db.query('ALTER TABLE push_delivery_batches RENAME TO push_delivery_batches_unavailable')
    await expect(store.accept('host', 'phone', notification(1))).rejects.toThrow()
    expect(await db.query('SELECT * FROM push_events')).toEqual([])
    expect(await db.query('SELECT * FROM push_event_recipients')).toEqual([])
    await db.query('ALTER TABLE push_delivery_batches_unavailable RENAME TO push_delivery_batches')
  })
})

it('serializes concurrent instances at the quota boundary', async () => {
  const { db, store, clock } = await fixture()
  for (let seq = 0; seq < 299; seq++) await store.accept('host', 'phone', notification(seq))
  const second = new DurablePushStore(db, clock)
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      (index % 2 ? store : second).accept('host', 'phone', notification(400 + index))
    )
  )
  expect(results.filter((result) => result === 'queued')).toHaveLength(1)
  expect(results.filter((result) => result === 'rate_limited')).toHaveLength(5)
})

it('cancels unsent alerts and prevents an older replay after dismissal', async () => {
  const { store, advance } = await fixture()
  const alert = notification(1)
  await store.accept('host', 'phone', alert)
  await store.accept('host', 'phone', {
    ...notification(2, 'dismiss'),
    notificationId: alert.notificationId
  })
  advance(3000)
  const batch = (await store.claim())!
  expect(batch.notifications.map((item) => item.kind)).toEqual(['dismiss'])
  await store.finish(batch)
  expect(await store.claim()).toBeNull()
  await store.accept('host', 'another-phone', alert)
  expect(await store.claim()).toBeNull()
})

it('does not resurrect an in-flight alert after a dismissal and transient provider failure', async () => {
  const { store, advance } = await fixture()
  await store.accept('host', 'phone', notification(1))
  advance(3000)
  const inFlight = (await store.claim())!
  await store.accept('host', 'phone', {
    ...notification(2, 'dismiss'),
    notificationId: notification(1).notificationId
  })
  await store.finish(inFlight, 1000)
  const dismissal = (await store.claim())!
  expect(dismissal.notifications[0]?.kind).toBe('dismiss')
  await store.finish(dismissal)
  advance(1000)
  expect(await store.claim()).toBeNull()
  expect(await store.pendingCount('phone')).toBe(0)
})
