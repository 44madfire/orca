import { describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'
import { SessionNotFoundError } from './types'

type MockSubprocess = SubprocessHandle & { exit(code: number): void }

function createSubprocess(): MockSubprocess {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 99_999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn(),
    exit: (code: number) => onExit?.(code)
  } as MockSubprocess
}

function createHost(): { host: TerminalHost; lastSubprocess: () => MockSubprocess } {
  let last: MockSubprocess | undefined
  const host = new TerminalHost({
    spawnSubprocess: () => {
      last = createSubprocess()
      return last
    }
  })
  return { host, lastSubprocess: () => last as MockSubprocess }
}

describe('TerminalHost process inspection', () => {
  it('returns unverifiable when the expected incarnation is stale', async () => {
    const host = new TerminalHost({ spawnSubprocess: () => createSubprocess() })
    try {
      const created = await host.createOrAttach({
        sessionId: 'session-incarnation',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      await expect(
        host.inspectProcess('session-incarnation', { expectedIncarnationId: 'replacement' })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: {
          verdict: 'unverifiable',
          reason: 'incarnation_mismatch',
          ptyId: 'session-incarnation',
          ptyIncarnationId: created.incarnationId
        }
      })
    } finally {
      await host.dispose()
    }
  })
})

describe('TerminalHost undelivered exits', () => {
  /** Orca quits (the client's attachments drop), the shell ends, Orca reopens and asks. */
  async function exitWhileClientIsAway(
    host: TerminalHost,
    subprocess: () => MockSubprocess,
    sessionId: string,
    code = 0
  ): Promise<string> {
    const created = await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    host.detach(sessionId, created.attachToken as symbol)
    subprocess().exit(code)
    return created.incarnationId
  }

  it('hands a close-and-reopen caller the exit its client never received, once', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-away', 3)

      // The exit is gone from every liveness surface, but the evidence is still owed to its owner.
      expect(host.listSessions()).toHaveLength(0)
      await expect(
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: {
          ptyId: 'session-away',
          ptyIncarnationId: incarnationId,
          verdict: 'exited',
          reason: 'pty_exit_3'
        }
      })

      // Handing it over was the delivery: that client now has the exit.
      expect(() =>
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).toThrow(SessionNotFoundError)
    } finally {
      await host.dispose()
    }
  })

  it('answers nothing to a caller with the wrong incarnation or none at all', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-away')

      expect(() =>
        host.inspectProcess('session-away', { expectedIncarnationId: 'someone-else' })
      ).toThrow(SessionNotFoundError)
      expect(() => host.inspectProcess('session-away')).toThrow(SessionNotFoundError)

      // Neither refusal consumed the evidence the real owner is still owed.
      await expect(
        host.inspectProcess('session-away', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({ foregroundProcessEvidence: { verdict: 'exited' } })
    } finally {
      await host.dispose()
    }
  })

  it('holds nothing when the exit reached an attached client', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const onExit = vi.fn()
      const created = await host.createOrAttach({
        sessionId: 'session-attached',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit }
      })
      lastSubprocess().exit(0)

      expect(onExit).toHaveBeenCalledWith(0, created.incarnationId, expect.anything())
      expect(() =>
        host.inspectProcess('session-attached', { expectedIncarnationId: created.incarnationId })
      ).toThrow(SessionNotFoundError)
    } finally {
      await host.dispose()
    }
  })

  it('does not let a session recreated under the same id inherit the old exit', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      const incarnationId = await exitWhileClientIsAway(host, lastSubprocess, 'session-reused')
      const replacement = await host.createOrAttach({
        sessionId: 'session-reused',
        cols: 80,
        rows: 24,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

      expect(replacement.incarnationId).not.toBe(incarnationId)
      await expect(
        host.inspectProcess('session-reused', { expectedIncarnationId: incarnationId })
      ).resolves.toMatchObject({
        foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'incarnation_mismatch' }
      })
    } finally {
      await host.dispose()
    }
  })

  it('keeps kill tombstones independent of a held exit', async () => {
    const { host, lastSubprocess } = createHost()
    try {
      await exitWhileClientIsAway(host, lastSubprocess, 'session-away')

      // Nothing killed it, and a held record is not a live session to kill.
      expect(host.isKilled('session-away')).toBe(false)
      expect(() => host.kill('session-away')).toThrow(SessionNotFoundError)
    } finally {
      await host.dispose()
    }
  })
})
