// PIF-8 (#29): structured → TUI planning and TUI → structured epoch import for
// Pi and OMP. The exact provider file reaches launch planning, the matching
// executable resumes it, an unproven native close prevents the launch, and the
// TUI leg reconciles into the journal epoch exactly once with stable ids.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session-provider-handle'
import {
  getAgentResumeArgv,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { buildPiTuiResumeProviderSession } from '../../pi/pi-structured-tui-resume'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { journalDirectoryFor } from '../agent-session-journal/journal-paths'
import { importTuiHistory } from './structured-agent-session-host-handoff-history'
import { handoffStructuredSessionToTui } from './structured-agent-session-handoff-forward'

type Provider = 'pi' | 'omp'

function fileFor(provider: Provider): string {
  return join(tmpdir(), `${provider}-ses-9.jsonl`)
}

function recordWithChain(
  provider: Provider,
  chain: AgentSessionProviderHandleLink[]
): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId: `session-${provider}-9`,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider,
    providerHandleChain: chain,
    accountHome: { variable: 'PI_STATE_DIR', path: join(tmpdir(), 'pi-state') },
    lease: {
      sessionId: `session-${provider}-9`,
      runtimeKind: 'native',
      runtimeFence: 3,
      handoffStage: null,
      provenHandleLinkId: 'link-1',
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 0,
    updatedAt: 0
  }
}

function fileLink(provider: Provider, sessionFile: string): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-1',
    handle: { provider, sessionId: `${provider}-ses-9`, leafId: 'leaf-9', sessionFile },
    origin: 'created',
    mintedAtFence: 3,
    observedAt: 0
  }
}

