import type {
  NativeChatMessage,
  NativeChatTurnLifecycle
} from '../../../src/shared/native-chat-types'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatStreamFrame } from './mobile-native-chat-stream-frame'
import type { MobileImageSource } from './mobile-image-source-picker'

export type HostSessionNativeChatTarget = {
  workspaceId: string
  agent: string
  sessionId: string
  transcriptPath: string | null
  terminalId: string | null
  clientId: string | null
}

export type HostSessionNativeChatReadResult =
  | {
      messages: NativeChatMessage[]
      hasMore?: boolean
      beforeOffset?: number
      lifecycle?: NativeChatTurnLifecycle
    }
  | { error: string }

export type HostSessionNativeChatImageAttachment = {
  reference: string
  previewUri: string
}

export type HostSessionNativeChatImageAttachResult =
  | { status: 'accepted'; attachment: HostSessionNativeChatImageAttachment }
  | { status: 'cancelled' | 'permission-denied' | 'too-large' }

export type HostSessionNativeChatOperations = {
  /** Whether the serving host can read this workspace's agent transcripts. */
  readability(workspaceId: string): Promise<boolean>
  /** No error callback: the transport has none, and a stream error arrives as an `error` frame
   *  through `onEvent`, which is where the caller already handles it. */
  subscribe(
    target: HostSessionNativeChatTarget,
    limit: number,
    onEvent: (event: MobileNativeChatStreamFrame) => void
  ): () => void
  read(
    target: HostSessionNativeChatTarget,
    limit: number,
    beforeOffset?: number
  ): Promise<HostSessionNativeChatReadResult>
  sendMessage(
    target: HostSessionNativeChatTarget,
    text: string,
    deadline?: number,
    clearInputFirst?: boolean,
    resolvedLaunchDraft?: { text: string; createdAt: number },
    typeCommand?: boolean
  ): Promise<MobileNativeChatSendOutcome>
  prepareCommit(target: HostSessionNativeChatTarget, deadline?: number): Promise<boolean>
  respond(
    target: HostSessionNativeChatTarget,
    text: string,
    enter: boolean,
    deadline?: number
  ): Promise<MobileNativeChatSendOutcome>
  stop(target: HostSessionNativeChatTarget, deadline?: number): Promise<MobileNativeChatSendOutcome>
  attachImage?(
    target: HostSessionNativeChatTarget,
    source: MobileImageSource
  ): Promise<HostSessionNativeChatImageAttachResult>
  pasteImages?(
    target: HostSessionNativeChatTarget,
    references: readonly string[],
    deadline?: number,
    followedByText?: boolean
  ): Promise<boolean>
  releaseImages?(target: HostSessionNativeChatTarget, references: readonly string[]): Promise<void>
  /** Null when the host refused the search. An empty array is a real answer the caller may
   *  cache; a refusal must not be cached, or the next keystroke would never retry. */
  searchFiles(target: HostSessionNativeChatTarget, query: string): Promise<string[] | null>
  openFile(target: HostSessionNativeChatTarget, pathText: string): Promise<void>
}
