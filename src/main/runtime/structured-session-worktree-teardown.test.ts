import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

const hostRef: { current: unknown } = { current: null }

vi.mock('../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { killAllProcessesForWorktree } = await import('./worktree-teardown')
const {
  classifyWorktreeForceDeleteReason,
  isProvenLiveStructuredSessionRemovalError,
  isUnstoppedPtyRemovalError
} = await import('../../shared/worktree/removal')
const { listLiveStructuredSessionsForWorktree } =
  await import('./structured-session-worktree-teardown')

const WORKTREE = 'repo_1::/tmp/wt-a'
const OTHER_WORKTREE = 'repo_1::/tmp/wt-b'

function record(
  sessionId: string,
  workspaceId: string,
  options: { provider?: 'claude' | 'codex'; executionHostId?: string } = {}
): AgentSessionRecord {
  return {
    sessionId,
    provider: options.provider ?? 'claude',
    location: {
      executionHostId: options.executionHostId ?? 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'folder'
    },
    lease: {
      sessionId,
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null,
      runtimeFence: 1,
      deathEvidence: null
    }
  } as unknown as AgentSessionRecord
}

function installHost(options: {
  records: AgentSessionRecord[]
  /** Sessions the host keeps holding through a close, so the post-close observation is `live`. */
  stuck?: Set<string>
  /** Sessions the host drops without death evidence, so the observation is `unverifiable`. */
  unverifiable?: Set<string>
  /** Sessions whose child dies and is recorded dead, but whose close then fails past that point. */
  settledThenThrows?: Set<string>
  /** Blocks every close, to exercise the shared sweep budget without fake timers. */
  closeGate?: Promise<void>
}): { closed: string[] } {
  const held = new Set(options.records.map((entry) => entry.sessionId))
  const closed: string[] = []
  hostRef.current = {
    deps: { store: { listRecords: () => options.records, getRecord: () => null } },
    hasSession: (sessionId: string) => held.has(sessionId),
    setSessionTabVisibility: async () => {},
    close: async (sessionId: string) => {
      closed.push(sessionId)
      await options.closeGate
      if (options.stuck?.has(sessionId)) {
        return
      }
      held.delete(sessionId)
      if (options.unverifiable?.has(sessionId)) {
        return
      }
      const record = options.records.find((entry) => entry.sessionId === sessionId)
      if (record) {
        record.lease.claimStatus = 'released'
        record.lease.deathEvidence = { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
      }
      if (options.settledThenThrows?.has(sessionId)) {
        throw new Error('the event sink could not be flushed')
      }
    }
  }
  // `observeStructuredWorker` reads the record through the same host, so keep them consistent.
  ;(
    hostRef.current as { deps: { store: { getRecord: (id: string) => unknown } } }
  ).deps.store.getRecord = (sessionId: string) =>
    options.records.find((entry) => entry.sessionId === sessionId) ?? null
  return { closed }
}

const localProvider = {
  listProcesses: async () => [],
  shutdown: async () => {}
} as never

function destructiveDeps(extra: { allowUnverifiedStop?: boolean; timeoutMs?: number } = {}) {
  return {
    localProvider,
    requirePhysicalStop: true,
    includeProviderInventory: false as const,
    includeLocalRegistry: false as const,
    ...extra
  }
}

describe('worktree teardown and structured agent sessions', () => {
  beforeEach(() => {
    hostRef.current = null
  })

  it('finds sessions by workspace, and ignores a sibling worktree', () => {
    installHost({ records: [record('s1', WORKTREE), record('s2', OTHER_WORKTREE)] })
    expect(listLiveStructuredSessionsForWorktree(WORKTREE, {})).toEqual([
      { sessionId: 's1', agent: 'claude' }
    ])
  })

  it('closes a live session on an ordinary removal instead of refusing it', async () => {
    // The defect this pins, and the reason the guard is not simply deleted: all three PTY sweeps
    // enumerate leaves, provider sessions and the local registry, and a structured session is on
    // NONE of them, so removal used to proceed leaving the provider child running with its `cwd`
    // deleted. The stop belongs on the ordinary path — the same one that kills a terminal running
    // the same agent — so an idle chat is no harder to delete than that terminal.
    const host = installHost({ records: [record('s1', WORKTREE)] })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      structuredStopped: 1
    })
    expect(host.closed).toEqual(['s1'])
  })

  it('refuses only when the close does not settle', async () => {
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(
      /still live: 1 agent session \(claude\)/
    )
  })

  it('names the force escape hatch in the refusal, like the unstopped-PTY gate', async () => {
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).rejects.toThrow(/force/i)
  })

  it('classifies for the desktop Force Delete button, not just the CLI', async () => {
    // The #11960 dead end, and the shape this file's own comments warn about: the desktop
    // affordance comes ONLY from the classifier, and an ordinary delete already passes force:true
    // for the dirty-file skip — so a refusal with no matcher shows raw CLI wording with no button.
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(classifyWorktreeForceDeleteReason(error as string, true)).toBe('running-agent-session')
    // Nulled once the waiver is spent, exactly as `unstopped-pty` is, so the button does not
    // reappear on a delete the user already forced.
    expect(classifyWorktreeForceDeleteReason(error as string, true, true)).toBeNull()
  })

  it('keeps session ids out of a message users and agents read', async () => {
    // A session id is one tab-id hop from the random pane key that gates a worker's mailbox, and
    // this string reaches CLI output and a desktop toast. A count and the providers are what a
    // user deciding whether to force actually needs.
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).not.toContain('s1')
    expect(error).toContain('1 agent session (claude)')
  })

  it('closes best-effort for a folder-workspace removal, which requires no stop proof', async () => {
    // Those paths sweep and kill PTYs without `requirePhysicalStop`, so the structured sweep used
    // to no-op there and left a live session bound to a workspace Orca was about to forget. They
    // do not refuse: the root is shared so no checkout vanishes, and one of them is a never-throw
    // forget that a refusal would wedge.
    const host = installHost({ records: [record('s1', WORKTREE)] })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false,
        closeStructuredSessions: true
      })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    expect(host.closed).toEqual(['s1'])
  })

  it('closes them under force instead of orphaning the child', async () => {
    const host = installHost({ records: [record('s1', WORKTREE), record('s2', WORKTREE)] })
    const result = await killAllProcessesForWorktree(
      WORKTREE,
      destructiveDeps({ allowUnverifiedStop: true })
    )
    expect(host.closed).toEqual(['s1', 's2'])
    expect(result.structuredStopped).toBe(2)
  })

  it('still removes under force when a close does not settle, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const result = await killAllProcessesForWorktree(
      WORKTREE,
      destructiveDeps({ allowUnverifiedStop: true })
    )
    expect(result.structuredStopped).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still attached'))
    warn.mockRestore()
  })

  it('takes the proof when a failed close is re-observed as exited', async () => {
    // `closeStructuredAgentSessionChild` reports `stopped: false` for anything that throws past its
    // own observation, and for a record whose death evidence lands after it read. The re-read here
    // can still PROVE the exit — refusing a delete over a child that is demonstrably gone is the
    // defect this whole sweep exists to remove, so the proof has to win over the close's verdict.
    const retired: string[] = []
    const runtime = {
      stopTerminalsForWorktree: async () => ({ stopped: 0 }),
      retireStructuredAgentSessionTabFromSnapshot: (sessionId: string) => {
        retired.push(sessionId)
        return true
      }
    } as never
    installHost({ records: [record('s1', WORKTREE)], settledThenThrows: new Set(['s1']) })
    await expect(
      killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    // Retired here because the close gave up before its own retirement step, and a chat tab left
    // behind re-attaches a released session pointing at a workspace that is about to be deleted.
    expect(retired).toEqual(['s1'])
  })

  it('leaves the best-effort reconciliation paths alone', async () => {
    // Those callers repair state and delete nothing, so a refusal there would wedge a repair.
    installHost({ records: [record('s1', WORKTREE)] })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        localProvider,
        includeProviderInventory: false,
        includeLocalRegistry: false
      })
    ).resolves.toMatchObject({ runtimeStopped: 0 })
  })

  it('leaves a same-id workspace on another execution host alone', async () => {
    // A workspace id is `repoId::path` with no host component, so the local, SSH and paired-runtime
    // copies of one id are DIFFERENT workspaces. Unfenced, deleting the local one closed a chat
    // running on somebody else's machine — a destructive cross-host act, not a spurious refusal.
    const host = installHost({
      records: [record('s1', WORKTREE, { executionHostId: 'ssh:host-a' })]
    })
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      runtimeStopped: 0
    })
    expect(host.closed).toEqual([])
  })

  it('closes only the session on the host the removal resolved to', async () => {
    const host = installHost({
      records: [record('s1', WORKTREE, { executionHostId: 'ssh:host-a' }), record('s2', WORKTREE)]
    })
    await expect(
      killAllProcessesForWorktree(WORKTREE, {
        ...destructiveDeps(),
        resolvedConnectionId: 'host-a'
      })
    ).resolves.toMatchObject({ structuredStopped: 1 })
    expect(host.closed).toEqual(['s1'])
  })

  it('names only the sessions that stayed, and every provider still there', async () => {
    installHost({
      records: [
        record('s1', WORKTREE),
        record('s2', WORKTREE, { provider: 'codex' }),
        record('s3', WORKTREE)
      ],
      stuck: new Set(['s2', 's3'])
    })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).toContain('still live: 2 agent sessions (claude, codex)')
  })

  it('names the unconfirmed sessions too, instead of counting only the live ones', async () => {
    // The PTY sibling may drop everything outside its live list because a fresh inventory PROVED
    // those exited. Nothing proves that here: an `unverifiable` session is unclosed as well, so
    // naming only the live subset told the user "1 agent session" while two were about to go.
    installHost({
      records: [record('s1', WORKTREE), record('s2', WORKTREE, { provider: 'codex' })],
      stuck: new Set(['s1']),
      unverifiable: new Set(['s2'])
    })
    const error = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(error).toContain(
      'still live: 1 agent session (claude); could not confirm these closed: 1 agent session (codex)'
    )
    // The marker still leads, so the toast keeps showing the stronger of the two warnings.
    expect(isProvenLiveStructuredSessionRemovalError(error as string)).toBe(true)
  })

  it('still reports what it closed when a forced removal skips the PTY verdict', async () => {
    // A sweep that fails outright short-circuits the per-PTY verdict — but not the structured
    // close that already ran, so the count has to survive that return or the removal log claims
    // `structured=0` for chats it just ended.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = {
      stopTerminalsForWorktree: async () => {
        throw new Error('the terminal sweep died')
      }
    } as never
    const host = installHost({ records: [record('s1', WORKTREE)] })
    const result = await killAllProcessesForWorktree(WORKTREE, {
      ...destructiveDeps({ allowUnverifiedStop: true }),
      runtime
    })
    expect(host.closed).toEqual(['s1'])
    expect(result.structuredStopped).toBe(1)
    warn.mockRestore()
  })

  it('separates a close it could not confirm from one it watched stay attached', async () => {
    // `src/shared/worktree/removal.ts` keeps these two apart on purpose: a user waiving "we could
    // not confirm" is making a different decision than one discarding a conversation Orca just saw
    // running. The toast branches on this marker, so flattening them makes one of the two a lie.
    installHost({ records: [record('s1', WORKTREE)], unverifiable: new Set(['s1']) })
    const unconfirmed = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(unconfirmed).toContain('could not confirm these closed: 1 agent session (claude)')
    expect(isProvenLiveStructuredSessionRemovalError(unconfirmed as string)).toBe(false)

    installHost({ records: [record('s1', WORKTREE)], stuck: new Set(['s1']) })
    const live = await killAllProcessesForWorktree(WORKTREE, destructiveDeps()).catch(
      (thrown: Error) => thrown.message
    )
    expect(isProvenLiveStructuredSessionRemovalError(live as string)).toBe(true)
  })

  it('refuses in agent-session wording when the close outlives the sweep budget', async () => {
    // A structured close that runs out of time used to reject with the PTY timeout sentinel, which
    // the classifier reads FIRST — so the toast blamed terminals, and the Force Delete meant to
    // clear the wedge hit the same rejection again (#11960).
    installHost({ records: [record('s1', WORKTREE)], closeGate: new Promise<void>(() => {}) })
    const error = await killAllProcessesForWorktree(
      WORKTREE,
      destructiveDeps({ timeoutMs: 5 })
    ).catch((thrown: Error) => thrown.message)
    expect(error).toContain('could not confirm these closed: 1 agent session (claude)')
    expect(isUnstoppedPtyRemovalError(error as string)).toBe(false)
    expect(classifyWorktreeForceDeleteReason(error as string, true)).toBe('running-agent-session')
  })

  it('never wedges Force Delete on a close that will not settle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installHost({ records: [record('s1', WORKTREE)], closeGate: new Promise<void>(() => {}) })
    await expect(
      killAllProcessesForWorktree(
        WORKTREE,
        destructiveDeps({ allowUnverifiedStop: true, timeoutMs: 5 })
      )
    ).resolves.toMatchObject({ runtimeStopped: 0 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still attached'))
    warn.mockRestore()
  })

  it('starts the terminal sweeps while the structured close is still in flight', async () => {
    // The close is serial and each one waits on a provider round trip. Awaiting it before the
    // sweeps exist spends the shared budget head-first, and the sweeps then report a timeout for
    // a stop they never attempted.
    let releaseClose: () => void = () => {}
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    installHost({ records: [record('s1', WORKTREE)], closeGate })
    let terminalSweepStarted = false
    const runtime = {
      stopTerminalsForWorktree: async () => {
        terminalSweepStarted = true
        return { stopped: 0 }
      }
    } as never
    const removal = killAllProcessesForWorktree(WORKTREE, { ...destructiveDeps(), runtime })
    await vi.waitFor(() => {
      expect(terminalSweepStarted).toBe(true)
    })
    releaseClose()
    await expect(removal).resolves.toMatchObject({ structuredStopped: 1 })
  })

  it('does not block removal when no structured host is installed', async () => {
    // Not being able to look is not evidence a child is there, and reading the persisted store
    // directly would force-install the host as a side effect of a teardown.
    await expect(killAllProcessesForWorktree(WORKTREE, destructiveDeps())).resolves.toMatchObject({
      runtimeStopped: 0
    })
  })
})
