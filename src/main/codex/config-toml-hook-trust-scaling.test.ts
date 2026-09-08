import type * as HookTrustBlocks from './config-toml-hook-trust-blocks'
import { expect, it, vi } from 'vitest'
import { upsertHookTrustContent } from './config-toml-hook-trust-edit'

const counts = vi.hoisted(() => ({ starts: 0 }))
vi.mock('./config-toml-hook-trust-blocks', async (importOriginal) => {
  const actual = await importOriginal<typeof HookTrustBlocks>()
  return {
    ...actual,
    findHookTrustBlockRanges: (...args: Parameters<typeof actual.findHookTrustBlockRanges>) =>
      actual.findHookTrustBlockRanges(...args).map((range) => ({
        ...range,
        get start() {
          counts.starts += 1
          return range.start
        }
      }))
  }
})

it('consumes monotonically scanned trust ranges without pairwise deduplication', () => {
  const header = '[hooks.state."/foo/hooks.json:pre_tool_use:0:0"]'
  const content = `${header}\nenabled = true\ntrusted_hash = "old"\n`.repeat(1000)
  counts.starts = 0
  const result = upsertHookTrustContent(content, [
    {
      sourcePath: '/foo/hooks.json',
      eventLabel: 'pre_tool_use',
      groupIndex: 0,
      handlerIndex: 0,
      command: '/bin/echo hi',
      trustedHash: 'updated'
    }
  ])
  expect(counts.starts).toBeLessThan(5000)
  expect(result.split(header)).toHaveLength(2)
  expect(result).toContain('trusted_hash = "updated"')
})
