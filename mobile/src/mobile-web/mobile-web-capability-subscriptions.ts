import { MobileWebHostSubscriptions } from './mobile-web-host-subscriptions'
import type { MobileWebSubscriptionClosure } from './mobile-web-subscription-closure'
import type {
  MobileWebSubscriptionLedgerConfig,
  MobileWebSubscriptionLedgerHandle
} from './mobile-web-subscription-ledger'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export class MobileWebCapabilitySubscriptions {
  readonly host: MobileWebHostSubscriptions
  private readonly ledgers: MobileWebSubscriptionLedgerHandle[]

  constructor(
    args: MobileWebSubscriptionLedgerConfig<unknown> & {
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
    this.ledgers = [this.host]
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
