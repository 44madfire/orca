import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { hardenExistingSecureFile, writeSecureJsonFile } from '../../../shared/secure-file'
import {
  fetchRelayRegionCatalog,
  isProbeOriginForDirector,
  relayDirectorHost
} from './relay-region-catalog-fetch'
import {
  logRelayRegionEvent,
  relayRegionCacheHitEvent,
  relayRegionCatalogFailureEvent,
  relayRegionOverrideEvent,
  relayRegionRefreshEvent,
  RELAY_REGION_SELF_HEAL_EVENT,
  type RelayRegionLogSink,
  type RelayRegionSelfHealLogEvent
} from './relay-region-probe-log'
import { bestMeasurement, measuredRegions, selectRegionMeasurement } from './relay-region-selection'
import {
  measureOriginLatency,
  RELAY_REGIONS,
  measureRegion,
  probeRelayOrigin,
  PROBE_TIMEOUT_MS,
  WARMUP_TIMEOUT_MS,
  RelayRegionSchema,
  type RelayProbe,
  type RelayRegion,
  type RelayRegionCatalog,
  type RelayRegionProbeReport
} from './relay-region-probe'

export { RELAY_REGIONS, type RelayRegion } from './relay-region-probe'

const RELAY_REGION_CACHE_FILENAME = 'orca-relay-region-preference.json'
const CACHE_MAX_BYTES = 8 * 1024
const CACHE_TTL_MS = 24 * 60 * 60_000
// A withheld hint is cheap to revisit but expensive to re-measure on every
// reconnect, so it is remembered for far less time than a chosen region.
const NO_HINT_TTL_MS = 60 * 60_000
const FAR_CELL_RATIO = 3

