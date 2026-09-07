import { sanitizeListResult } from '../../shared/mobile-web/file-list-presentation'
import { projectMobileWebHostFileContent } from './mobile-web-host-file-content'
import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebFileListPayloadSchema,
  MobileWebFileOpenPayloadSchema,
  MobileWebFileOpenResultSchema,
  MobileWebFileReadPayloadSchema,
  MobileWebFileSearchPayloadSchema,
  type MobileWebFileListPayload,
  type MobileWebFileListResult,
  type MobileWebFileOpenPayload,
  type MobileWebFileReadPayload,
  type MobileWebFileReadResult,
  type MobileWebFileSearchPayload
} from '../../shared/mobile-web/bridge-operation-contract'
import {
  MOBILE_WEB_FILE_EDIT_MAX_BYTES,
  MobileWebFileWritePayloadSchema,
  MobileWebFileWriteResultSchema,
  type MobileWebFileWritePayload,
  type MobileWebFileWriteResult
} from '../../shared/mobile-web/file-edit-contract'
import {
  MobileWebTerminalArtifactChunkPayloadSchema,
  MobileWebTerminalArtifactChunkResultSchema,
  MobileWebTerminalArtifactReleasePayloadSchema,
  MobileWebTerminalArtifactReleaseResultSchema,
  MobileWebTerminalPathResolvePayloadSchema,
  MobileWebTerminalPathResolveResultSchema,
  type MobileWebTerminalArtifactChunkPayload,
  type MobileWebTerminalArtifactChunkResult,
  type MobileWebTerminalArtifactReleasePayload,
  type MobileWebTerminalPathResolvePayload,
  type MobileWebTerminalPathResolveResult
} from '../../shared/mobile-web/terminal-artifact-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import { MobileWebFileReadClient } from './mobile-web-file-read-request-client'
import { decodeMobileWebFileBytes } from './mobile-web-file-content'
import { mobileWebFileRevision } from './mobile-web-file-edit-content'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'

export class MobileWebFileRequestClient extends MobileWebFileReadClient {
  list(
    payload: MobileWebFileListPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    if (!MobileWebFileListPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.readHost(
      'mobileWeb.files.searchPaths',
      payload.workspaceId,
      { query: '', limit: payload.limit },
      (result) => sanitizeListResult(result, payload.workspaceId, undefined, payload.limit),
      options
    )
  }

  search(
    payload: MobileWebFileSearchPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    if (!MobileWebFileSearchPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.readHost(
      'mobileWeb.files.searchPaths',
      payload.workspaceId,
      { query: payload.query, limit: payload.limit },
      (result) => sanitizeListResult(result, payload.workspaceId, undefined, payload.limit),
      options
    )
  }

  read(
    payload: MobileWebFileReadPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileReadResult> {
    if (!MobileWebFileReadPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.readHost(
      'mobileWeb.files.read',
      payload.workspaceId,
      { relativePath: payload.relativePath },
      (result) => projectMobileWebHostFileContent(result, payload),
      options
    )
  }

  open(payload: MobileWebFileOpenPayload, options?: MobileWebBridgeRequestOptions): Promise<null> {
    return this.requests.request(
      'file',
      'open',
      payload,
      MobileWebFileOpenPayloadSchema,
      MobileWebFileOpenResultSchema,
      options
    )
  }

  write(
    payload: MobileWebFileWritePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileWriteResult> {
    return this.requests
      .request(
        'file',
        'write',
        payload,
        MobileWebFileWritePayloadSchema,
        MobileWebFileWriteResultSchema,
        options
      )
      .then((result) => matchingWrite(payload, result))
  }

  resolveTerminalPath(
    payload: MobileWebTerminalPathResolvePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebTerminalPathResolveResult> {
    return this.requests
      .request(
        'file',
        'resolveTerminalPath',
        payload,
        MobileWebTerminalPathResolvePayloadSchema,
        MobileWebTerminalPathResolveResultSchema,
        options
      )
      .then((result) => requireEchoedWorkspaceId(payload.workspaceId, result))
  }

  readTerminalArtifactChunk(
    payload: MobileWebTerminalArtifactChunkPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebTerminalArtifactChunkResult> {
    return this.requests
      .request(
        'file',
        'readTerminalArtifactChunk',
        payload,
        MobileWebTerminalArtifactChunkPayloadSchema,
        MobileWebTerminalArtifactChunkResultSchema,
        options
      )
      .then((result): MobileWebTerminalArtifactChunkResult => {
        if (
          result.workspaceId !== payload.workspaceId ||
          result.tabId !== payload.tabId ||
          result.token !== payload.token ||
          result.offset !== payload.offset
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        const bytes = decodeMobileWebFileBytes(
          result.contentBase64,
          MOBILE_WEB_FILE_CHUNK_MAX_BYTES
        )
        if (bytes.byteLength !== result.bytesRead || result.bytesRead > payload.length) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return {
          workspaceId: result.workspaceId,
          tabId: result.tabId,
          token: result.token,
          offset: result.offset,
          bytes,
          bytesRead: result.bytesRead,
          eof: result.eof
        }
      })
  }

  releaseTerminalArtifact(
    payload: MobileWebTerminalArtifactReleasePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<null> {
    return this.requests.request(
      'file',
      'releaseTerminalArtifact',
      payload,
      MobileWebTerminalArtifactReleasePayloadSchema,
      MobileWebTerminalArtifactReleaseResultSchema,
      options
    )
  }
}

function matchingWrite(
  payload: MobileWebFileWritePayload,
  result: MobileWebFileWriteResult
): MobileWebFileWriteResult {
  const bytes = decodeMobileWebFileBytes(payload.contentBase64, MOBILE_WEB_FILE_EDIT_MAX_BYTES)
  if (result.revision !== mobileWebFileRevision(bytes) || result.byteLength !== bytes.byteLength) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return matchingFile(payload, result)
}

function matchingFile<
  TPayload extends { workspaceId: string; relativePath: string },
  TResult extends { workspaceId: string; relativePath: string }
>(payload: TPayload, result: TResult): TResult {
  if (result.relativePath !== payload.relativePath) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return requireEchoedWorkspaceId(payload.workspaceId, result)
}
