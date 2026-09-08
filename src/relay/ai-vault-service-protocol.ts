import type { AiVaultListResult } from '../shared/ai-vault-types'
import type {
  AiVaultSessionTitleRequest,
  AiVaultSessionTitlesResult
} from '../shared/ai-vault-session-title'
import type { SshAiVaultRelayListParams } from '../shared/ssh-ai-vault-relay'
import type { RemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import {
  SESSION_SEARCH_OPERATIONS,
  type SessionSearchOperation
} from '../shared/ai-vault-search-rpc-methods'

export const RELAY_AI_VAULT_SERVICE_PROTOCOL = 1

export type RelayAiVaultServiceInit = {
  type: 'init'
  protocol: typeof RELAY_AI_VAULT_SERVICE_PROTOCOL
  remoteHome: string
  hostPlatform: RemoteHostPlatform
}

export type RelayAiVaultServiceRequest =
  | {
      type: 'request'
      id: number
      operation: 'search'
      action: SessionSearchOperation
      params: unknown
    }
  | {
      type: 'request'
      id: number
      operation: 'list'
      params: SshAiVaultRelayListParams
    }
  | {
      type: 'request'
      id: number
      operation: 'titles'
      requests: AiVaultSessionTitleRequest[]
    }

export type RelayAiVaultServiceLane = 'cache' | 'interactive' | 'search'

/**
 * `list` is a full history scan and a search `query` can drive a backfill pass,
 * so neither may queue ahead of the interactive lane that title reads and the
 * search controls run on. Search stays correct across the split because
 * `RelaySessionSearchOwner` serializes every operation it owns.
 */
export function relayAiVaultServiceLane(
  request: RelayAiVaultServiceRequest
): RelayAiVaultServiceLane {
  if (request.operation === 'list') {
    return 'cache'
  }
  return request.operation === 'search' && request.action === 'query' ? 'search' : 'interactive'
}

export type RelayAiVaultServiceParentMessage =
  | RelayAiVaultServiceInit
  | RelayAiVaultServiceRequest
  | { type: 'cancel'; id: number }
  | { type: 'shutdown' }

export type RelayAiVaultServiceChildMessage =
  | { type: 'result'; id: number; operation: 'search'; value: unknown }
  | {
      type: 'ready'
      protocol: typeof RELAY_AI_VAULT_SERVICE_PROTOCOL
      pid: number
    }
  | { type: 'result'; id: number; operation: 'list'; value: AiVaultListResult }
  | {
      type: 'result'
      id: number
      operation: 'titles'
      value: AiVaultSessionTitlesResult
    }
  | { type: 'error'; id: number; message: string }

export function isRelayAiVaultServiceRequest(value: unknown): value is RelayAiVaultServiceRequest {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  return (
    message.type === 'request' &&
    Number.isSafeInteger(message.id) &&
    (message.operation === 'list' ||
      message.operation === 'titles' ||
      (message.operation === 'search' &&
        SESSION_SEARCH_OPERATIONS.includes(message.action as SessionSearchOperation)))
  )
}

export function isRelayAiVaultServiceChildMessage(
  value: unknown
): value is RelayAiVaultServiceChildMessage {
  if (!value || typeof value !== 'object') {
    return false
  }
  const message = value as Record<string, unknown>
  if (message.type === 'ready') {
    return message.protocol === RELAY_AI_VAULT_SERVICE_PROTOCOL && Number.isSafeInteger(message.pid)
  }
  return (message.type === 'result' || message.type === 'error') && Number.isSafeInteger(message.id)
}
