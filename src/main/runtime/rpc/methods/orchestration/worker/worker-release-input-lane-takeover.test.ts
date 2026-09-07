import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import { TERMINAL_SEND_METHODS } from '../../terminal/terminal-send-method'
import { sendTerminalStreamInput } from '../../terminal/terminal-input-delivery'
import { isStreamingMethod, type RpcMethod } from '../../../core'

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

// Stands in for the PTY write, honouring the reserve/after-write contract RuntimeTerminalWriter
// gives every accepted write (src/main/runtime/runtime-terminal-writer.ts).
function stubAcceptedWrite(): void {
  vi.spyOn(harness.runtime, 'beginMobileInputFloor').mockReturnValue({
    commit: async () => {},
    rollback: () => {}
  })
  vi.spyOn(harness.runtime, 'sendTerminal').mockImplementation(async (handle, _action, options) => {
    options?.reserveWrite?.('pty-worker')
    await options?.afterWrite?.('pty-worker')
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

  it('records one takeover per pane window however many keystrokes arrive', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()
    const marked = vi.spyOn(harness.db, 'markWorkerTerminalUserOwned')

    await callSend({ terminal: 'term_worker', text: 'l', client: MOBILE_CLIENT })
    await callSend({ terminal: 'term_worker', text: 's', client: MOBILE_CLIENT })
    await callSend({ terminal: 'term_worker', text: '\r', client: MOBILE_CLIENT })

    expect(marked).toHaveBeenCalledTimes(1)
    expect(ownership(worker.dispatchId)).toBe('user_owned')
  })

  it('leaves a pane that owns no worker terminal alone', async () => {
    const worker = await harness.startSettledWorker()
    stubAcceptedWrite()

    await callSend({ terminal: 'term_coord', text: 'ls\r', client: MOBILE_CLIENT })

    expect(ownership(worker.dispatchId)).toBe('owned')
    expect(await release(worker.dispatchId)).toMatchObject({ state: 'released' })
  })
})
