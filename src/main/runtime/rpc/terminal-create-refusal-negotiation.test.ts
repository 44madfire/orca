import type { RpcMethod } from './core'
import { expect, it, vi } from 'vitest'
import { TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { terminalAttachRefusal } from '../terminal-attach-refusal'
import { AGENT_SESSION_METHODS } from './methods/agent-session'
import { TERMINAL_LIFECYCLE_METHODS } from './methods/terminal/terminal-lifecycle-methods'
import { mapRuntimeError } from './errors'

it.each(['terminal.create', 'terminal.createAgentSession', 'terminal.ensureAgentSession'])(
  '%s negotiates both refusal outcomes without changing ordinary success',
  async (method) => {
    const definition = [...TERMINAL_LIFECYCLE_METHODS, ...AGENT_SESSION_METHODS].find(
      (entry) => entry.name === method
    )! as RpcMethod
    for (const outcome of ['exitedBeforeAttach', 'reattachUnverifiable', 'success'] as const) {
      const owner = {
        handle: 'retained',
        tabId: 'tab-1',
        paneKey: 'tab-1:pane',
        worktreeId: 'wt-1'
      }
      const terminal =
        outcome === 'success'
          ? { ...owner, ptyId: 'worker', title: null }
          : terminalAttachRefusal({ id: 'worker', [outcome]: true }, owner)!
      const result = { terminal, disposition: 'created' }
      const runtime = {
        createTerminal: vi.fn(async () => terminal),
        dedupeTerminalCreate: vi.fn(async () => terminal),
        createAgentSession: vi.fn(async () => result),
        ensureAgentSession: vi.fn(async () => result)
      }
      for (const clientCapabilities of [
        undefined,
        [],
        [TERMINAL_FENCED_CREATE_RUNTIME_CAPABILITY]
      ]) {
        const call = definition.handler(
          {
            worktree: 'wt-1',
            agent: 'codex',
            kind: 'explicit',
            providerSession: { key: 'session_id', id: 'session-1' },
            clientOperationId: '1752883200000-0123456789abcdef0123456789abcdef'
          },
          { runtime, clientCapabilities } as never
        )
        if (outcome === 'success' || clientCapabilities?.length) {
          await expect(call).resolves.toMatchObject({ terminal })
        } else {
          await expect(call).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
          try {
            await call
          } catch (error) {
            expect(mapRuntimeError('request', { runtimeId: 'host' }, error)).toMatchObject({
              ok: false,
              error: { code: 'remote_runtime_unavailable' }
            })
          }
        }
      }
    }
  }
)
