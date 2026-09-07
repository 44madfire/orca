import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS } from '../../../src/shared/mobile-web/bridge-limits'
import { mobileWebRequestAtCapacity } from './mobile-web-request-accounting'

describe('aggregate subscription admission', () => {
  it('counts pending generic streams alongside active legacy and terminal streams', () => {
    const pending = new Map([
      ['pending', { operationKey: 'workspace.hostSubscribe', subscriptionId: 'pending-stream' }]
    ])
    const args = {
      pending,
      request: {
        mode: 'subscription' as const,
        capability: 'workspace',
        operation: 'hostSubscribe'
      },
      ledgers: [
        {
          countForOperation: (key: string) =>
            key === 'account.subscribe'
              ? MOBILE_WEB_BRIDGE_MAX_SUBSCRIPTIONS - 2
              : key === 'terminal.subscribe'
                ? 1
                : 0
        }
      ],
      isHostRequest: true,
      hostRequestsInFlight: 1,
      maxConcurrent: 8
    }
    expect(mobileWebRequestAtCapacity(args)).toBe(true)
    pending.clear()
    expect(mobileWebRequestAtCapacity(args)).toBe(false)
  })

  it('retains the actual host work ceiling after page cancellation removes pending state', () => {
    expect(
      mobileWebRequestAtCapacity({
        pending: new Map(),
        request: { mode: 'subscription', capability: 'workspace', operation: 'hostSubscribe' },
        ledgers: [],
        isHostRequest: true,
        hostRequestsInFlight: 4,
        maxConcurrent: 8
      })
    ).toBe(true)
  })
})
