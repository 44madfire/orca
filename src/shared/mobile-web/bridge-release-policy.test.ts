import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from './bridge-protocol-version'
import { MOBILE_WEB_PACKAGE_BRIDGE_RANGE } from './bridge-release-policy'
import { supportsMobileWebBridgeVersion } from './manifest-contract'

describe('mobile web bridge release policy', () => {
  it('preserves the shipped APK and cached page protocol floor', () => {
    // A coordinated constant bump still strands installed shells and cached pages.
    expect(MOBILE_WEB_BRIDGE_PROTOCOL_VERSION).toBe(2)
    expect(MOBILE_WEB_PACKAGE_BRIDGE_RANGE.minimum).toBe(2)
    expect(supportsMobileWebBridgeVersion(MOBILE_WEB_PACKAGE_BRIDGE_RANGE, 2)).toBe(true)
    expect(
      supportsMobileWebBridgeVersion(
        { minimum: 2, testedThrough: 2 },
        MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
      )
    ).toBe(true)
  })

  it('keeps the packaged bridge range on the exact current contract', () => {
    expect(MOBILE_WEB_PACKAGE_BRIDGE_RANGE).toEqual({
      minimum: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
      testedThrough: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    })
  })
})
