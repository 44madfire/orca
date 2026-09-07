import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RELAY_REGIONS } from './relay-region-probe'

// Read as text, not imported: `cloud/` is a separate pnpm workspace on a different zod major that
// the desktop build never installs, so a TS import would not resolve here.
const CONTRACT_SOURCE = readFileSync(
  new URL('../../../../cloud/packages/relay-contract/src/relay-regions.ts', import.meta.url),
  'utf8'
)

describe('RELAY_REGIONS', () => {
  it('matches the relay contract exactly, region for region and in order', () => {
    const declaration = /^export const RELAY_REGIONS = \[([^\]]+)\] as const$/m.exec(
      CONTRACT_SOURCE
    )
    expect(
      declaration,
      'relay-regions.ts no longer declares RELAY_REGIONS as an inline array'
    ).not.toBeNull()
    const contractRegions = [...declaration![1].matchAll(/'([^']+)'/g)].map(([, region]) => region)
    expect(contractRegions.length).toBeGreaterThan(0)

    // A longer desktop list withholds the region hint fleet-wide (the catalog can never reach
    // RELAY_REGIONS.length); a shorter one caches a hint won against an incomplete catalog. Order
    // is pinned too because bestMeasurement breaks latency ties on the RELAY_REGIONS index.
    expect([...RELAY_REGIONS]).toEqual(contractRegions)
  })
})
