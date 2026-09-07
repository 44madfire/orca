import { describe, expect, it, vi } from 'vitest'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { hostTestAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

describe('fork tab publication barrier', () => {
  it('never publishes an unseeded child tab after an unknown fork', async () => {
    const publish = vi.fn()
    const fork = vi
      .fn()
      .mockResolvedValue({ ok: false, refusal: { code: 'agent_session_operation_unknown' } })
    const result = await commitStructuredAgentSessionCreate({
      runtime: { publishStructuredAgentSessionTab: publish } as unknown as OrcaRuntimeService,
      caller: { callerKey: 'client' },
      activate: true,
      prepared: {
        host: { fork } as unknown as StructuredAgentSessionHost,
        attachParams: hostTestAttachParams(null),
        tab: { workspaceId: 'workspace', agent: 'codex' },
        forkFrom: {
          sessionId: 'parent-session',
          itemId: 'codex:parent:turn:1',
          expectedEpoch: 'epoch',
          expectedRuntimeFence: 1
        }
      }
    })
    expect(result.ok).toBe(false)
    expect(fork).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
  })

  it('activates the seeded child through the existing tab publisher', async () => {
    const publish = vi.fn().mockResolvedValue(undefined)
    const fork = vi.fn().mockResolvedValue({ ok: true, value: { sessionId: 'child-session' } })
    const attach = vi.fn()
    await commitStructuredAgentSessionCreate({
      runtime: { publishStructuredAgentSessionTab: publish } as unknown as OrcaRuntimeService,
      caller: { callerKey: 'client' },
      activate: true,
      prepared: {
        host: { fork, attach } as unknown as StructuredAgentSessionHost,
        attachParams: hostTestAttachParams(null),
        tab: { workspaceId: 'workspace', agent: 'claude' },
        forkFrom: {
          sessionId: 'parent-session',
          itemId: 'claude:parent:uuid',
          expectedEpoch: 'epoch',
          expectedRuntimeFence: 1
        }
      }
    })
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      workspaceId: 'workspace',
      sessionId: 'child-session',
      agent: 'claude',
      activate: true
    })
    expect(attach).not.toHaveBeenCalled()
  })
})