describe.each(['pi', 'omp'] as const)('structured → TUI planning for %s', (provider) => {
  it('routes the exact provider file to the matching executable', () => {
    const providerSession: AgentProviderSessionMetadata = buildPiTuiResumeProviderSession(
      recordWithChain(provider, [fileLink(provider, fileFor(provider))])
    )
    expect(providerSession).toEqual({
      key: 'session_id',
      id: `${provider}-ses-9`,
      transcriptPath: fileFor(provider)
    })
    expect(getAgentResumeArgv(provider, providerSession)).toEqual(
      provider === 'pi'
        ? ['pi', '--session', fileFor(provider)]
        : ['omp', '--resume', fileFor(provider)]
    )
  })

  it('fails closed on a missing or relative locator without naming any path', () => {
    // A file-less chain as persisted JSON would decode it: no static type.
    const bare: AgentSessionProviderHandleLink = JSON.parse(
      JSON.stringify({
        linkId: 'link-1',
        handle: { provider, sessionId: `${provider}-ses-9`, leafId: 'leaf-9' },
        origin: 'created',
        mintedAtFence: 3,
        observedAt: 0
      })
    )
    let message = ''
    try {
      buildPiTuiResumeProviderSession(recordWithChain(provider, [bare]))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('agent_session_identity_required')
    expect(message).not.toContain('jsonl')
    const relative = recordWithChain(provider, [fileLink(provider, 'relative/x.jsonl')])
    expect(() => buildPiTuiResumeProviderSession(relative)).toThrow(
      'agent_session_identity_required'
    )
    // A present leaf must be well-formed; only null (empty session) is accepted.
    const link = fileLink(provider, fileFor(provider))
    const malformedLink: AgentSessionProviderHandleLink = JSON.parse(
      JSON.stringify({ ...link, handle: { ...link.handle, leafId: '  ' } })
    )
    const malformed = recordWithChain(provider, [malformedLink])
    expect(() => buildPiTuiResumeProviderSession(malformed)).toThrow(
      'agent_session_identity_required'
    )
  })

  it('refuses to cross-open a Pi file with OMP and vice versa', () => {
    const other: Provider = provider === 'pi' ? 'omp' : 'pi'
    const crossed = recordWithChain(provider, [fileLink(other, fileFor(other))])
    expect(() => buildPiTuiResumeProviderSession(crossed)).toThrow(
      'agent_session_identity_required'
    )
  })
})

describe.each(['pi', 'omp'] as const)('structured → TUI close gate for %s', (provider) => {
  it('an unproven native close prevents the TUI launch', async () => {
    const record = recordWithChain(provider, [fileLink(provider, fileFor(provider))])
    const launchTui = vi.fn(async () => undefined)
    // Only suspendNative and the launch gate are exercised; the remaining
    // flow surface is stubbed and never reached past the unproven exit.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed flow stub with the exact deps this gate path calls.
    const context = {
      deps: {
        store: {},
        claimKeyId: 'key-1',
        now: () => 1,
        suspendNative: async () => ({ state: 'live' as const }),
        transport: { launchTui }
      },
      requireRecord: () => record,
      enterPreparing: vi.fn(async () => undefined),
      publishStage: vi.fn(),
      owner: () => undefined,
      retainOwner: vi.fn(),
      releaseOwner: vi.fn(),
      setStatus: vi.fn()
    } as never
    await expect(
      handoffStructuredSessionToTui(
        context,
        {
          envelope: {
            sessionId: record.sessionId,
            clientOperationId: 'op-1',
            expectedRuntimeFence: 3,
            payloadFingerprint: 'fp'
          },
          direction: 'to-tui',
          mode: 'now'
        },
        false
      )
    ).rejects.toThrow('agent_session_owner_exit_unproven')
    expect(launchTui).not.toHaveBeenCalled()
  })
})

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-pi-tui-import-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

function resumeRows() {
  return [
    { id: 'a', role: 'user', text: 'alpha' },
    { id: 'b', role: 'assistant', text: 'beta' },
    { id: 't', role: 'tool', text: 'output' },
    { id: 's', role: 'system', text: 'note' }
  ]
}

describe.each(['pi', 'omp'] as const)('TUI → structured epoch import for %s', (provider) => {
  async function importInto(rows: { id: string; role: string; text: string }[]) {
    const record = recordWithChain(provider, [fileLink(provider, fileFor(provider))])
    const journal = await journals.open({
      identity: {
        sessionId: record.sessionId,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: provider,
        providerHandle: { kind: 'opaque', agent: provider, value: 'pending' }
      },
      journalDir: journalDirectoryFor(root, {
        workspaceId: 'workspace-1',
        sessionId: record.sessionId
      })
    })
    const reset = vi.fn()
    // Only the record lookup and resume read are exercised; the rest of the
    // host surface is stubbed and never reached by the provider-resume path.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed handoff stub with the exact deps/host this import path calls.
    const deps = {
      store: { getRecord: () => record },
      adapter: { readResumeHistory: async () => ({ rows, leafId: 'e' }) }
    } as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: narrowed handoff stub with the exact session/subscribers this import path calls.
    const host = {
      session: () => ({ journal }),
      subscribers: { reset }
    } as never
    await importTuiHistory(deps, host, { sessionId: record.sessionId, fence: 3 })
    journals.track(journal)
    return { journal, reset, record, deps, host }
  }

  it('replaces the epoch with the active chain exactly once under stable ids', async () => {
    const { journal, reset } = await importInto(resumeRows())
    const items = journal.snapshot().items
    // System rows never become journal items; every other row carries the
    // provider discriminant plus the stable provider entry id.
    expect(items).toHaveLength(3)
    for (const item of items) {
      expect(item.itemId).toContain(provider)
    }
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: a retried import reconciles to the same epoch', async () => {
    const { journal, record, deps, host } = await importInto(resumeRows())
    const before = journal.snapshot().items.map((item) => item.itemId)
    await importTuiHistory(deps, host, { sessionId: record.sessionId, fence: 3 })
    expect(journal.snapshot().items.map((item) => item.itemId)).toEqual(before)
  })

  it('leaves the journal untouched when the TUI leg added no rows', async () => {
    const { journal, reset } = await importInto([])
    expect(journal.snapshot().items).toEqual([])
    expect(reset).not.toHaveBeenCalled()
  })
})
