// SNC1.9 regression: native Pi acquire → durable handoff record → TUI launch
// planning → restart/resume, preserving the exact Pi session and current leaf.
//
// Proves the `pi --session <session-file>` locator is host-owned end to end:
// minted by the adapter from backend output, persisted on the durable provider
// chain, read back after a persistence round-trip, and never taken from client
// input or emitted in errors/logs.

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandleKey,
  appendAgentSessionProviderHandleLink,
  type AgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import { journalIdentityFor } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import {
  PiStructuredSessionAdapter,
  type PiStructuredBackend
} from './pi-structured-session-adapter'
import { buildPiTuiResumeProviderSession } from './pi-structured-tui-resume'

const PI_SESSION_ID = 'pi-ses-9'
const PI_LEAF = 'leaf-42'
// Absolute on every platform the host runs on, so the planner accepts it.
const PI_FILE = join(tmpdir(), 'pi-ses-9.jsonl')

function fakeBackend(): PiStructuredBackend {
  return {
    acquire: async () => ({
      piSessionId: PI_SESSION_ID,
      leafId: PI_LEAF,
      pid: 4242,
      sessionFilePath: PI_FILE
    }),
    dispatch: async () => ({ status: 'accepted' as const }),
    cancel: async () => ({ cancelled: true }),
    close: async () => true
  }
}

function adapter(): PiStructuredSessionAdapter {
  return new PiStructuredSessionAdapter({
    resolveWorkspacePath: () => join(tmpdir(), 'ws'),
    backend: fakeBackend(),
    readProcessStartTime: async () => 12345
  })
}

function freshIdentity(sessionId: string) {
  return {
    sessionId,
    workspaceId: 'workspace-1',
    hostId: 'local',
    agent: 'pi' as const,
    providerHandle: { kind: 'opaque' as const, agent: 'pi' as const, value: 'pending' }
  } as never
}