const RelayRegionCacheSchema = z
  .object({
    v: z.literal(1),
    directorUrl: z.string().max(2_048),
    // Null records a deliberate "no hint"; the field is absent only for a region.
    region: RelayRegionSchema.nullable(),
    latencyMs: z.number().finite().nonnegative().max(60_000).optional(),
    // True only for a region that won against every region the fleet serves.
    // Absent on caches an older build wrote, which may hold a lone survivor.
    fullCatalog: z.literal(true).optional(),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

type RelayRegionCache = z.infer<typeof RelayRegionCacheSchema>

type RelayRegionPreferenceOptions = {
  directorUrl: string
  userDataPath: string
  fetch?: typeof globalThis.fetch
  now?: () => number
  measureNow?: () => number
  diagnosticOverride?: string
  probe?: RelayProbe
  requestTimeoutMs?: number
  logEvent?: RelayRegionLogSink
}

export class RelayRegionPreferenceResolver {
  private readonly options: RelayRegionPreferenceOptions
  private pending: Promise<RelayRegion | undefined> | null = null
  private readonly selfHealedCells = new Set<string>()

  constructor(options: RelayRegionPreferenceOptions) {
    this.options = options
  }

  async resolve(): Promise<RelayRegion | undefined> {
    const override = this.overrideRegion()
    if (override) {
      this.log(
        relayRegionOverrideEvent({ directorUrl: this.options.directorUrl, region: override })
      )
      return override
    }

    const now = (this.options.now ?? Date.now)()
    const cache = readRelayRegionCache(this.cachePath(), this.options.directorUrl, now)
    if (cache && cache.expiresAt > now) {
      this.log(
        relayRegionCacheHitEvent({
          directorUrl: this.options.directorUrl,
          region: cache.region,
          ttlMs: cache.expiresAt - now
        })
      )
      return cache.region ?? undefined
    }
    if (this.pending) {
      return await this.pending
    }

    this.pending = this.refresh(cache, now).catch(() => undefined)
    try {
      return await this.pending
    } finally {
      this.pending = null
    }
  }

  // Why: a cache written from a bad measurement pins the desktop to a distant
  // cell for a full day. Probing the cell we actually landed on catches that.
  async invalidateIfAssignedCellIsFar(assignedCellOrigin: string): Promise<void> {
    // Same ownership rule as a catalog probe origin: an unauthenticated GET.
    if (
      this.overrideRegion() ||
      this.selfHealedCells.has(assignedCellOrigin) ||
      !isProbeOriginForDirector(assignedCellOrigin, this.options.directorUrl)
    ) {
      return
    }
    const now = (this.options.now ?? Date.now)()
    const cache = readRelayRegionCache(this.cachePath(), this.options.directorUrl, now)
    // An absent, expired, or no-hint cache is already re-measured by resolve().
    if (!cache?.region || cache.expiresAt <= now) {
      return
    }
    this.selfHealedCells.add(assignedCellOrigin)
    const outcome: Omit<RelayRegionSelfHealLogEvent, 'directorHost'> = {
      event: RELAY_REGION_SELF_HEAL_EVENT,
      cachedRegion: cache.region,
      bestRegion: null,
      bestLatencyMs: null,
      assignedCellUrl: assignedCellOrigin,
      assignedLatencyMs: null,
      decision: 'kept',
      reason: 'catalog-unavailable'
    }
    try {
      const fetch = this.options.fetch ?? globalThis.fetch
      const probe = this.createProbe(fetch)
      // A director that cannot list its regions is the one self-heal outcome a
      // support log would otherwise never see, so it is reported before the throw.
      const reports = await this.probeCatalog(fetch, () => this.logSelfHeal(outcome))
      const best = bestMeasurement(measuredRegions(reports))
      outcome.bestRegion = best?.region ?? null
      outcome.bestLatencyMs = best?.latencyMs ?? null
      outcome.reason = best ? 'best-matches-cache' : 'no-region-measured'
      // A far cell under a cache that still names the best region is the
      // director declining the hint; deleting it would only re-probe.
      if (!best || best.region === cache.region) {
        this.logSelfHeal(outcome)
        return
      }
      const assignedMs = await measureOriginLatency(assignedCellOrigin, probe)
      outcome.assignedLatencyMs = assignedMs
      const far = assignedMs !== null && assignedMs > best.latencyMs * FAR_CELL_RATIO
      outcome.decision = far ? 'deleted' : 'kept'
      outcome.reason = far ? 'assigned-cell-far' : 'assigned-cell-near'
      if (far) {
        rmSync(this.cachePath(), { force: true })
      }
      this.logSelfHeal(outcome)
    } catch {
      // Self-heal is best effort; a failed probe must never disturb the session.
    }
  }

  private logSelfHeal(outcome: Omit<RelayRegionSelfHealLogEvent, 'directorHost'>): void {
    this.log({ ...outcome, directorHost: relayDirectorHost(this.options.directorUrl) })
  }

  private async refresh(
    previous: RelayRegionCache | null,
    now: number
  ): Promise<RelayRegion | undefined> {
    const fetch = this.options.fetch ?? globalThis.fetch
    // Only a refresh withholds a hint, so only a refresh reports the catalog
    // failure as a probe event; self-heal reports it as its own outcome.
    const reports = await this.probeCatalog(fetch, () =>
      this.log(relayRegionCatalogFailureEvent(this.options.directorUrl))
    )
    const measurements = measuredRegions(reports)
    const previousRegion = previous?.region ?? null
    // Why: a region may only win against a measured competitor. An unmeasured
    // peer, or one the catalog dropped for having no general cell (a roll wave
    // or heartbeat stall), means director default placement beats a lone survivor.
    // The exception is the incumbent: a hint that was earned against a full
    // catalog and still measures is held, not discarded, or an expiry that lands
    // during the other region's roll wave would send the desktop to the default.
    const complete =
      measurements.length === reports.length && reports.length === RELAY_REGIONS.length
    // Only a hint earned against a full catalog may be held through an
    // incomplete one; a cache without the marker is treated as unverified.
    const incumbent = previous?.fullCatalog
      ? measurements.find((measurement) => measurement.region === previousRegion)
      : undefined
    const selected = complete
      ? selectRegionMeasurement(measurements, previousRegion)
      : (incumbent ?? null)
    const ttlMs = selected ? CACHE_TTL_MS : NO_HINT_TTL_MS
    this.log(
      relayRegionRefreshEvent({
        directorUrl: this.options.directorUrl,
        reports,
        best: bestMeasurement(measurements),
        selected,
        ttlMs
      })
    )
    this.writeCache(
      selected
        ? { region: selected.region, latencyMs: selected.latencyMs, ttlMs, fullCatalog: true }
        : { region: null, ttlMs },
      now
    )
    return selected?.region
  }

  private async probeCatalog(
    fetch: typeof globalThis.fetch,
    onCatalogFailure?: () => void
  ): Promise<RelayRegionProbeReport[]> {
    let catalog: RelayRegionCatalog
    try {
      // The catalog request is the coldest of the sequence: it pays DNS, TCP,
      // and TLS to the director, so it gets the warm-up budget, not the sample one.
      catalog = await fetchRelayRegionCatalog(
        this.options.directorUrl,
        fetch,
        this.options.requestTimeoutMs ?? WARMUP_TIMEOUT_MS
      )
    } catch (error) {
      onCatalogFailure?.()
      throw error
    }
    const probe = this.createProbe(fetch)
    return await Promise.all(catalog.regions.map((entry) => measureRegion(entry, probe)))
  }

  private log(event: Parameters<RelayRegionLogSink>[0]): void {
    ;(this.options.logEvent ?? logRelayRegionEvent)(event)
  }

  private writeCache(
    entry: { region: RelayRegion | null; latencyMs?: number; ttlMs: number; fullCatalog?: true },
    now: number
  ): void {
    try {
      writeSecureJsonFile(this.cachePath(), {
        v: 1,
        directorUrl: this.options.directorUrl,
        region: entry.region,
        ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
        ...(entry.fullCatalog ? { fullCatalog: true } : {}),
        expiresAt: now + entry.ttlMs
      } satisfies RelayRegionCache)
    } catch {
      // A cache write must not block an otherwise valid Relay assignment.
    }
  }

  private overrideRegion(): RelayRegion | undefined {
    const override = RelayRegionSchema.safeParse(
      this.options.diagnosticOverride ?? process.env.ORCA_RELAY_REGION_OVERRIDE
    )
    return override.success ? override.data : undefined
  }

  private cachePath(): string {
    return join(this.options.userDataPath, RELAY_REGION_CACHE_FILENAME)
  }

  private createProbe(fetch: typeof globalThis.fetch): RelayProbe {
    return (
      this.options.probe ??
      ((origin: string, phase?: 'warmup' | 'sample') =>
        probeRelayOrigin(
          origin,
          fetch,
          this.options.measureNow ?? (() => performance.now()),
          this.options.requestTimeoutMs ??
            (phase === 'warmup' ? WARMUP_TIMEOUT_MS : PROBE_TIMEOUT_MS)
        ))
    )
  }
}

export function createRelayRegionPreferenceReader(input: {
  authConfig: { relayDirectorUrl: string }
  userDataPath: string
}): {
  resolvePreferredRegion: () => Promise<RelayRegion | undefined>
  noteAssignedCell: (cellUrl: string) => void
} {
  const resolver = new RelayRegionPreferenceResolver({
    directorUrl: input.authConfig.relayDirectorUrl,
    userDataPath: input.userDataPath
  })
  return {
    resolvePreferredRegion: () => resolver.resolve(),
    noteAssignedCell: (cellUrl) => void resolver.invalidateIfAssignedCellIsFar(cellUrl)
  }
}

function readRelayRegionCache(path: string, directorUrl: string, now: number) {
  try {
    if (!existsSync(path)) {
      return null
    }
    hardenExistingSecureFile(path)
    if (statSync(path).size > CACHE_MAX_BYTES) {
      return null
    }
    const parsed = RelayRegionCacheSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success &&
      parsed.data.directorUrl === directorUrl &&
      parsed.data.expiresAt <= now + CACHE_TTL_MS
      ? parsed.data
      : null
  } catch {
    return null
  }
}
