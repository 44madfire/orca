import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebFileWrite } from './mobile-web-file-write'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web mutation authorization races', () => {
  it('rejects a file write when ownership preflight loses its workspace authority', async () => {
    const workspace = workspaceAuthority()
    const worktree = deferredResult()
    const sendRequest = vi.fn((method: string) => {
      if (method === 'status.get') {
        return Promise.resolve(success({ capabilities: ['files.mutation-ownership.v1'] }))
      }
      if (method === 'worktree.show') {
        return worktree.promise
      }
      if (method === 'files.writeIfUnchanged') {
        return Promise.resolve(success({ ok: true }))
      }
      return Promise.resolve(failure())
    })
    const pending = executeMobileWebFileWrite(
      {
        workspaceId: workspace.pageId,
        relativePath: 'src/app.ts',
        expectedRevision: 'a'.repeat(64),
        contentBase64: btoa('guarded')
      },
      client(sendRequest),
      workspace.authority
    )
    const rejection = expect(pending).rejects.toMatchObject({ code: 'not_found' })

    await vi.waitFor(() => expect(callsFor(sendRequest, 'worktree.show')).toHaveLength(1))
    workspace.remove()
    worktree.resolve(success({ worktree: { hostId: 'local' } }))

    await rejection
    expect(callsFor(sendRequest, 'files.writeIfUnchanged')).toHaveLength(0)
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
