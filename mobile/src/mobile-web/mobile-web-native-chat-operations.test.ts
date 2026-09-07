import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const binding = {
  hostWorkspaceId: 'workspace-1',
  hostTabId: 'tab-1',
  hostTerminalId: 'terminal-secret',
  agent: 'claude',
  providerSessionId: 'provider-session-secret',
  transcriptPath: '/private/transcript.jsonl'
}
const OPERATION_RUNTIME = {
  terminalClientId: 'mobile-device',
  getPageSessionId: async () => 'document'
}

describe('mobile web native chat operations', () => {
  it('persists pending delivery through stable hidden chat authority', async () => {
    const context = operationContext()
    const sendRequest = vi.fn<RpcClient['sendRequest']>().mockResolvedValue(success(binding))
    const sessionChatPendingRead = vi
      .fn<NonNullable<MobileWebNativeCapabilityAuthority['sessionChatPendingRead']>>()
      .mockResolvedValue([{ text: 'pending', expectedOccurrence: 2 }])
    const sessionChatPendingWrite = vi
      .fn<NonNullable<MobileWebNativeCapabilityAuthority['sessionChatPendingWrite']>>()
      .mockResolvedValue(undefined)
    const nativeAuthority = { sessionChatPendingRead, sessionChatPendingWrite }

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'pendingRead',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority,
        ...OPERATION_RUNTIME
      })
    ).resolves.toEqual({
      deliveries: [{ text: 'pending', expectedOccurrence: 2 }]
    })
    expect(sessionChatPendingRead).toHaveBeenCalledWith(
      'workspace-1',
      'tab-1',
      'provider-session-secret'
    )

    await expect(
      executeMobileWebNativeChatOperation({
        operation: 'pendingWrite',
        payload: {
          workspaceId: context.pageWorkspaceId,
          sessionId: context.pageSessionId,
          deliveries: [{ text: 'next', expectedOccurrence: 3 }]
        },
        client: { sendRequest } as unknown as RpcClient,
        workspaceAuthority: context.workspaceAuthority,
        nativeChatAuthority: context.nativeChatAuthority,
        nativeAuthority,
        ...OPERATION_RUNTIME
      })
    ).resolves.toBeNull()
    expect(sessionChatPendingWrite).toHaveBeenCalledWith(
      'workspace-1',
      'tab-1',
      'provider-session-secret',
      [{ text: 'next', expectedOccurrence: 3 }]
    )
    expect(JSON.stringify(sessionChatPendingWrite.mock.calls)).not.toContain(context.pageSessionId)
  })
})

function operationContext() {
  const workspaceAuthority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  workspaceAuthority.synchronize([{ workspaceId: 'workspace-1', repoId: 'repo-1' }])
  const nativeChatAuthority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
  return {
    workspaceAuthority,
    nativeChatAuthority,
    pageWorkspaceId: workspaceAuthority.pageWorkspaceId('workspace-1'),
    pageSessionId: 'resource_session'
  }
}

function success(result: unknown) {
  return {
    id: 'response',
    ok: true as const,
    result,
    _meta: { runtimeId: 'runtime' }
  }
}
