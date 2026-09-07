import {
  RELAY_REGIONS,
  regionMeasurement,
  type RegionMeasurement,
  type RelayRegion,
  type RelayRegionProbeReport
} from './relay-region-probe'

// A rival must beat the incumbent by both an absolute and a relative margin, so
// two regions within noise of each other do not flip the hint every refresh.
const SWITCH_MINIMUM_MS = 25
const SWITCH_RATIO = 0.8

export function measuredRegions(reports: RelayRegionProbeReport[]): RegionMeasurement[] {
  return reports
    .map(regionMeasurement)
    .filter((measurement): measurement is RegionMeasurement => measurement !== null)
}

export function bestMeasurement(measurements: RegionMeasurement[]): RegionMeasurement | null {
  const order = new Map(RELAY_REGIONS.map((region, index) => [region, index]))
  return (
    [...measurements].sort(
      (left, right) =>
        left.latencyMs - right.latencyMs || order.get(left.region)! - order.get(right.region)!
    )[0] ?? null
  )
}

export function selectRegionMeasurement(
  measurements: RegionMeasurement[],
  previousRegion: RelayRegion | null
): RegionMeasurement | null {
  const best = bestMeasurement(measurements)
  if (!best || !previousRegion || best.region === previousRegion) {
    return best
  }
  const current = measurements.find((measurement) => measurement.region === previousRegion)
  if (!current) {
    return best
  }
  const meaningful =
    current.latencyMs - best.latencyMs >= SWITCH_MINIMUM_MS &&
    best.latencyMs <= current.latencyMs * SWITCH_RATIO
  return meaningful ? best : current
}
