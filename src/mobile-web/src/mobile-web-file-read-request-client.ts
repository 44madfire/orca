import {
  MobileWebFileChunkPayloadSchema,
  MobileWebFileChunkResultSchema,
  MobileWebFileDirectoryPayloadSchema,
  MobileWebFileDirectoryResultSchema,
  type MobileWebFileChunkPayload,
  type MobileWebFileChunkResult,
  type MobileWebFileDirectoryPayload,
  type MobileWebFileDirectoryResult
} from '../../shared/mobile-web/bridge-operation-contract'
import {
  sanitizeDirectoryResult,
  sanitizeChunkResult
} from '../../shared/mobile-web/file-host-presentation'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import { decodeMobileWebFileChunk } from './mobile-web-file-chunk'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebFileReadClient {
  constructor(protected readonly requests: MobileWebOneShotRequestClient) {}

  directory(
    payload: MobileWebFileDirectoryPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileDirectoryResult> {
    const legacy = () =>
      this.requests
        .request(
          'file',
          'directory',
          payload,
          MobileWebFileDirectoryPayloadSchema,
          MobileWebFileDirectoryResultSchema,
          options
        )
        .then((result) => {
          if (result.entries.length > payload.limit) {
            throw new MobileWebBridgeClientError('invalid_message', false)
          }
          return matchingFile(payload, result)
        })
    if (!MobileWebFileDirectoryPayloadSchema.safeParse(payload).success) {
      return legacy()
    }
    return this.readHost(
      'files.readDir',
      payload.workspaceId,
      { relativePath: payload.relativePath },
      (result) =>
        sanitizeDirectoryResult(result, payload.workspaceId, payload.relativePath, payload.limit),
      legacy,
      options
    )
  }

  readChunk(
    payload: MobileWebFileChunkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileChunkResult> {
    const legacy = () =>
      this.requests
        .request(
          'file',
          'readChunk',
          payload,
          MobileWebFileChunkPayloadSchema,
          MobileWebFileChunkResultSchema,
          options
        )
        .then(decodeMobileWebFileChunk)
        .then((result) => {
          if (result.offset !== payload.offset || result.bytesRead > payload.length) {
            throw new MobileWebBridgeClientError('invalid_message', false)
          }
          return matchingFile(payload, result)
        })
    if (!MobileWebFileChunkPayloadSchema.safeParse(payload).success) {
      return legacy()
    }
    return this.readHost(
      'files.readChunk',
      payload.workspaceId,
      { relativePath: payload.relativePath, offset: payload.offset, length: payload.length },
      (result) => decodeMobileWebFileChunk(sanitizeChunkResult(result, payload)),
      legacy,
      options
    )
  }

  protected readHost<T>(
    method: string,
    workspaceId: string,
    params: Record<string, unknown>,
    project: (result: unknown) => T,
    legacy: () => Promise<T>,
    options?: MobileWebBridgeRequestOptions
  ): Promise<T> {
    if (!this.requests.supports('workspace', 'hostRequest')) {
      return legacy()
    }
    return requestMobileWebHost(this.requests, method, workspaceId, params, options)
      .then(project)
      .catch((error: unknown) => {
        if (
          error instanceof MobileWebBridgeClientError &&
          (error.code === 'unsupported_capability' || error.code === 'too_large')
        ) {
          return legacy()
        }
        throw error
      })
  }
}

function matchingFile<T extends { workspaceId: string; relativePath: string }>(
  payload: { workspaceId: string; relativePath: string },
  result: T
): T {
  if (result.relativePath !== payload.relativePath) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return requireEchoedWorkspaceId(payload.workspaceId, result)
}
