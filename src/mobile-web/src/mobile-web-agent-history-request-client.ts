import {
  MobileWebAgentHistoryPreviewResultSchema,
  MobileWebAgentHistoryResumeResultSchema,
  MobileWebAgentHistorySnapshotPayloadSchema,
  MobileWebAgentHistorySnapshotResultSchema,
  type MobileWebAgentHistoryPreviewResult,
  type MobileWebAgentHistoryResumePayload,
  type MobileWebAgentHistoryResumeResult,
  type MobileWebAgentHistorySnapshotPayload,
  type MobileWebAgentHistorySnapshotResult
} from '../../shared/mobile-web/agent-history-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

/** The desktop paging cursor is per connection, so the page never names a session another way. */
export class MobileWebAgentHistoryRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  snapshot(
    payload: MobileWebAgentHistorySnapshotPayload
  ): Promise<MobileWebAgentHistorySnapshotResult> {
    if (!MobileWebAgentHistorySnapshotPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.agentHistory.snapshot',
      payload.workspaceId,
      {
        scope: payload.scope,
        query: payload.query,
        force: payload.force,
        ...(payload.cursor ? { cursor: payload.cursor } : {})
      }
    ).then((result) => parseHostResult(MobileWebAgentHistorySnapshotResultSchema, result))
  }

  preview(sessionHandle: string): Promise<MobileWebAgentHistoryPreviewResult> {
    return requestMobileWebHost(this.requests, 'mobileWeb.agentHistory.preview', undefined, {
      sessionHandle
    }).then((result) => parseHostResult(MobileWebAgentHistoryPreviewResultSchema, result))
  }

  resume(payload: MobileWebAgentHistoryResumePayload): Promise<MobileWebAgentHistoryResumeResult> {
    return requestMobileWebHost(
      this.requests,
      'mobileWeb.agentHistory.resume',
      payload.workspaceId,
      {
        sessionHandle: payload.sessionHandle
      }
    ).then((result) => parseHostResult(MobileWebAgentHistoryResumeResultSchema, result))
  }
}

function parseHostResult<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  result: unknown
): T {
  const parsed = schema.safeParse(result)
  if (!parsed.success) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return parsed.data as T
}
