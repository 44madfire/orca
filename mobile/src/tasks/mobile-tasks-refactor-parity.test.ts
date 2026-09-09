import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  readFlattenedMobileTasksHookSignatures,
  readMobileTasksSemanticSource,
  readMobileTasksStyleSource
} from './mobile-tasks-source-family.test-support'
import { readFlattenedMobileTasksRenderTokens } from './mobile-tasks-render-parity.test-support'
import {
  readFlattenedMobileTasksCoreStatements,
  readMobileTasksDeclarationSignatures
} from './mobile-tasks-execution-parity.test-support'

const hash = (parts: string[] | string): string =>
  createHash('sha256')
    .update(Array.isArray(parts) ? parts.join('\n') : parts)
    .digest('hex')

/**
 * Re-frozen when the Tasks screens stopped calling `client.sendRequest` and started calling the
 * host operation adapters. Every RPC envelope check, response cast and payload literal moved out
 * of the composition into `native-host-task-*-operations.ts`, so the semantic source shrinks and
 * the render tree loses the two casts that lived inside JSX callbacks. Screen hooks gain the three
 * `useMemo` adapter bindings in `useMobileTasksRouteAndItemState`; statements gain the same three
 * plus the row-target locals the adapters take in place of inline slug/number checks. Diff hooks,
 * declarations and styles are untouched.
 */
const SCREEN_HOOKS = 'b5d85ab1cd2996a6986604caf497c8a577dc118b095c49d555c576d98f48148f'
const DIFF_HOOKS = '93c7189b32bed8456cc51814fffa8ce80cf62011ef968a9d53ddec2b9686f58f'
const STATEMENTS = '1d059c8359400f2aedb16c94a7dba0c8a21b5a06edb45e2b0b7ff0317250d564'
const DECLARATIONS = 'cff54172af17a877789be1479c2eb6ca97d83c3e31dd831cd59395962f2b4c4a'
const SEMANTICS = 'f767906884b93537f2c6369d6d0bd2d4cb39b4314c31cca9d8f9e5e9b78a75ee'
const STYLES = '1db6af69c791d9963928541ad5310942fcbda6d984b422c90b6eb92b6816579a'
const RENDER_TREE = 'a959c6712c70024127a429a47ae7689c629393752fa99a1ac6ba311d0bf13ca6'

describe('Mobile Tasks refactor parity', () => {
  it('preserves recursively flattened hook and dependency order', () => {
    const screenHooks = readFlattenedMobileTasksHookSignatures('MobileTasksScreen')
    expect(screenHooks).toHaveLength(353)
    expect(hash(screenHooks)).toBe(SCREEN_HOOKS)

    const diffHooks = readFlattenedMobileTasksHookSignatures('GitHubPrFileDiff')
    expect(diffHooks).toHaveLength(3)
    expect(hash(diffHooks)).toBe(DIFF_HOOKS)
  })

  it('preserves every screen statement in execution order', () => {
    const statements = readFlattenedMobileTasksCoreStatements()
    expect(statements).toHaveLength(420)
    expect(hash(statements)).toBe(STATEMENTS)
  })

  it('preserves every moved top-level declaration', () => {
    const declarations = readMobileTasksDeclarationSignatures()
    expect(declarations).toHaveLength(193)
    expect(hash(declarations)).toBe(DECLARATIONS)
  })

  it('preserves RPC calls, runtime strings, and JSX host signatures', () => {
    const semantics = readMobileTasksSemanticSource()
    expect(semantics.split('\n')).toHaveLength(3_278)
    expect(hash(semantics)).toBe(SEMANTICS)
  })

  it('preserves render expressions and event handlers in tree order', () => {
    const tokens = readFlattenedMobileTasksRenderTokens()
    expect(tokens).toHaveLength(35_193)
    expect(hash(tokens)).toBe(RENDER_TREE)
  })

  it('preserves every StyleSheet property and value', () => {
    expect(hash(readMobileTasksStyleSource())).toBe(STYLES)
  })
})
