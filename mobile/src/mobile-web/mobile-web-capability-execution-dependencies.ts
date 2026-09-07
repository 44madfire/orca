import type { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebAccountSubscriptions } from './mobile-web-account-subscriptions'
import type { MobileWebAgentHistoryAuthority } from './mobile-web-agent-history-authority'
import type { MobileWebAgentHistoryPager } from './mobile-web-agent-history-pager'
import type { MobileWebAgentHistoryResume } from './mobile-web-agent-history-resume'
import type { MobileWebCommitMessageGeneration } from './mobile-web-commit-message-generation'
import type { MobileWebNavigationAuthority } from './mobile-web-navigation-operations'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebSpeechAuthority } from './mobile-web-speech-authority'
import type { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import type { MobileWebTaskProjectTablePager } from './mobile-web-task-project-table-pager'
import type { MobileWebTerminalArtifactAuthority } from './mobile-web-terminal-artifact-authority'
import type { MobileWebTerminalStreams } from './mobile-web-terminal-streams'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import type { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'
import type { MobileWebWorkspaceSubscriptions } from './mobile-web-workspace-subscriptions'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>

export type MobileWebCapabilityExecutionDependencies = {
  request: PageRequest
  isRequestActive: () => boolean
  connectedClient: () => RpcClient
  terminalClientId: string
  nativeAuthority: MobileWebNativeCapabilityAuthority
  agentHistoryAuthority: MobileWebAgentHistoryAuthority
  agentHistoryPager: MobileWebAgentHistoryPager
  agentHistoryResume: MobileWebAgentHistoryResume
  hostSubscriptions: MobileWebHostSubscriptions
  accountSubscriptions: MobileWebAccountSubscriptions
  speechAuthority: MobileWebSpeechAuthority
  workspaceSubscriptions: MobileWebWorkspaceSubscriptions
  terminalStreams: MobileWebTerminalStreams
  commitMessageGeneration: MobileWebCommitMessageGeneration
  terminalArtifactAuthority: MobileWebTerminalArtifactAuthority
  taskTargetAuthority: MobileWebTaskTargetAuthority
  taskProjectTable: MobileWebTaskProjectTablePager
  nativeChatAuthority: MobileWebNativeChatAuthority
  workspaceAuthority: MobileWebWorkspaceAuthority
  workspaceSnapshots: MobileWebWorkspaceSnapshotPager
  navigationAuthority?: MobileWebNavigationAuthority
}
