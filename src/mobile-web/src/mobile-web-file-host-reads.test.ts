import { describe, expect, it } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { sanitizeDirectoryResult } from '../../shared/mobile-web/file-host-presentation'

const context = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const directory = { workspaceId: 'workspace_opaque', relativePath: '', limit: 10 }
const chunk = {
  workspaceId: directory.workspaceId,
  relativePath: 'report.bin',
  offset: 4,
  length: 3
}
const entries = [
  { name: 'z.txt', isDirectory: false },
  { name: 'src', isDirectory: true }
]

function fixture(generic = true) {
  const messages: MobileWebBridgePageMessage[] = []
  const limits = {
    maxRequestBytes: 16384,
    maxResponseBytes: 524288,
    maxConcurrent: 4,
    rateCapacity: 16,
    rateRefillPerSecond: 4
  }
  const client = new MobileWebBridgeClient({
    context,
    grants: [
      { capability: 'file', operation: 'directory', limits },
      { capability: 'file', operation: 'readChunk', limits },
      ...(generic ? [{ capability: 'workspace' as const, operation: 'hostRequest', limits }] : [])
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => 'R'.repeat(22)
  })
  const respond = (
    result: unknown,
    code?: 'too_large' | 'unsupported_capability' | 'host_error'
  ) => {
    client.receive({
      version: 2,
      type: 'response',
      ...context,
      requestId: 'R'.repeat(22),
      ...(code
        ? { status: 'error', error: { code, retryable: false } }
        : { status: 'success', payload: result })
    } as MobileWebBridgeShellMessage)
  }
  return { client, messages, respond }
}

describe('page-owned generic file reads', () => {
  it('projects raw directory entries on the page with legacy ordering and revision', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileDirectory(directory)
    expect(messages[0]).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'files.readDir',
        workspaceId: directory.workspaceId,
        params: { relativePath: '' }
      }
    })
    respond(entries.map((entry) => ({ ...entry, futureField: 'desktop-added' })))
    await expect(result).resolves.toEqual(
      sanitizeDirectoryResult(entries, directory.workspaceId, '', 10)
    )
    client.dispose()
  })

  it('decodes binary chunks without a shell file projection', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileReadChunk(chunk)
    expect(messages[0]).toMatchObject({
      operation: 'hostRequest',
      payload: {
        method: 'files.readChunk',
        params: { relativePath: 'report.bin', offset: 4, length: 3 }
      }
    })
    respond({ contentBase64: 'AAH/', bytesRead: 3, eof: true, futureField: 1 })
    await expect(result).resolves.toMatchObject({
      workspaceId: directory.workspaceId,
      offset: 4,
      bytes: new Uint8Array([0, 1, 255])
    })
    client.dispose()
  })

  it.each(['too_large', 'unsupported_capability'] as const)(
    'falls back when the host returns %s',
    async (code) => {
      const { client, messages, respond } = fixture()
      const result = client.fileDirectory(directory)
      respond(null, code)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(messages.at(-1)).toMatchObject({ capability: 'file', operation: 'directory' })
      const legacy = sanitizeDirectoryResult(entries, directory.workspaceId, '', 10)
      respond(legacy)
      await expect(result).resolves.toEqual(legacy)
      client.dispose()
    }
  )

  it('uses the legacy operation on an older shell', async () => {
    const { client, messages, respond } = fixture(false)
    const result = client.fileDirectory(directory)
    expect(messages[0]).toMatchObject({ capability: 'file', operation: 'directory' })
    respond(sanitizeDirectoryResult(entries, directory.workspaceId, '', 10))
    await expect(result).resolves.toMatchObject({ workspaceId: directory.workspaceId })
    client.dispose()
  })

  it('does not hide host errors by issuing a second read', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileDirectory(directory)
    respond(null, 'host_error')
    await expect(result).rejects.toMatchObject({ code: 'host_error' })
    expect(messages).toHaveLength(1)
    client.dispose()
  })

  it('refuses a chunk larger than requested', async () => {
    const { client, respond } = fixture()
    const result = client.fileReadChunk(chunk)
    respond({ contentBase64: 'AAH/AA==', bytesRead: 4, eof: true })
    await expect(result).rejects.toMatchObject({ code: 'host_error' })
    client.dispose()
  })
})