function piRecord(link: AgentSessionProviderHandleLink): AgentSessionRecord {
  return {
    schemaVersion: 2,
    sessionId: 'session-pi-9',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'pi',
    providerHandleChain: [link],
    accountHome: { variable: 'PI_STATE_DIR', path: join(tmpdir(), 'pi-state') },
    lease: {
      sessionId: 'session-pi-9',
      runtimeKind: 'native',
      runtimeFence: link.mintedAtFence,
      handoffStage: 'old-owner-stopped',
      provenHandleLinkId: link.linkId,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: 'op-1',
      journalCheckpoint: null,
      claimKeyId: 'key-1',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 0,
    updatedAt: 0
  } as unknown as AgentSessionRecord
}

describe('Pi native acquire → TUI launch planning', () => {
  it('builds the exact pi --session resume command from the durable chain', async () => {
    const acquired = await adapter().acquire({
      identity: freshIdentity('session-pi-9'),
      fence: 3,
      spawnToken: 'spawn-1'
    })
    // Host-observed locator is persisted on the durable link.
    expect(acquired.link.handle).toMatchObject({
      provider: 'pi',
      sessionId: PI_SESSION_ID,
      leafId: PI_LEAF,
      sessionFile: PI_FILE
    })
    const chain = appendAgentSessionProviderHandleLink([], acquired.link)
    const providerSession = buildPiTuiResumeProviderSession(piRecord(chain[0]!))
    expect(providerSession).toEqual({
      key: 'session_id',
      id: PI_SESSION_ID,
      transcriptPath: PI_FILE
    })
    expect(getAgentResumeArgv('pi', providerSession)).toEqual(['pi', '--session', PI_FILE])
  })

  it('survives a persistence round-trip and resumes the same session after restart', async () => {
    const acquired = await adapter().acquire({
      identity: freshIdentity('session-pi-9'),
      fence: 3,
      spawnToken: 'spawn-1'
    })
    const chain = appendAgentSessionProviderHandleLink([], acquired.link)
    // Restart: the record crosses JSON persistence with no adapter memory.
    const reloaded = JSON.parse(JSON.stringify(piRecord(chain[0]!))) as AgentSessionRecord
    const providerSession = buildPiTuiResumeProviderSession(reloaded)
    expect(getAgentResumeArgv('pi', providerSession)).toEqual(['pi', '--session', PI_FILE])
    // TUI→structured re-acquire resolves the same Pi session from the chain head.
    const params = hostTestAttachParams(null, { provider: 'pi', agent: 'pi' })
    const identity = journalIdentityFor(reloaded, params)
    expect(identity.providerHandle).toEqual({
      kind: 'opaque',
      agent: 'pi',
      value: `pi:${PI_SESSION_ID}`
    })
    const head = reloaded.providerHandleChain.at(-1)
    const resumeSessionFile =
      head?.handle.provider === 'pi' && head.handle.sessionFile ? head.handle.sessionFile : undefined
    const resumed = await adapter().acquire({
      identity,
      fence: 4,
      spawnToken: 'spawn-2',
      ...(resumeSessionFile ? { resumeSessionFile } : {})
    })
    expect(resumed.link.handle).toMatchObject({ provider: 'pi', sessionId: PI_SESSION_ID })
    // Same writer target: the resume did not fork a new Pi session.
    expect(agentSessionProviderHandleKey(resumed.link.handle)).toBe(
      agentSessionProviderHandleKey(chain[0]!.handle)
    )
  })
})

describe('OMP TUI resume planning mirrors Pi with the OMP executable', () => {
  const OMP_SESSION_ID = 'omp-ses-9'
  const OMP_FILE = join(tmpdir(), 'omp-ses-9.jsonl')
  const OMP_LEAF = 'leaf-77'

  function ompLink(): AgentSessionProviderHandleLink {
    return {
      linkId: 'omp-3-x-leaf',
      handle: { provider: 'omp', sessionId: OMP_SESSION_ID, leafId: OMP_LEAF, sessionFile: OMP_FILE },
      origin: 'created',
      mintedAtFence: 3,
      observedAt: 0
    }
  }

  function ompRecord(link: AgentSessionProviderHandleLink): AgentSessionRecord {
    return { ...piRecord(link), provider: 'omp', sessionId: 'session-omp-9' }
  }

  it('routes the exact OMP file to omp --resume', () => {
    const providerSession = buildPiTuiResumeProviderSession(ompRecord(ompLink()))
    expect(providerSession).toEqual({ key: 'session_id', id: OMP_SESSION_ID, transcriptPath: OMP_FILE })
    expect(getAgentResumeArgv('omp', providerSession)).toEqual(['omp', '--resume', OMP_FILE])
  })

  it('refuses a Pi file for an OMP record and an OMP file for a Pi record', () => {
    const piFileLink: AgentSessionProviderHandleLink = {
      linkId: 'pi-3-x-leaf',
      handle: { provider: 'pi', sessionId: PI_SESSION_ID, leafId: PI_LEAF, sessionFile: PI_FILE },
      origin: 'created',
      mintedAtFence: 3,
      observedAt: 0
    }
    const ompRecordWithPiFile = { ...ompRecord(ompLink()), providerHandleChain: [piFileLink] }
    expect(() => buildPiTuiResumeProviderSession(ompRecordWithPiFile)).toThrow(
      'agent_session_identity_required'
    )
    const piRecordWithOmpFile = { ...piRecord(piFileLink), providerHandleChain: [ompLink()] }
    expect(() => buildPiTuiResumeProviderSession(piRecordWithOmpFile)).toThrow(
      'agent_session_identity_required'
    )
  })
})

describe('Pi TUI resume planning fails closed', () => {
  it('refuses a missing or relative locator without naming any path', () => {
    // A file-less chain as persisted JSON would decode it: the planner must fail closed.
    const bare: AgentSessionProviderHandleLink = JSON.parse(
      JSON.stringify({
        linkId: 'pi-3-x-leaf',
        handle: { provider: 'pi', sessionId: PI_SESSION_ID, leafId: PI_LEAF },
        origin: 'created',
        mintedAtFence: 3,
        observedAt: 0
      })
    )
    expect(() => buildPiTuiResumeProviderSession(piRecord(bare))).toThrow(
      'agent_session_identity_required'
    )
    const relative = {
      ...bare,
      handle: { ...bare.handle, sessionFile: 'relative/pi.jsonl' }
    }
    let message = ''
    try {
      buildPiTuiResumeProviderSession(piRecord(relative))
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toBe('agent_session_identity_required')
    expect(message).not.toContain('relative/pi.jsonl')
  })

  it('ignores client-authored decoys and refuses non-pi records', () => {
    const link = {
      linkId: 'pi-3-x-leaf',
      handle: {
        provider: 'pi' as const,
        sessionId: PI_SESSION_ID,
        leafId: PI_LEAF,
        sessionFile: PI_FILE
      },
      origin: 'created' as const,
      mintedAtFence: 3,
      observedAt: 0
    }
    // A client-influenced field elsewhere on the record never steers the resume.
    const decoyed = {
      ...piRecord(link),
      options: { model: 'pi', transcriptPath: join(tmpdir(), 'evil.jsonl') },
      launchArgs: ['--session', join(tmpdir(), 'evil.jsonl')]
    } as unknown as AgentSessionRecord
    const providerSession = buildPiTuiResumeProviderSession(decoyed)
    expect(providerSession.transcriptPath).toBe(PI_FILE)
    expect(getAgentResumeArgv('pi', providerSession)).toEqual(['pi', '--session', PI_FILE])
    const codex = { ...piRecord(link), provider: 'codex' as const }
    expect(() => buildPiTuiResumeProviderSession(codex)).toThrow('agent_session_identity_required')
  })
})
