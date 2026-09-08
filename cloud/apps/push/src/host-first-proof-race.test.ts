import { expect, it } from 'vitest'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { openPushDatabase, type PushDatabase } from './push-database.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import {
  answerPushHostChallenge,
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'

const databaseUrl = process.env.ORCA_PUSH_TEST_DATABASE_URL
it.skipIf(!databaseUrl)(
  'accepts concurrent first proofs, including after host pruning',
  async () => {
    if (!process.env.CI && new URL(databaseUrl!).port !== '55440')
      throw new Error('isolated_postgres_port_required')
    const admin = await openPushDatabase({ databaseUrl, dataDir: '' })
    const schema = `first_proof_${Date.now()}`
    await admin.query(`CREATE SCHEMA ${schema}`)
    const isolatedUrl = new URL(databaseUrl!)
    isolatedUrl.searchParams.set('options', `-c search_path=${schema}`)
    const database = await openPushDatabase({
      databaseUrl: isolatedUrl.toString(),
      dataDir: '',
      poolMax: 4
    })
    const host = createPushHostKeypair()
    const origin = 'https://push.onorca.dev'
    let now = Date.now()
    let release!: () => void
    let arrivals = 0
    let gate: Promise<void>
    let concurrent = true
    const wrapped: PushDatabase = {
      dialect: database.dialect,
      query: database.query.bind(database),
      close: database.close.bind(database),
      lockQuotaScope: database.lockQuotaScope.bind(database),
      transaction: (run) =>
        database.transaction((tx) =>
          run({
            dialect: tx.dialect,
            close: tx.close.bind(tx),
            transaction: tx.transaction.bind(tx),
            lockQuotaScope: tx.lockQuotaScope.bind(tx),
            query: async (sql, params) => {
              // Both transactions reach the host insert before either can commit.
              if (concurrent && sql.trimStart().startsWith('INSERT INTO push_hosts')) {
                if (++arrivals === 2) release()
                await gate
              }
              return tx.query(sql, params)
            }
          })
        )
    }
    const store = new PushHostChallengeStore(wrapped, origin, () => now)
    let fingerprint = ''
    try {
      for (let round = 0; round < 2; round++) {
        arrivals = 0
        concurrent = true
        gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const challenges = await Promise.all([
          store.issue(hostPublicKeyB64(host)),
          store.issue(hostPublicKeyB64(host))
        ])
        fingerprint = challenges[0]!.hostFingerprint
        const results = await Promise.allSettled(
          challenges.map((challenge) =>
            store.verify(
              challenge!.challengeId,
              answerPushHostChallenge(challenge!, {
                gatewayOrigin: origin,
                keypair: host,
                now: () => now
              })!
            )
          )
        )
        expect(results).toEqual(
          challenges.map(() => ({
            status: 'fulfilled',
            value: { ok: true, hostFingerprint: fingerprint }
          }))
        )
        const createdAt = now
        concurrent = false
        now += 1000
        const next = (await store.issue(hostPublicKeyB64(host)))!
        await store.verify(
          next.challengeId,
          answerPushHostChallenge(next, { gatewayOrigin: origin, keypair: host, now: () => now })!
        )
        const rows = await database.query('SELECT * FROM push_hosts WHERE host_fingerprint = ?', [
          fingerprint
        ])
        expect(rows).toHaveLength(1)
        expect(Number(rows[0]!.created_at)).toBe(createdAt)
        expect(Number(rows[0]!.last_seen_at)).toBe(now)
        expect(rows[0]!.host_public_key).toBe(hostPublicKeyB64(host))
        now += PUSH_LIMITS.hostRetentionMs + 1
        await store.pruneStaleHosts()
        expect(
          await database.query('SELECT 1 FROM push_hosts WHERE host_fingerprint = ?', [fingerprint])
        ).toEqual([])
      }
    } finally {
      release?.()
      await database.query('DELETE FROM push_challenges WHERE host_fingerprint = ?', [fingerprint])
      await database.query('DELETE FROM push_hosts WHERE host_fingerprint = ?', [fingerprint])
      await database.close()
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.close()
    }
  }
)
