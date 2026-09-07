import { mobileWebHostPayloadByteLength } from '../../../src/shared/mobile-web/host-rpc-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  assertMobileWebHostRequestScope,
  prepareMobileWebHostRequest,
  type MobileWebHostRequestArguments,
  type MobileWebHostRequestScope
} from './mobile-web-host-requests'
import {
  MobileWebSubscriptionLedger,
  type MobileWebSubscriptionLedgerConfig,
  type MobileWebSubscriptionRecord
} from './mobile-web-subscription-ledger'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type HostStreamRecord = MobileWebSubscriptionRecord & {
  scope: MobileWebHostRequestScope | undefined
  maxEventBytes: number
  closing: boolean
}

export class MobileWebHostSubscriptions extends MobileWebSubscriptionLedger<
  unknown,
  HostStreamRecord
> {
  constructor(
    private readonly config: MobileWebSubscriptionLedgerConfig<unknown> & {
      workspaceAuthority: MobileWebWorkspaceAuthority
    }
  ) {
    super({ ...config, operationKey: 'workspace.hostSubscribe' })
  }

  async start(
    args: Omit<MobileWebHostRequestArguments, 'authority'> & {
      requestId: string
      subscriptionId: string
    }
  ): Promise<void> {
    this.admit(args.subscriptionId)
    const { payload, scope, grant, params } = await prepareMobileWebHostRequest(
      {
        ...args,
        authority: this.config.workspaceAuthority
      },
      'subscription'
    )
    if (!args.isActive()) {
      throw new MobileWebBrokerError('cancelled')
    }
    const record: HostStreamRecord = {
      ...this.newRecord(args.requestId),
      scope,
      maxEventBytes: grant.maxResponseBytes,
      closing: false
    }
    this.open(args.subscriptionId, record, () =>
      args.client.subscribe(
        payload.method,
        params,
        (event) => this.receive(args.subscriptionId, record, event),
        { serverUnsubscribeMethod: grant.unsubscribeMethod }
      )
    )
  }

  protected override canDeliver(subscriptionId: string, record: HostStreamRecord): boolean {
    try {
      assertMobileWebHostRequestScope(this.config.workspaceAuthority, record.scope)
      return true
    } catch {
      this.cancel(subscriptionId, { code: 'not_found', retryable: false })
      return false
    }
  }

  private receive(subscriptionId: string, record: HostStreamRecord, event: unknown): void {
    if (
      record.closing ||
      !this.isCurrent(subscriptionId, record) ||
      !this.canDeliver(subscriptionId, record)
    ) {
      return
    }
    const eventBytes = mobileWebHostPayloadByteLength(event)
    if (eventBytes === undefined || eventBytes > record.maxEventBytes) {
      this.cancel(subscriptionId, { code: 'too_large', retryable: false })
      return
    }
    const type =
      typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
    record.closing = type === 'end' || type === 'error'
    this.enqueue(subscriptionId, record, event, record.closing)
  }
}
