import { describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { isMobileWebHostRpcMethod } from './mobile-web-host-rpc-allowlist'
import { MOBILE_WEB_TERMINAL_ARTIFACT_METHODS } from './mobile-web-terminal-artifact'

const [resolvePath, artifactChunk, artifactRelease] = MOBILE_WEB_TERMINAL_ARTIFACT_METHODS
const TAB = {
  id: 'tab-1',
  type: 'terminal',
  status: 'ready',
  terminal: 'private-terminal',
  isActive: true
}

function fixture(overrides: { openTarget?: unknown; worktree?: string } = {}) {
  const runtime = {
    listMobileSessionTabs: vi.fn().mockResolvedValue({
      worktree: 'workspace-1',
      activeTabId: 'tab-1',
      publicationEpoch: 'epoch',
      snapshotVersion: 1,
      tabs: [TAB]
    }),
    resolveTerminalPath: vi.fn().mockResolvedValue({
      worktree: overrides.worktree ?? 'workspace-1',
      exists: true,
      isDirectory: false,
      openTarget: overrides.openTarget ?? {
        kind: 'absolute-file',
        absolutePath: '/private/results/report.png',
        grantId: 'desktop-grant'
      }
    }),
    readTerminalArtifactChunk: vi
      .fn()
      .mockResolvedValue({ contentBase64: 'T0s=', bytesRead: 2, eof: true })
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

const target = { worktree: 'id:workspace-1', tabId: 'tab-1' }
const resolveParams = { ...target, pathText: '/private/results/report.png', line: 3, column: null }

describe('mobile web terminal artifacts', () => {
  it('hands the page an opaque token and never the host path or grant', async () => {
    const f = fixture()
    const result = await resolvePath.handler(resolveParams, f.context())
    expect(result).toMatchObject({
      kind: 'terminal-artifact',
      displayName: 'report.png',
      previewKind: 'raster',
      line: 3,
      column: null
    })
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(JSON.stringify(result)).not.toContain('desktop-grant')
    expect((result as { token: string }).token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  it('answers a worktree-relative hit without retaining anything', async () => {
    const f = fixture({
      openTarget: { kind: 'worktree-file', relativePath: 'docs/report.md' }
    })
    expect(await resolvePath.handler(resolveParams, f.context())).toEqual({
      kind: 'worktree-file',
      relativePath: 'docs/report.md',
      displayName: 'report.md',
      previewKind: 'text',
      line: 3,
      column: null
    })
  })

  it('refuses a resolution that lands in another worktree', async () => {
    const f = fixture({ worktree: 'workspace-2' })
    await expect(resolvePath.handler(resolveParams, f.context())).rejects.toThrow(
      'selector_not_found'
    )
  })

  it('reads a chunk through the retained grant', async () => {
    const f = fixture()
    const { token } = (await resolvePath.handler(resolveParams, f.context())) as { token: string }
    expect(
      await artifactChunk.handler({ ...target, token, offset: 0, length: 2 }, f.context())
    ).toEqual({ token, offset: 0, contentBase64: 'T0s=', bytesRead: 2, eof: true })
    expect(f.runtime.readTerminalArtifactChunk.mock.calls[0]?.slice(0, 3)).toEqual([
      'id:workspace-1',
      'desktop-grant',
      '/private/results/report.png'
    ])
  })

  it('refuses a token another connection minted', async () => {
    const f = fixture()
    const { token } = (await resolvePath.handler(resolveParams, f.context('socket-a'))) as {
      token: string
    }
    await expect(
      artifactChunk.handler({ ...target, token, offset: 0, length: 2 }, f.context('socket-b'))
    ).rejects.toThrow('selector_not_found')
    expect(f.runtime.readTerminalArtifactChunk).not.toHaveBeenCalled()
  })

  it('retires the token when the tab no longer runs the terminal that printed the path', async () => {
    const f = fixture()
    const { token } = (await resolvePath.handler(resolveParams, f.context())) as { token: string }
    f.runtime.listMobileSessionTabs.mockResolvedValue({
      worktree: 'workspace-1',
      activeTabId: 'tab-1',
      publicationEpoch: 'epoch',
      snapshotVersion: 2,
      tabs: [{ ...TAB, terminal: 'replaced-terminal' }]
    })
    await expect(
      artifactChunk.handler({ ...target, token, offset: 0, length: 2 }, f.context())
    ).rejects.toThrow('selector_not_found')
    expect(f.runtime.readTerminalArtifactChunk).not.toHaveBeenCalled()
  })

  it('releases a token and stays quiet about one the ttl already took', async () => {
    const f = fixture()
    const { token } = (await resolvePath.handler(resolveParams, f.context())) as { token: string }
    expect(await artifactRelease.handler({ ...target, token }, f.context())).toBeNull()
    expect(await artifactRelease.handler({ ...target, token }, f.context())).toBeNull()
    await expect(
      artifactChunk.handler({ ...target, token, offset: 0, length: 2 }, f.context())
    ).rejects.toThrow('selector_not_found')
  })

  it('is reachable from a mobile socket', () => {
    for (const method of MOBILE_WEB_TERMINAL_ARTIFACT_METHODS) {
      expect(isMobileWebHostRpcMethod(method.name), method.name).toBe(true)
    }
  })
})
