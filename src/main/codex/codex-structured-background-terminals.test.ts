import { describe, expect, it, vi } from 'vitest'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import {
  createCodexBackgroundTerminals,
  refreshCodexBackgroundTerminals,
  stopCodexBackgroundTerminals
} from './codex-structured-background-terminals'
import type { CodexSession } from './codex-structured-session-state'

function makeSession(request: ReturnType<typeof vi.fn>): CodexSession {
  return { connection: { request }, threadId: 'thread-1' } as unknown as CodexSession
}

const ONE_TERMINAL = {
  data: [{ itemId: 'item-1', processId: 'proc-1', command: 'sleep 180', osPid: 14040 }]
}

describe('codex background terminals', () => {
  describe('reading the live list', () => {
    it('publishes a running terminal as a stoppable monitored task', async () => {
      const request = vi.fn().mockResolvedValue(ONE_TERMINAL)
      const terminals = createCodexBackgroundTerminals()

      const changed = await refreshCodexBackgroundTerminals(terminals, makeSession(request), 5_000)

      expect(changed).toBe(true)
      expect(request).toHaveBeenCalledWith(
        'thread/backgroundTerminals/list',
        { threadId: 'thread-1' },
        { timeoutMs: 5_000 }
      )
      expect(terminals.state).toEqual({
        state: 'monitoring',
        tasks: [{ id: 'proc-1', kind: 'command', description: 'sleep 180' }],
        supportsTaskStop: true
      })
    })

    it('reports an empty list as nothing to monitor', async () => {
      const terminals = createCodexBackgroundTerminals()

      await refreshCodexBackgroundTerminals(
        terminals,
        makeSession(vi.fn().mockResolvedValue({ data: [] }))
      )

      expect(terminals.supported).toBe(true)
      expect(terminals.state).toBeNull()
    })

    it('does not wake subscribers when the list is unchanged', async () => {
      const request = vi.fn().mockResolvedValue(ONE_TERMINAL)
      const terminals = createCodexBackgroundTerminals()
      const session = makeSession(request)

      expect(await refreshCodexBackgroundTerminals(terminals, session)).toBe(true)
      expect(await refreshCodexBackgroundTerminals(terminals, session)).toBe(false)
    })

    it('drops a row without a process id rather than offering an unstoppable task', async () => {
      const terminals = createCodexBackgroundTerminals()
      const response = { data: [{ command: 'sleep 180' }, ONE_TERMINAL.data[0]] }

      await refreshCodexBackgroundTerminals(
        terminals,
        makeSession(vi.fn().mockResolvedValue(response))
      )

      expect(terminals.state?.tasks).toEqual([
        { id: 'proc-1', kind: 'command', description: 'sleep 180' }
      ])
    })
  })

  describe('capability probe', () => {
    it('latches off and stays quiet when the host refuses the operation', async () => {
      const request = vi
        .fn()
        .mockRejectedValue(
          new CodexAppServerRequestError(
            'thread/backgroundTerminals/list',
            -32601,
            'method not found'
          )
        )
      const terminals = createCodexBackgroundTerminals()
      const session = makeSession(request)

      await refreshCodexBackgroundTerminals(terminals, session)

      expect(terminals.supported).toBe(false)
      expect(terminals.state).toBeNull()

      // Latched: a later refresh must not ask again, so an older host never
      // pays for a probe per turn.
      await refreshCodexBackgroundTerminals(terminals, session)
      expect(request).toHaveBeenCalledOnce()
    })

    it('refuses to stop once the capability is off, without calling the host', async () => {
      const request = vi.fn()
      const terminals = createCodexBackgroundTerminals()
      terminals.supported = false

      const result = await stopCodexBackgroundTerminals(terminals, makeSession(request))

      expect(result).toEqual({ cancelled: false })
      expect(request).not.toHaveBeenCalled()
    })

    it('keeps the capability after a transient failure so a blip cannot hide the control', async () => {
      const request = vi.fn().mockRejectedValue(new Error('connection closed'))
      const terminals = createCodexBackgroundTerminals()
      terminals.supported = true

      await refreshCodexBackgroundTerminals(terminals, makeSession(request))

      expect(terminals.supported).toBe(true)
    })
  })

  describe('stopping', () => {
    it('cleans every terminal when no task is named', async () => {
      const request = vi.fn().mockResolvedValue({})
      const terminals = createCodexBackgroundTerminals()

      const result = await stopCodexBackgroundTerminals(terminals, makeSession(request), 5_000)

      expect(result).toEqual({ cancelled: true })
      expect(request).toHaveBeenCalledWith(
        'thread/backgroundTerminals/clean',
        { threadId: 'thread-1' },
        { timeoutMs: 5_000 }
      )
    })

    it('terminates one terminal by its process id', async () => {
      const request = vi.fn().mockResolvedValue({ terminated: true })
      const terminals = createCodexBackgroundTerminals()

      const result = await stopCodexBackgroundTerminals(
        terminals,
        makeSession(request),
        5_000,
        'proc-1'
      )

      expect(result).toEqual({ cancelled: true })
      expect(request).toHaveBeenCalledWith(
        'thread/backgroundTerminals/terminate',
        { threadId: 'thread-1', processId: 'proc-1' },
        { timeoutMs: 5_000 }
      )
    })

    it('reports an unconfirmed stop and hides the control when the host refuses', async () => {
      const request = vi
        .fn()
        .mockRejectedValue(
          new CodexAppServerRequestError(
            'thread/backgroundTerminals/clean',
            -32601,
            'method not found'
          )
        )
      const terminals = createCodexBackgroundTerminals()
      terminals.state = { state: 'monitoring', tasks: [], supportsTaskStop: true }

      const result = await stopCodexBackgroundTerminals(terminals, makeSession(request))

      expect(result).toEqual({ cancelled: false })
      expect(terminals.supported).toBe(false)
      expect(terminals.state).toBeNull()
    })
  })
})
