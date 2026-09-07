import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RELAY_REGIONS } from './relay-region-probe'

// Read as text, not imported: `cloud/` is a separate pnpm workspace on a different zod major that
// the desktop build never installs, so a TS import would not resolve here.
const CONTRACT_SOURCE = readFileSync(
  new URL('../../../../cloud/packages/relay-contract/src/relay-regions.ts', import.meta.url),
  'utf8'
)

const DECLARATION = /^export const RELAY_REGIONS = \[([^\]]+)\] as const(?: satisfies .+)?$/gm
const QUOTED_REGION = /^(['"])([^'"]+)\1$/

// Without this a commented-out declaration is matched instead of the live one. The contract file
// keeps no `//` inside a string literal, so block comments plus whole-line `//` cover it.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('RELAY_REGIONS', () => {
  it('matches the relay contract exactly, region for region and in order', () => {
    const declarations = [...stripComments(CONTRACT_SOURCE).matchAll(DECLARATION)]
    // Exactly one: zero means the shape moved, and a second live-looking one means this test
    // would be pinning against whichever came first.
    expect(
      declarations.length,
      'relay-regions.ts must declare RELAY_REGIONS exactly once as an inline array'
    ).toBe(1)

    const elements = declarations[0]![1]!.split(',').map((element) => element.trim())
    if (elements.at(-1) === '') {
      elements.pop() // trailing comma
    }
    expect(elements.length).toBeGreaterThan(0)
    const contractRegions = elements.map((element) => {
      const quoted = QUOTED_REGION.exec(element)
      // Every element must parse: silently skipping one would hide a contract region from the
      // comparison below and let the two lists diverge while this test stayed green.
      expect(
        quoted,
        `relay-regions.ts element is not a quoted string literal: ${element}`
      ).not.toBeNull()
      return quoted![2]
    })

    // A longer desktop list withholds the region hint fleet-wide (the catalog can never reach
    // RELAY_REGIONS.length); a shorter one caches a hint won against an incomplete catalog. Order
    // is pinned too because bestMeasurement breaks latency ties on the RELAY_REGIONS index.
    expect([...RELAY_REGIONS]).toEqual(contractRegions)
  })
})
