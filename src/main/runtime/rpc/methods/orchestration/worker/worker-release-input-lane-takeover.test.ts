import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { TERMINAL_SEND_METHODS } from '../../terminal/terminal-send-method'
import {
  isDeliberateHumanInput,
  sendTerminalStreamInput
} from '../../terminal/terminal-input-delivery'
import { isStreamingMethod, type RpcMethod } from '../../../core'
import { RuntimeTerminalWriter } from '../../../../runtime-terminal-writer'
import { getDefaultWorkspaceSession } from '../../../../../../shared/constants'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../../../../shared/workspace-session-state-types'
import type { RuntimeStore } from '../../../../runtime-store-contract'

const harness = createOrchestrationWorkerReleaseHarness()
const sendMethod = TERMINAL_SEND_METHODS.find(
  (method): method is RpcMethod => method.name === 'terminal.send' && !isStreamingMethod(method)
)!
const MOBILE_CLIENT = { id: 'phone-1', type: 'mobile' as const }
// The CLI names itself a desktop client, so an agent's `terminal send` is indistinguishable from a
// desktop keystroke at this layer — see src/cli/handlers/terminal-send.ts.
const CLI_CLIENT = { id: 'orca-cli', type: 'desktop' as const }
// A DSR reply xterm generates on its own; never something a human typed.
const QUERY_REPLY = '\u001b[0n'

async function callSend(params: Record<string, unknown>): Promise<unknown> {
  return sendMethod.handler(
    sendMethod.params!.parse(params) as never,
    {
      runtime: harness.runtime
    } as never
  )
}

// Only PTY delivery is stubbed; the real writer still drives reservation and after-write, so the
// test cannot invent the contract the takeover record hangs off.
function stubAcceptedWrite(): void {
  vi.spyOn(harness.runtime, 'beginMobileInputFloor').mockReturnValue({
    commit: async () => {},
    rollback: () => {}
  })
  vi.spyOn(harness.runtime, 'sendTerminal').mockImplementation(async (handle, action, options) => {
    await new RuntimeTerminalWriter(() => true).writeAction(
      'pty-worker',
      action,
      action.text ?? '',
      options
    )
    return { handle, accepted: true, bytesWritten: 3 }
  })
  vi.spyOn(harness.runtime, 'resolveLiveLeafForHandle').mockReturnValue({
    ptyId: 'pty-worker'
  } as never)
}

function ownership(dispatchId: string): string | undefined {
  return harness.db.getWorkerTerminalResourceByOwner(dispatchId)?.ownership_state
}

async function release(dispatchId: string): Promise<{ state: string; reason?: string }> {
  return (await harness.call('orchestration.workerRelease', { dispatch: dispatchId })) as {
    state: string
    reason?: string
  }
}

