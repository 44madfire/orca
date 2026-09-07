const CAPACITY = 40
const REFILL_PER_SECOND = 20
const IDLE_EVICTION_MS = 60_000

type Bucket = { tokens: number; updatedAt: number }

const buckets = new Map<string, Bucket>()

/** Pointer and keyboard traffic is per-gesture, and the shell forwards it blind, so the desktop is
 * the only place the rate is bounded. One bucket per connection, shared by both. */
export function takeMobileWebBrowserInputToken(
  connectionId: string | undefined,
  now = Date.now()
): boolean {
  const key = connectionId ?? 'local'
  const bucket = buckets.get(key) ?? { tokens: CAPACITY, updatedAt: now }
  if (!buckets.has(key)) {
    evictIdleBuckets(now)
  }
  const refill = ((now - bucket.updatedAt) / 1000) * REFILL_PER_SECOND
  bucket.tokens = Math.min(CAPACITY, bucket.tokens + Math.max(0, refill))
  bucket.updatedAt = now
  buckets.set(key, bucket)
  if (bucket.tokens < 1) {
    return false
  }
  bucket.tokens -= 1
  return true
}

export function resetMobileWebBrowserInputRateLimit(): void {
  buckets.clear()
}

function evictIdleBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt >= IDLE_EVICTION_MS) {
      buckets.delete(key)
    }
  }
}
