import { expect, it, vi } from 'vitest'
import { RuntimeAiVaultCommands } from './runtime-ai-vault-commands'
import type { RuntimeStore } from './runtime-store-contract'

const apply = vi.hoisted(() =>
  vi.fn(async (_settings: unknown, options: { persist?: () => Promise<void> }) => {
    await options.persist?.()
    return null
  })
)
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applyAiVaultSearchSettings: apply,
  readAiVaultSearchIndexStatus: () => ({
    enabled: true,
    historyDays: null,
    indexSizeBytes: 0,
    available: true,
    applied: true
  })
}))

it('does not acknowledge enabling until the durable store barrier completes', async () => {
  let release!: () => void
  const flushed = new Promise<void>((resolve) => {
    release = resolve
  })
  const flushPendingOrThrowAsync = vi.fn(() => flushed)
  const store = {
    getSettings: () => ({}),
    updateSettings: vi.fn(),
    flushPendingOrThrowAsync
  } as unknown as RuntimeStore
  const commands = new RuntimeAiVaultCommands(
    () => null,
    () => store
  )
  let acknowledged = false
  const pending = commands.configureSearch({ enabled: true }).then((status) => {
    acknowledged = true
    return status
  })
  await vi.waitFor(() =>
    expect(flushPendingOrThrowAsync).toHaveBeenCalledWith({ drainToStableGeneration: false })
  )
  expect(acknowledged).toBe(false)
  release()
  expect(await pending).toMatchObject({ enabled: true, applied: true })
})

it('reports persistence failure instead of returning a successful policy acknowledgement', async () => {
  const store = {
    getSettings: () => ({}),
    updateSettings: vi.fn(),
    flushPendingOrThrowAsync: vi.fn().mockRejectedValue(new Error('disk full'))
  } as unknown as RuntimeStore
  const commands = new RuntimeAiVaultCommands(
    () => null,
    () => store
  )
  await expect(commands.configureSearch({ enabled: true })).rejects.toThrow('disk full')
})
