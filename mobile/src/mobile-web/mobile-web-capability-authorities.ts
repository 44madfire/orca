import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import { MobileWebSourceControlBranchComparePager } from './mobile-web-source-control-branch-compare-pager'
import { MobileWebTaskTargetAuthority } from './mobile-web-task-target-authority'
import { MobileWebTaskProjectTablePager } from './mobile-web-task-project-table-pager'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSnapshotPager } from './mobile-web-workspace-snapshot-pager'

export class MobileWebCapabilityAuthorities {
  readonly nativeChat: MobileWebNativeChatAuthority
  readonly sourceControlBranchCompare: MobileWebSourceControlBranchComparePager
  readonly taskTarget: MobileWebTaskTargetAuthority
  readonly taskProjectTable: MobileWebTaskProjectTablePager
  readonly workspace: MobileWebWorkspaceAuthority
  readonly workspaceSnapshots: MobileWebWorkspaceSnapshotPager

  constructor(options: { now?: () => number; randomBytes: (length: number) => Uint8Array }) {
    this.nativeChat = new MobileWebNativeChatAuthority(options.randomBytes)
    this.sourceControlBranchCompare = new MobileWebSourceControlBranchComparePager()
    this.taskTarget = new MobileWebTaskTargetAuthority(options.randomBytes)
    this.taskProjectTable = new MobileWebTaskProjectTablePager(options.randomBytes)
    this.workspace = new MobileWebWorkspaceAuthority(options.randomBytes)
    this.workspaceSnapshots = new MobileWebWorkspaceSnapshotPager(options.randomBytes)
  }

  clear(): void {
    this.nativeChat.clear()
    this.sourceControlBranchCompare.clear()
    this.taskTarget.clear()
    this.taskProjectTable.clear()
    this.workspace.clear()
    this.workspaceSnapshots.clear()
  }
}
