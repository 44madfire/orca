import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { RpcContext } from '../core'
import { MOBILE_WEB_AGENT_HISTORY_METHODS } from './mobile-web-agent-history'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'

const [snapshot, preview, resume] = MOBILE_WEB_AGENT_HISTORY_METHODS

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'claude:1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'provider-session-1',
    title: 'Fix the parser',
    cwd: '/Users/ada/repo/app',
    codexHome: null,
    filePath: '/Users/ada/.claude/projects/app/session.jsonl',
    messageCount: 4,
    modifiedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    previewMessages: [{ role: 'user', text: 'hello', timestamp: null }],
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    ...overrides
  } as AiVaultSession
}

function fixture(sessions: AiVaultSession[] = [session()]) {
  const runtime = {
    getWorktreePs: vi.fn().mockResolvedValue({
      worktrees: [
        {
          worktreeId: 'workspace-1',
          repoId: 'repo-1',
          path: '/Users/ada/repo/app',
          displayName: 'App'
        }
      ]
    }),
    ensureStructuredAgentSessionHost: vi.fn().mockResolvedValue(undefined),
    listAiVaultSessions: vi.fn().mockResolvedValue({ sessions, issues: [{ path: 'broken' }] }),
    listRepos: vi.fn().mockReturnValue([{ id: 'repo-1', path: '/Users/ada/repo' }]),
    enrichMissingRepoGitRemoteIdentities: vi.fn(),
    listProjectGroups: vi.fn().mockReturnValue([]),
    listFolderWorkspaces: vi.fn().mockReturnValue([]),
    getClientSettings: vi.fn().mockReturnValue({}),
    getStatus: vi.fn().mockReturnValue({ hostPlatform: 'darwin' }),
    createMobileSessionTerminal: vi
      .fn()
      .mockResolvedValue({ tab: { id: 'tab-9', terminal: 'private-terminal' } }),
    resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
    getDriver: vi.fn().mockReturnValue({}),
    isMobileTerminalQueryReplyAuthority: vi.fn().mockReturnValue(true),
    beginMobileInputFloor: vi.fn().mockReturnValue({ rollback: vi.fn(), commit: vi.fn() }),
    sendTerminal: vi
      .fn()
      .mockResolvedValue({ handle: 'private-terminal', accepted: true, bytesWritten: 4 }),
    notifyNativeChatLaunchDraftResolved: vi.fn()
  }
  const context = (connectionId = 'socket-a') =>
    ({
      runtime,
      connectionId,
      clientId: 'device',
      pairedDeviceId: 'device'
    }) as unknown as RpcContext
  return { runtime, context }
}

const scope = { worktree: 'id:workspace-1', scope: 'workspace' as const, query: '', force: false }

describe('mobile web agent history', () => {
  it('projects sessions into opaque handles with no host paths', async () => {
    const f = fixture()
    const result = (await snapshot.handler(scope, f.context())) as {
      supported: boolean
      sessions: { handle: string; title: string; isCurrentWorkspace: boolean }[]
      skippedTranscriptCount: number
      nextCursor: string | null
    }
    expect(result.supported).toBe(true)
    expect(result.skippedTranscriptCount).toBe(1)
    expect(result.nextCursor).toBeNull()
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ title: 'Fix the parser', isCurrentWorkspace: true })
    expect(JSON.stringify(result)).not.toContain('/Users/ada')
    expect(JSON.stringify(result)).not.toContain('provider-session-1')
  })

  it('scopes the scan to the addressed worktree', async () => {
    const f = fixture()
    await snapshot.handler(scope, f.context())
    expect(f.runtime.listAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({ scopePaths: ['/Users/ada/repo/app'] })
    )
  })

  it('previews only a handle this connection minted', async () => {
    const f = fixture()
    const result = (await snapshot.handler(scope, f.context('socket-a'))) as {
      sessions: { handle: string }[]
    }
    const handle = result.sessions[0]!.handle
    expect(await preview.handler({ sessionHandle: handle }, f.context('socket-a'))).toEqual({
      messages: [{ role: 'user', text: 'hello' }]
    })
    await expect(preview.handler({ sessionHandle: handle }, f.context('socket-b'))).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('retires the handles a rescan replaces', async () => {
    const f = fixture()
    const first = (await snapshot.handler(scope, f.context())) as { sessions: { handle: string }[] }
    await snapshot.handler(scope, f.context())
    await expect(
      preview.handler({ sessionHandle: first.sessions[0]!.handle }, f.context())
    ).rejects.toThrow('selector_not_found')
  })

  it('blocks a resume for a session with no provider id', async () => {
    const f = fixture([session({ sessionId: '  ' })])
    const listed = (await snapshot.handler(scope, f.context())) as {
      sessions: { handle: string }[]
    }
    expect(
      await resume.handler(
        { worktree: 'id:workspace-1', sessionHandle: listed.sessions[0]!.handle },
        f.context()
      )
    ).toEqual({ status: 'blocked', message: 'This session is missing a resume id.' })
    expect(f.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('creates the resume terminal and types the command into it', async () => {
    const f = fixture()
    const listed = (await snapshot.handler(scope, f.context())) as {
      sessions: { handle: string }[]
    }
    const result = await resume.handler(
      { worktree: 'id:workspace-1', sessionHandle: listed.sessions[0]!.handle },
      f.context()
    )
    expect(result).toEqual({
      status: 'queued',
      targetIsCurrentWorkspace: true,
      targetWorkspaceName: 'App'
    })
    expect(f.runtime.createMobileSessionTerminal.mock.calls[0]?.[0]).toBe('id:workspace-1')
    expect(f.runtime.sendTerminal.mock.calls[0]?.[0]).toBe('private-terminal')
    expect(String(f.runtime.sendTerminal.mock.calls[0]?.[1]?.text)).toContain('claude')
  })

  it('refuses a worktree selector the shell did not write', async () => {
    const f = fixture()
    await expect(snapshot.handler({ ...scope, worktree: 'name:app' }, f.context())).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('is reachable from a mobile socket', () => {
    for (const method of MOBILE_WEB_AGENT_HISTORY_METHODS) {
      expect(isMobileWebHostRpcMethod(method.name), method.name).toBe(true)
    }
  })
})
