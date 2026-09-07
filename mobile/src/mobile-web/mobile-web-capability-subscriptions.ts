import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import { MobileWebAccountSubscriptions } from './mobile-web-account-subscriptions'
import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type {
  MobileWebSubscriptionLedgerConfig,
  MobileWebSubscriptionLedgerHandle
} from './mobile-web-subscription-ledger'
import type { MobileWebBrowserAuthority } from './mobile-web-browser-authority'
import { MobileWebBrowserStreams } from './mobile-web-browser-streams'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import { MobileWebWorkspaceSubscriptions } from './mobile-web-workspace-subscriptions'

export class MobileWebCapabilitySubscriptions {
  readonly host: MobileWebHostSubscriptions
  readonly account: MobileWebAccountSubscriptions
  readonly browser: MobileWebBrowserStreams
  readonly workspace: MobileWebWorkspaceSubscriptions
  private readonly ledgers: MobileWebSubscriptionLedgerHandle[]

  constructor(
    args: MobileWebSubscriptionLedgerConfig<unknown> & {
      browserAuthority: MobileWebBrowserAuthority
      workspaceAuthority: MobileWebWorkspaceAuthority
    }
  ) {
    const shared = {
      isActive: args.isActive,
      postEvent: args.postEvent,
      postClosed: args.postClosed
    }
    this.host = new MobileWebHostSubscriptions({
      ...shared,
      workspaceAuthority: args.workspaceAuthority
    })
    this.account = new MobileWebAccountSubscriptions(shared)
    this.browser = new MobileWebBrowserStreams({
      ...shared,
      workspaceAuthority: args.workspaceAuthority,
      browserAuthority: args.browserAuthority
    })
    this.workspace = new MobileWebWorkspaceSubscriptions(shared)
    this.ledgers = [this.host, this.account, this.browser, this.workspace]
  }

  countForOperation(operationKey: string): number {
    let count = 0
    for (const ledger of this.ledgers) {
      count += ledger.countForOperation(operationKey)
    }
    return count
  }

  cancel(subscriptionId: string): string | null {
    for (const ledger of this.ledgers) {
      const requestId = ledger.cancel(subscriptionId)
      if (requestId !== null) {
        return requestId
      }
    }
    return null
  }

  cancelByRequest(requestId: string): void {
    for (const ledger of this.ledgers) {
      ledger.cancelByRequest(requestId)
    }
  }

  /** Used when the page survives but its host feed does not, so every live entry learns it is over. */
  closeAll(closure: MobileWebSubscriptionClosure): void {
    for (const ledger of this.ledgers) {
      ledger.closeAll(closure)
    }
  }

  dispose(): void {
    for (const ledger of this.ledgers) {
      ledger.dispose()
    }
  }
}
