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
import { requestMobileWebHost } from './mobile-web-host-request-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebBridgeRequestOptions } from './mobile-web-bridge-request-state'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebSourceControlReadClient {
  constructor(protected readonly requests: MobileWebOneShotRequestClient) {}

  status(
    payload: MobileWebSourceControlStatusPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlStatusResult> {
    if (!MobileWebSourceControlStatusPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.sourceControl.status',
      payload.workspaceId,
      { limit: payload.limit },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlStatusResultSchema.parse({
        ...asRecord(result),
        workspaceId: payload.workspaceId
      })
      if (parsed.entries.length > payload.limit) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }

  diff(
    payload: MobileWebSourceControlDiffPayload,
    options?: MobileWebBridgeRequestOptions
  ): Promise<MobileWebSourceControlDiffResult> {
    if (!MobileWebSourceControlDiffPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.sourceControl.diff',
      payload.workspaceId,
      {
        relativePath: payload.relativePath,
        area: payload.area,
        offset: payload.offset,
        limit: payload.limit,
        ...(payload.expectedRevision ? { expectedRevision: payload.expectedRevision } : {})
      },
      options
    ).then((result) => {
      const parsed = MobileWebSourceControlDiffResultSchema.parse({
        ...asRecord(result),
        workspaceId: payload.workspaceId
      })
      if (
        parsed.relativePath !== payload.relativePath ||
        parsed.area !== payload.area ||
        (parsed.kind === 'text' &&
          (parsed.offset !== payload.offset ||
            parsed.rows.length > payload.limit ||
            (payload.expectedRevision !== undefined &&
              parsed.revision !== payload.expectedRevision)))
      ) {
        throw new MobileWebBridgeClientError('invalid_message', false)
      }
      return parsed
    })
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return value as Record<string, unknown>
}
