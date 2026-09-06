import {
  MobileWebSourceControlDiffPayloadSchema,
  MobileWebSourceControlDiffResultSchema,
  MobileWebSourceControlStatusPayloadSchema,
  MobileWebSourceControlStatusResultSchema,
  type MobileWebSourceControlDiffPayload,
  type MobileWebSourceControlDiffResult,
  type MobileWebSourceControlStatusPayload,
  type MobileWebSourceControlStatusResult
} from '../../shared/mobile-web/source-control-operation-contract'
import {
  sanitizeMobileWebSourceControlStatus,
  sanitizeMobileWebSourceControlDiff
} from '../../shared/mobile-web/source-control-host-presentation'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requireEchoedWorkspaceId } from './mobile-web-result-echo'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSourceControlReadClient {
  constructor(protected readonly requests: MobileWebOneShotRequestClient) {}

  status(
    payload: MobileWebSourceControlStatusPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlStatusResult> {
    const legacy = () =>
      this.requests
        .request(
          'sourceControl',
          'status',
          payload,
          MobileWebSourceControlStatusPayloadSchema,
          MobileWebSourceControlStatusResultSchema,
          options
        )
        .then((result) => {
          if (result.entries.length > payload.limit) {
            throw new MobileWebBridgeClientError('invalid_message', false)
          }
          return requireEchoedWorkspaceId(payload.workspaceId, result)
        })
    if (
      this.requests.supports('workspace', 'hostRequest') &&
      MobileWebSourceControlStatusPayloadSchema.safeParse(payload).success
    ) {
      return requestMobileWebHost(
        this.requests,
        'git.status',
        payload.workspaceId,
        { reuseLineStats: true },
        options
      )
        .then((result) =>
          sanitizeMobileWebSourceControlStatus(result, payload.workspaceId, payload.limit)
        )
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
    return legacy()
  }

  diff(
    payload: MobileWebSourceControlDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlDiffResult> {
    const legacy = () =>
      this.requests
        .request(
          'sourceControl',
          'diff',
          payload,
          MobileWebSourceControlDiffPayloadSchema,
          MobileWebSourceControlDiffResultSchema,
          options
        )
        .then((result) => {
          if (
            result.relativePath !== payload.relativePath ||
            result.area !== payload.area ||
            (result.kind === 'text' &&
              (result.offset !== payload.offset ||
                result.rows.length > payload.limit ||
                (payload.expectedRevision !== undefined &&
                  result.revision !== payload.expectedRevision)))
          ) {
            throw new MobileWebBridgeClientError('invalid_message', false)
          }
          return requireEchoedWorkspaceId(payload.workspaceId, result)
        })
    if (
      this.requests.supports('workspace', 'hostRequest') &&
      MobileWebSourceControlDiffPayloadSchema.safeParse(payload).success
    ) {
      return requestMobileWebHost(
        this.requests,
        'git.diff',
        payload.workspaceId,
        { filePath: payload.relativePath, staged: payload.area === 'staged' },
        options
      )
        .then((result) => sanitizeMobileWebSourceControlDiff(result, payload))
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
    return legacy()
  }
}
