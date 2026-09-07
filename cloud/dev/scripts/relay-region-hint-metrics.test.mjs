import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Why: the region-hint skew alert divides the asia-east2 hint count by the sum of one log-based
// metric per hint key. That denominator is a hand-written list in Terraform, so a region added to
// the contract without a matching metric would shrink the denominator and inflate the share.

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const contractRegions = (() => {
  const source = read('../../packages/relay-contract/src/relay-regions.ts')
  const literal = /export const RELAY_REGIONS = \[([^\]]*)\]/.exec(source)
  assert.ok(literal, 'RELAY_REGIONS literal not found in relay-regions.ts')
  return [...literal[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
})()

const terraform = read('../../infra/terraform/relay-observability.tf')

const terraformHintKeys = (() => {
  const literal = /relay_region_hint_keys = \[([^\]]*)\]/.exec(terraform)
  assert.ok(literal, 'relay_region_hint_keys not found in relay-observability.tf')
  return [...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
})()

test('every relay region has a request-hint metric, plus the unhinted bucket', () => {
  assert.deepEqual([...terraformHintKeys].sort(), [...contractRegions, 'unhinted'].sort())
})

test('the skew alert numerator names a region the hint list actually covers', () => {
  const numerator = /value \[asia_hint_share: ([a-z0-9_]+) \//.exec(terraform)
  assert.ok(numerator, 'skew query numerator column not found')
  const columns = terraformHintKeys.map((key) => key.replaceAll('-', '_'))
  assert.ok(
    columns.includes(numerator[1]),
    `${numerator[1]} is not one of ${columns.join(', ')}`
  )
})
