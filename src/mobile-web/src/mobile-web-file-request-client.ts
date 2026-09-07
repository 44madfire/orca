import { z } from 'zod'
import { sanitizeListResult } from '../../shared/mobile-web/file-list-presentation'
import { projectMobileWebHostFileContent } from './mobile-web-host-file-content'
import {
  MOBILE_WEB_FILE_CHUNK_MAX_BYTES,
  MobileWebFileListPayloadSchema,
  MobileWebFileOpenPayloadSchema,
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

const OpenResultSchema = z.object({ opened: z.literal(true) })
const WriteResultSchema = z.union([
  z.object({
    relativePath: z.string(),
    revision: z.string(),
    byteLength: z.number().int().nonnegative().max(MOBILE_WEB_FILE_EDIT_MAX_BYTES),
    outcome: z.literal('updated')
  }),
  z.object({ outcome: z.enum(['conflict', 'too_large']) })
])

export class MobileWebFileRequestClient extends MobileWebFileReadClient {
  list(
    payload: MobileWebFileListPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileListResult> {
    if (!MobileWebFileListPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
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
    return this.requestHost(
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
    return this.requestHost(
      'mobileWeb.files.read',
      payload.workspaceId,
      { relativePath: payload.relativePath },
      (result) => projectMobileWebHostFileContent(result, payload),
      options
    )
  }

  open(payload: MobileWebFileOpenPayload, options?: MobileWebBridgeRequestOptions): Promise<null> {
    if (!MobileWebFileOpenPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.open',
      payload.workspaceId,
      { relativePath: payload.relativePath, mode: 'edit' },
      (result) => {
        if (!OpenResultSchema.safeParse(result).success) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return null
      },
      options
    )
  }

  write(
    payload: MobileWebFileWritePayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebFileWriteResult> {
    if (!MobileWebFileWritePayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return this.requestHost(
      'mobileWeb.files.write',
      payload.workspaceId,
      {
        relativePath: payload.relativePath,
        expectedRevision: payload.expectedRevision,
        contentBase64: payload.contentBase64
      },
      (result) => projectWrite(payload, result),
      options
    )
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

function projectWrite(
  payload: MobileWebFileWritePayload,
  result: unknown
): MobileWebFileWriteResult {
  const parsed = WriteResultSchema.safeParse(result)
  if (!parsed.success) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  if (parsed.data.outcome !== 'updated') {
    throw new MobileWebBridgeClientError(parsed.data.outcome, false)
  }
  const bytes = decodeMobileWebFileBytes(payload.contentBase64, MOBILE_WEB_FILE_EDIT_MAX_BYTES)
  if (
    parsed.data.relativePath !== payload.relativePath ||
    parsed.data.revision !== mobileWebFileRevision(bytes) ||
    parsed.data.byteLength !== bytes.byteLength
  ) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return { ...parsed.data, workspaceId: payload.workspaceId }
}
