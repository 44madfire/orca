import {
  MobileWebTerminalRequestSchema,
  MobileWebTerminalEventSchema,
  type MobileWebTerminalRequest,
  type MobileWebTerminalEvent
} from '../../shared/mobile-web/terminal-stream-contract'
import type { z } from 'zod'
import type { MobileWebBridgeCapability } from '../../shared/mobile-web/bridge-contract'
import {
  MobileWebAccountEventSchema,
  MobileWebAccountSubscribePayloadSchema,
  type MobileWebAccountEvent
} from '../../shared/mobile-web/account-operation-contract'
import {
  MobileWebWorkspaceChangeSchema,
  MobileWebWorkspaceSubscribePayloadSchema,
  type MobileWebWorkspaceChange
} from '../../shared/mobile-web/bridge-operation-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import {
  MobileWebSpeechEventSchema,
  MobileWebSpeechSubscribePayloadSchema,
  type MobileWebSpeechEvent
} from '../../shared/mobile-web/speech-operation-contract'

export type MobileWebBridgeSubscriptionSetup = {
  operation?: string
  capability: MobileWebBridgeCapability
  payload: unknown
  payloadSchema: z.ZodType<unknown>
  eventSchema: z.ZodType<unknown>
  onEvent: (value: unknown) => void
  onError: (error: MobileWebBridgeClientError) => void
}

export function accountSubscriptionSetup(
  onEvent: (event: MobileWebAccountEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'account',
    payload: {},
    payloadSchema: MobileWebAccountSubscribePayloadSchema,
    eventSchema: MobileWebAccountEventSchema,
    onEvent: (value) => onEvent(value as MobileWebAccountEvent),
    onError
  }
}

export function speechSubscriptionSetup(
  onEvent: (event: MobileWebSpeechEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'speech',
    payload: {},
    payloadSchema: MobileWebSpeechSubscribePayloadSchema,
    eventSchema: MobileWebSpeechEventSchema,
    onEvent: (value) => onEvent(value as MobileWebSpeechEvent),
    onError
  }
}

export function workspaceSubscriptionSetup(
  onEvent: (event: MobileWebWorkspaceChange) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'workspace',
    payload: {},
    payloadSchema: MobileWebWorkspaceSubscribePayloadSchema,
    eventSchema: MobileWebWorkspaceChangeSchema,
    onEvent: (value) => onEvent(value as MobileWebWorkspaceChange),
    onError
  }
}

export function terminalSubscriptionSetup(
  payload: Extract<MobileWebTerminalRequest, { operation: 'subscribe' }>,
  onEvent: (event: MobileWebTerminalEvent) => void,
  onError: (error: MobileWebBridgeClientError) => void
): MobileWebBridgeSubscriptionSetup {
  return {
    capability: 'terminal',
    payload,
    payloadSchema: MobileWebTerminalRequestSchema,
    eventSchema: MobileWebTerminalEventSchema,
    onEvent: (value) => onEvent(value as MobileWebTerminalEvent),
    onError
  }
}