describe('settled worker terminal: who counts as a user takeover', () => {
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  it('desktop keystrokes fence the release', async () => {
    const worker = await harness.startSettledWorker()
    const takeover = (await harness.call('orchestration.workerTerminalUserInput', {
      paneKey: harness.workerPaneKey
    })) as { changed: number }
    expect(takeover.changed).toBe(1)

    expect(await release(worker.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('mobile keystrokes fence the release, because they are the same human input', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()

    await callSend({ terminal: 'term_worker', text: 'ls\r', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('user_owned')
    expect(await release(worker.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('mobile stream input frames fence the release too', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()

    await expect(
      sendTerminalStreamInput(harness.runtime, {
        terminal: 'term_worker',
        text: 'ls',
        client: MOBILE_CLIENT,
        isMobile: true
      })
    ).resolves.toBe('delivered')

    expect(ownership(worker.dispatchId)).toBe('user_owned')
    expect(await release(worker.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
  })

  it('an SSH-hosted worker terminal records the same takeover as a local one', async () => {
    vi.spyOn(harness.runtime, 'getOrchestrationDispatchAuthority').mockImplementation((handle) =>
      handle === 'term_worker'
        ? ({
            terminalHandle: handle,
            paneKey: harness.workerPaneKey,
            processIncarnation: 'runtime_test:term_worker:1',
            hostScope: { kind: 'ssh', targetId: 'ssh-1' }
          } as never)
        : null
    )
    const worker = await harness.startSettledWorker()
    expect(harness.db.getWorkerTerminalResourceByOwner(worker.dispatchId)?.host_scope).toContain(
      'ssh'
    )
    stubAcceptedWrite()

    await callSend({ terminal: 'term_worker', text: 'ls\r', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('user_owned')
    expect(await release(worker.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
  })

  it("a coordinator's terminal send to its worker is not a takeover", async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()

    await callSend({
      terminal: 'term_worker',
      text: 'status please',
      enter: true,
      agentPrompt: true,
      client: CLI_CLIENT
    })

    expect(ownership(worker.dispatchId)).toBe('owned')
    expect(await release(worker.dispatchId)).toMatchObject({ state: 'released' })
    expect(harness.runtime.closeTerminal).toHaveBeenCalledWith('term_worker')
  })

  it('a mobile query reply is the emulator answering, not a takeover', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()
    vi.spyOn(harness.runtime, 'isMobileTerminalQueryReplyAuthority').mockReturnValue(true)

    await callSend({
      terminal: 'term_worker',
      text: QUERY_REPLY,
      inputKind: 'query-reply',
      client: MOBILE_CLIENT
    })

    expect(ownership(worker.dispatchId)).toBe('owned')
    expect(await release(worker.dispatchId)).toMatchObject({ state: 'released' })
  })

  // owned -> user_owned is one-way per resource, so the database dedupes: later keystrokes match no
  // row, and the fence sweep each takeover pays for runs once rather than once per keystroke.
  it('settles into a single takeover however many keystrokes arrive', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()
    const swept = vi.spyOn(harness.runtime, 'prepareLegacyWorkerTerminalRecovery')

    await callSend({ terminal: 'term_worker', text: 'l', client: MOBILE_CLIENT })
    await callSend({ terminal: 'term_worker', text: 's', client: MOBILE_CLIENT })
    await callSend({ terminal: 'term_worker', text: '\r', client: MOBILE_CLIENT })

    expect(swept).toHaveBeenCalledTimes(1)
    expect(harness.db.getWorkerTerminalResourceByOwner(worker.dispatchId)).toMatchObject({
      ownership_state: 'user_owned',
      retained_reason: 'user_takeover'
    })
  })

  // A pane outlives the worker that borrowed it, so a takeover is scoped to the dispatch that owns
  // it now — never to the pane, and never to the answer an earlier dispatch produced.
  it('fences the worker that owns the pane now, not the one that just left it', async () => {
    const first = await harness.startSettledWorker()
    expect(await release(first.dispatchId)).toMatchObject({ state: 'released' })

    const second = await harness.startSettledWorker()
    expect(second.dispatchId).not.toBe(first.dispatchId)
    stubAcceptedWrite()
    await callSend({ terminal: 'term_worker', text: 'ls\r', client: MOBILE_CLIENT })

    expect(ownership(first.dispatchId)).toBe('released')
    expect(ownership(second.dispatchId)).toBe('user_owned')
    expect(await release(second.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(harness.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  // The pane had no owned resource yet when the first keystroke landed. Nothing about that answer
  // may survive into the population the worker's authority creates moments later.
  it('fences a keystroke that follows one typed before the worker owned the pane', async () => {
    stubAcceptedWrite()
    vi.spyOn(harness.runtime, 'waitForTerminal').mockImplementation(async () => {
      await callSend({ terminal: 'term_worker', text: 'x', client: MOBILE_CLIENT })
      return { handle: 'term_worker', satisfied: true, status: 'running', exitCode: null } as never
    })
    const worker = await harness.startSettledWorker()

    await callSend({ terminal: 'term_worker', text: 'y', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('user_owned')
    expect(await release(worker.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('retries a takeover the database refused on the very next keystroke', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()
    vi.spyOn(harness.db, 'markWorkerTerminalUserOwned').mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY')
    })

    await callSend({ terminal: 'term_worker', text: 'x', client: MOBILE_CLIENT })
    expect(ownership(worker.dispatchId)).toBe('owned')
    await callSend({ terminal: 'term_worker', text: 'y', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('user_owned')
    expect(await release(worker.dispatchId)).toMatchObject({
      state: 'retained',
      reason: 'user_takeover'
    })
    expect(harness.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('leaves a pane that owns no worker terminal alone', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()

    await callSend({ terminal: 'term_coord', text: 'ls\r', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('owned')
    expect(await release(worker.dispatchId)).toMatchObject({ state: 'released' })
  })
})

/**
 * The settled-worker automatic-resume fence is stamped on the sleeping-pane record, so lifting it
 * needs a workspace session to write through. Anything a takeover drops from the recovery plan has
 * to lift the fence in the same call, or the pane stays unspawnable until the next app start.
 */
describe('a mobile takeover lifts the settled worker resume fence', () => {
  let session: WorkspaceSessionState
  let fenceChanges: [string, boolean][]

  beforeEach(() => {
    session = getDefaultWorkspaceSession() as WorkspaceSessionState
    fenceChanges = []
    const store = {
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        session = next
      },
      getWorkspaceSessionHostIds: () => [LOCAL_EXECUTION_HOST_ID],
      flushOrThrow: vi.fn()
    } as unknown as RuntimeStore
    harness.setup({ store })
    harness.runtime.setNotifier({
      setLegacyWorkerTerminalResumeFence: (paneKey: string, blocked: boolean) => {
        fenceChanges.push([paneKey, blocked])
      }
    } as never)
  })
  afterEach(() => harness.cleanup())

  function fenceOnWorkerPane(): string | undefined {
    return session.sleepingAgentSessionsByPaneKey?.[harness.workerPaneKey]?.automaticResumeBlockedBy
  }

  it('unblocks the pane the phone typed into', async () => {
    const worker = await harness.startSettledWorker()
    session = {
      ...session,
      sleepingAgentSessionsByPaneKey: {
        [harness.workerPaneKey]: {
          paneKey: harness.workerPaneKey,
          tabId: 'tab_worker',
          worktreeId: 'repo::worktree',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }
    } as WorkspaceSessionState
    harness.runtime.prepareLegacyWorkerTerminalRecovery()
    expect(fenceOnWorkerPane()).toBe('legacy-orchestration-worker')
    expect(fenceChanges).toContainEqual([harness.workerPaneKey, true])
    stubAcceptedWrite()

    await callSend({ terminal: 'term_worker', text: 'ls\r', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('user_owned')
    expect(fenceOnWorkerPane()).toBeUndefined()
    expect(fenceChanges.at(-1)).toEqual([harness.workerPaneKey, false])
  })
})

// The fence hangs off provenance, not off the input floor, so this rule is pinned on its own.
describe('which bytes count as a person typing', () => {
  const cases: [string, Parameters<typeof isDeliberateHumanInput>, boolean][] = [
    ['a phone keystroke', [{ client: MOBILE_CLIENT }, false], true],
    ["an agent's terminal send", [{ client: CLI_CLIENT }, false], false],
    ['a phone query reply', [{ client: MOBILE_CLIENT, inputKind: 'query-reply' }, false], false],
    ['a legacy phone on a mobile-driven pane', [{}, true], true],
    ['a clientless send on an idle pane', [{}, false], false]
  ]
  for (const [name, args, expected] of cases) {
    it(`${name} is ${expected ? '' : 'not '}human input`, () => {
      expect(isDeliberateHumanInput(...args)).toBe(expected)
    })
  }
})
