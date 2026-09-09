import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import type { CommitMessageModelCapability } from '../../../../../../shared/commit-message-agent-spec'
import {
  clearWorkerLaunchModelAuthorityCacheForTests,
  describeWorkerLaunchModelRejection,
  resolveWorkerLaunchModelAuthority,
  seedWorkerLaunchModelAuthority,
  type WorkerLaunchModelDiscoveryRuntime
} from './worker-launch-model-authority'

const CLAUDE_CATALOG = getAgentSessionOptionCatalog('claude')!
const CODEX_CATALOG = getAgentSessionOptionCatalog('codex')!

function liveModel(id: string, effortLevels: readonly string[] = []): CommitMessageModelCapability {
  return {
    id,
    label: id,
    ...(effortLevels.length > 0
      ? { thinkingLevels: effortLevels.map((level) => ({ id: level, label: level })) }
      : {})
  }
}

function probeRuntime(respond: (worktreeSelector: string) => unknown): {
  runtime: WorkerLaunchModelDiscoveryRuntime
  discover: ReturnType<typeof vi.fn>
} {
  const discover = vi.fn(async (worktreeSelector: string) => respond(worktreeSelector))
  return {
    runtime: { discoverRuntimeCommitMessageModels: discover } as never,
    discover
  }
}

function probeSuccess(models: readonly CommitMessageModelCapability[]): unknown {
  return {
    success: true,
    catalogOrigin: 'probe',
    models,
    defaultModelId: models[0]?.id ?? '',
    capability: {
      id: 'claude',
      label: 'Claude',
      modelSource: 'dynamic',
      models,
      defaultModelId: ''
    }
  }
}

describe('worker launch model authority', () => {
  beforeEach(() => {
    clearWorkerLaunchModelAuthorityCacheForTests()
  })

  it('seeds from the static catalog with each model’s own effort menu', () => {
    const authority = seedWorkerLaunchModelAuthority(CLAUDE_CATALOG)

    expect(authority.source).toBe('seed')
    expect(authority.models.map(({ id }) => id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    expect(authority.models.find(({ id }) => id === 'opus')?.effortChoices).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    // Haiku carries no effort option, so the unknown-id menu must not leak into it.
    expect(authority.models.find(({ id }) => id === 'haiku')?.effortChoices).toEqual([])
  })

  it('takes the live CLI list as the whole membership, dropping seed ids it omits', async () => {
    const { runtime } = probeRuntime(() =>
      probeSuccess([liveModel('opus[1m]', ['low', 'high', 'max']), liveModel('haiku')])
    )

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(authority.source).toBe('live')
    expect(authority.models.map(({ id }) => id)).toEqual(['opus[1m]', 'haiku'])
    expect(authority.models[0].effortChoices).toEqual(['low', 'high', 'max'])
  })

  it('keeps the catalog menu for a live model whose probe lists no effort levels', async () => {
    const { runtime } = probeRuntime(() => probeSuccess([liveModel('gpt-5.7-preview')]))

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CODEX_CATALOG,
      agent: 'codex',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    // The unknown-id menu is what the launch path can actually emit for an unseeded id.
    expect(authority.models[0].effortChoices).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
  })

  it('narrows the catalog menu to the levels the CLI advertises', async () => {
    const { runtime } = probeRuntime(() =>
      probeSuccess([liveModel('gpt-5.6-sol', ['low', 'ultra', 'not-a-launch-level'])])
    )

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CODEX_CATALOG,
      agent: 'codex',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(authority.models[0].effortChoices).toEqual(['low', 'ultra'])
  })

  it.each([
    { label: 'the probe throws', respond: () => Promise.reject(new Error('ssh down')) },
    { label: 'the probe fails', respond: () => ({ success: false, error: 'no CLI' }) },
    {
      label: 'the probe falls back to Orca’s own list',
      respond: () => ({ ...(probeSuccess([liveModel('opus')]) as object), catalogOrigin: 'spec' })
    },
    { label: 'the probe returns nothing', respond: () => probeSuccess([]) }
  ])('falls back to the seed when $label', async ({ respond }) => {
    const { runtime } = probeRuntime(respond as () => unknown)

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(authority).toEqual(seedWorkerLaunchModelAuthority(CLAUDE_CATALOG))
  })

  it('seeds without probing when no worktree names the executing host yet', async () => {
    const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: null
    })

    expect(authority.source).toBe('seed')
    expect(discover).not.toHaveBeenCalled()
  })

  it('reuses a cached list instead of probing the same host twice', async () => {
    const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))
    const args = {
      catalog: CLAUDE_CATALOG,
      agent: 'claude' as const,
      runtime,
      worktreeSelector: 'id:wt_local'
    }

    await resolveWorkerLaunchModelAuthority(args)
    const second = await resolveWorkerLaunchModelAuthority(args)

    expect(discover).toHaveBeenCalledTimes(1)
    expect(second.models.map(({ id }) => id)).toEqual(['opus[1m]'])
  })

  it('does not cache a failure, so the next dispatch retries the host', async () => {
    let attempt = 0
    const { runtime, discover } = probeRuntime(() => {
      attempt += 1
      return attempt === 1 ? { success: false, error: 'no CLI' } : probeSuccess([liveModel('opus')])
    })
    const args = {
      catalog: CLAUDE_CATALOG,
      agent: 'claude' as const,
      runtime,
      worktreeSelector: 'id:wt_local'
    }

    expect((await resolveWorkerLaunchModelAuthority(args)).source).toBe('seed')
    expect((await resolveWorkerLaunchModelAuthority(args)).source).toBe('live')
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('keys a remote host separately from the local one', async () => {
    const { runtime, discover } = probeRuntime((worktreeSelector) =>
      probeSuccess([liveModel(worktreeSelector === 'id:wt_remote' ? 'opus' : 'opus[1m]')])
    )

    const local = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })
    const remote = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_remote'
    })

    expect(discover).toHaveBeenCalledTimes(2)
    expect(local.models.map(({ id }) => id)).toEqual(['opus[1m]'])
    expect(remote.models.map(({ id }) => id)).toEqual(['opus'])
  })

  it('keys each agent separately on the same host', async () => {
    const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))

    await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })
    await resolveWorkerLaunchModelAuthority({
      catalog: CODEX_CATALOG,
      agent: 'codex',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('names the agent, the rejected id, the sorted accepted ids, and which list answered', () => {
    expect(
      describeWorkerLaunchModelRejection({
        agent: 'claude',
        model: 'claude-opus-5',
        authority: seedWorkerLaunchModelAuthority(CLAUDE_CATALOG)
      })
    ).toBe(
      'Agent claude does not accept model claude-opus-5. Accepted ids (the built-in list for claude; the claude CLI could not be listed on the executing host): fable, haiku, opus, sonnet.'
    )
    expect(
      describeWorkerLaunchModelRejection({
        agent: 'claude',
        model: 'claude-opus-5',
        authority: { source: 'live', models: [{ id: 'sonnet', effortChoices: [] }] }
      })
    ).toBe(
      'Agent claude does not accept model claude-opus-5. Accepted ids (listed by the claude CLI on the executing host): sonnet.'
    )
  })
})
