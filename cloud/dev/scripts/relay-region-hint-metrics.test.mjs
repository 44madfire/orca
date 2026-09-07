import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: the region-skew alert compares asia-east2's share of assignment hints against its share of
// actual placements. Both shares are sums over one log-based metric per region, and the region
// list is written out by hand in Terraform. A region added to the contract without matching
// metrics would silently drop out of both denominators and move the ratio the alert fires on.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const collapse = (text) => text.replaceAll(/\s+/g, ' ')

const contractRegions = (() => {
  const source = read('../../packages/relay-contract/src/relay-regions.ts')
  const literal = /export const RELAY_REGIONS = \[([^\]]*)\]/.exec(source)
  assert.ok(literal, 'RELAY_REGIONS literal not found in relay-regions.ts')
  return [...literal[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
})()

const terraform = read('../../infra/terraform/relay-observability.tf')
const emitter = read('../../apps/relay/src/relay-observability.ts')

const terraformRegions = (() => {
  const literal = /relay_region_keys = \[([^\]]*)\]/.exec(terraform)
  assert.ok(literal, 'relay_region_keys not found in relay-observability.tf')
  return [...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
})()

test('terraform covers exactly the regions the contract can hint or select', () => {
  assert.deepEqual([...terraformRegions].sort(), [...contractRegions].sort())
})

test('terraform and the emitter derive the same flat field names', () => {
  // Both build `<prefix><Segment>Delta` from the hyphenated region id: Terraform title-cases each
  // dash-separated part, the emitter upper-cases each part's first character. Same result, two
  // languages, so the rules are pinned rather than the rendered names.
  assert.match(collapse(terraform), /join\("", \[for part in split\("-", key\) : title\(part\)\]\)/)
  assert.match(
    collapse(emitter),
    /\.split\('-'\) \.map\(\(part\) => part\.charAt\(0\)\.toUpperCase\(\) \+ part\.slice\(1\)\)/
  )
  for (const prefix of ['requestedRegion', 'selectedRegion']) {
    assert.ok(
      terraform.includes(`${prefix}\${local.relay_region_field_segments[key]}Delta`),
      `terraform does not build ${prefix}<Segment>Delta`
    )
    assert.ok(emitter.includes(`'${prefix}'`), `the emitter does not publish ${prefix} counters`)
  }
})

test('the skew query compares a catalogued region against itself', () => {
  const columns = terraformRegions.map((region) => region.replaceAll('-', '_'))
  const hint = /hint_share: req_([a-z0-9_]+) \//.exec(terraform)
  const placement = /placement_share: sel_([a-z0-9_]+) \//.exec(terraform)
  assert.ok(hint && placement, 'skew query share columns not found')
  assert.equal(hint[1], placement[1], 'the two shares must be about the same region')
  assert.ok(columns.includes(hint[1]), `${hint[1]} is not one of ${columns.join(', ')}`)
})

test('the unhinted bucket stays out of the skew denominators', () => {
  assert.ok(
    !terraformRegions.includes('unhinted'),
    'unhinted requests are a client-side choice, not a region; including them moves the share'
  )
})
