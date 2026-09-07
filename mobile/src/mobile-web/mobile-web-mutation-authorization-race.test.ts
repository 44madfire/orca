import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { executeMobileWebTaskItemMutationOperation } from './mobile-web-task-item-mutation-operations'
import { taskRoundtripHostResponse } from './mobile-web-task-roundtrip-host-fixtures'
import { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web mutation authorization races', () => {
  it('rejects a task update when provider preflight loses its opaque target', async () => {
    const authority = new MobileWebTaskTargetAuthority((length) => new Uint8Array(length).fill(3))
    const targetId = authority.registerGitHub({
      repoId: 'host-repo-private',
      number: 7,
      type: 'issue'
    })
    const details = deferredResult()
    const sendRequest = vi.fn((method: string) => {
      if (method === 'github.workItemDetails') {
        return details.promise
      }
      if (method === 'github.updateIssue') {
        return Promise.resolve(success({ ok: true }))
      }
      return Promise.resolve(failure())
    })
    const pending = executeMobileWebTaskItemMutationOperation({
      operation: 'updateHostedTaskStatus',
      payload: { targetId, closed: true },
      client: client(sendRequest),
      targetAuthority: authority
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await vi.waitFor(() => expect(callsFor(sendRequest, 'github.workItemDetails')).toHaveLength(1))
    authority.clear()
    details.resolve(taskRoundtripHostResponse('github.workItemDetails'))

    await rejection
    expect(callsFor(sendRequest, 'github.updateIssue')).toHaveLength(0)
  })

  it('rejects native-chat persistence when the tab lookup loses its workspace authority', async () => {
    const workspace = workspaceAuthority()
    const chat = new MobileWebNativeChatAuthority((length) => new Uint8Array(length).fill(5))
    const tabs = deferredResult()
    const sendRequest = vi.fn(() => tabs.promise)
    const sessionChatPendingWrite = vi.fn().mockResolvedValue(undefined)
    const pending = executeMobileWebNativeChatOperation({
      operation: 'pendingWrite',
      payload: {
        workspaceId: workspace.pageId,
        sessionId: 'provider-session-a',
        deliveries: [{ text: 'pending', expectedOccurrence: 1 }]
      },
      client: client(sendRequest),
      workspaceAuthority: workspace.authority,
      nativeChatAuthority: chat,
      nativeAuthority: { sessionChatPendingWrite },
      terminalClientId: 'mobile-client'
    })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(1))
    workspace.remove()
    tabs.resolve(success(chatTabs))

    await rejection
    expect(sessionChatPendingWrite).not.toHaveBeenCalled()
  })
})

const chatTabs = {
  worktree: 'workspace-a',
  tabs: [
    {
      id: 'tab-a',
      type: 'terminal',
      terminal: 'terminal-a',
      agentStatus: {
        agentType: 'claude',
        providerSession: { id: 'provider-session-a', transcriptPath: '/private/transcript.jsonl' }
      }
    }
  ]
}

function workspaceAuthority() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
  authority.synchronize([{ workspaceId: 'workspace-a', repoId: 'repo-a' }])
  return {
    authority,
    pageId: authority.pageWorkspaceId('workspace-a'),
    remove: () => authority.synchronize([])
  }
}

function deferredResult() {
  let resolve = (_value: ReturnType<typeof success>): void => {}
  const promise = new Promise<ReturnType<typeof success>>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function client(sendRequest: ReturnType<typeof vi.fn>): RpcClient {
  return { sendRequest } as unknown as RpcClient
}

function success(result: unknown) {
  return { ok: true as const, result }
}

function failure() {
  return { ok: false as const, error: { code: 'unexpected', message: 'unexpected' } }
}

function callsFor(sendRequest: ReturnType<typeof vi.fn>, method: string) {
  return sendRequest.mock.calls.filter(([candidate]) => candidate === method)
}
