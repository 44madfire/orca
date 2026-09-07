import type { PushDatabase } from './push-database.js'

export type PushReadinessOptions = {
  cacheMs?: number
  now?: () => number
  observe?: (observation: { ready: boolean; sqlLatencyMs: number }) => void
}

// The gateway holds no JWKS dependency, so readiness is exactly "can we reach
// the database": /health stays unconditional for the container probe.
export function createPushReadiness(
  database: PushDatabase,
  options: PushReadinessOptions = {}
): () => Promise<boolean> {
  const cacheMs = options.cacheMs ?? 10_000
  const now = options.now ?? Date.now
  let cachedAt = Number.NEGATIVE_INFINITY
  let cached = false

  let pending: Promise<boolean> | null = null

  async function check(): Promise<boolean> {
    const startedAt = now()
    try {
      await database.query('SELECT 1 AS ready')
      cached = true
    } catch {
      cached = false
    }
    cachedAt = now()
    options.observe?.({ ready: cached, sqlLatencyMs: Math.max(0, cachedAt - startedAt) })
    return cached
  }

  return async () => {
    if (now() - cachedAt < cacheMs) return cached
    pending ??= check().finally(() => {
      pending = null
    })
    return pending
  }
}
