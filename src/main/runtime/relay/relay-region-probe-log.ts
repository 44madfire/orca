import { relayDirectorHost } from './relay-region-catalog-fetch'
import {
  RELAY_REGIONS,
  type RegionMeasurement,
  type RelayRegion,
  type RelayRegionProbeReport
} from './relay-region-probe'

export const RELAY_REGION_PROBE_EVENT = 'relay_region_probe'
export const RELAY_REGION_SELF_HEAL_EVENT = 'relay_region_self_heal'

/** Why the resolver ended up with the region it returned, or with no hint. */
export type RelayRegionChoiceReason =
  | 'measured'
  | 'held-previous'
  | 'sole-survivor-forbidden'
  | 'catalog-incomplete'
  | 'all-unreachable'
  | 'all-rejected'
  | 'catalog-unavailable'
  | 'override'
  | 'cached'

export type RelayRegionProbeLogEvent = {
  event: typeof RELAY_REGION_PROBE_EVENT
  directorHost: string
  regions: RelayRegionProbeReport[]
  chosenRegion: RelayRegion | 'no-hint'
  reason: RelayRegionChoiceReason
  cached: boolean
  ttlMs: number
}

export type RelayRegionSelfHealDecision = 'kept' | 'deleted'

export type RelayRegionSelfHealLogEvent = {
  event: typeof RELAY_REGION_SELF_HEAL_EVENT
  directorHost: string
  cachedRegion: RelayRegion
  bestRegion: RelayRegion | null
  bestLatencyMs: number | null
  assignedCellUrl: string
  assignedLatencyMs: number | null
  decision: RelayRegionSelfHealDecision
  reason:
    | 'best-matches-cache'
    | 'no-region-measured'
    | 'catalog-unavailable'
    | 'assigned-cell-near'
    | 'assigned-cell-far'
    | 'superseded-by-refresh'
}

export type RelayRegionLogEvent = RelayRegionProbeLogEvent | RelayRegionSelfHealLogEvent
export type RelayRegionLogSink = (event: RelayRegionLogEvent) => void

// JSON rather than an object argument: Node pretty-prints nested objects across
// many lines, and a support log census needs one grep-able line per event.
export function logRelayRegionEvent(event: RelayRegionLogEvent): void {
  console.info('[relay-region]', JSON.stringify(event))
}

export function relayRegionCacheHitEvent(input: {
  directorUrl: string
  region: RelayRegion | null
  ttlMs: number
}): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(input.directorUrl),
    regions: [],
    chosenRegion: input.region ?? 'no-hint',
    reason: 'cached',
    cached: true,
    ttlMs: input.ttlMs
  }
}

export function relayRegionOverrideEvent(input: {
  directorUrl: string
  region: RelayRegion
}): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(input.directorUrl),
    regions: [],
    chosenRegion: input.region,
    reason: 'override',
    cached: false,
    ttlMs: 0
  }
}

export function relayRegionCatalogFailureEvent(directorUrl: string): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(directorUrl),
    regions: [],
    chosenRegion: 'no-hint',
    reason: 'catalog-unavailable',
    cached: false,
    ttlMs: 0
  }
}

export function relayRegionRefreshEvent(input: {
  directorUrl: string
  reports: RelayRegionProbeReport[]
  best: RegionMeasurement | null
  selected: RegionMeasurement | null
  /** The incumbent was kept through an incomplete catalog rather than measured against a rival. */
  held?: boolean
  ttlMs: number
}): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(input.directorUrl),
    regions: input.reports,
    chosenRegion: input.selected?.region ?? 'no-hint',
    reason: input.held ? 'held-previous' : refreshReason(input.reports, input.best, input.selected),
    cached: false,
    ttlMs: input.ttlMs
  }
}

function refreshReason(
  reports: RelayRegionProbeReport[],
  best: RegionMeasurement | null,
  selected: RegionMeasurement | null
): RelayRegionChoiceReason {
  if (selected) {
    // The resolver keeps the incumbent unless a rival wins by a real margin, so
    // a selection that is not the fastest reading is a deliberate hold.
    return best && selected.region !== best.region ? 'held-previous' : 'measured'
  }
  // Reachability first: a support census counting all-unreachable to spot
  // client-side network breakage must not lose those runs to a roll wave. An
  // empty catalog (every region drained at once) probed nothing, so it is the
  // catalog that is incomplete, not the network.
  if (reports.length === 0) {
    return 'catalog-incomplete'
  }
  if (reports.every((report) => report.verdict === 'unreachable')) {
    return 'all-unreachable'
  }
  if (!reports.some((report) => report.verdict === 'measured')) {
    return 'all-rejected'
  }
  return reports.length < RELAY_REGIONS.length ? 'catalog-incomplete' : 'sole-survivor-forbidden'
}
