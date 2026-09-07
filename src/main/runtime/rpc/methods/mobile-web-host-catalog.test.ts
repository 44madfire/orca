import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES } from '../../../../shared/mobile-web/bridge-limits'
import { MOBILE_WEB_HOST_CATALOG_METHOD } from './mobile-web-host-catalog'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'

describe('mobile web host catalog', () => {
  it('advertises only page-safe registered methods and never credential operations', () => {
    const result = MOBILE_WEB_HOST_CATALOG_METHOD.handler(
      {
        methods: [
          'mobileWeb.sourceControl.status',
          'mobileWeb.sourceControl.diff',
          'mobileWeb.files.readDir',
          'files.readChunk',
          'mobileWeb.files.searchPaths',
          'mobileWeb.files.read',
          'mobileWeb.sourceControl.status',
          'pairing.getEndpoints',
          'files.searchPaths',
          'future.unknown'
        ]
      },
      {} as RpcContext
    )
    expect(result).toEqual({
      grants: [
        'mobileWeb.sourceControl.status',
        'mobileWeb.sourceControl.diff',
        'mobileWeb.files.readDir',
        'files.readChunk',
        'mobileWeb.files.searchPaths',
        'mobileWeb.files.read'
      ].map((method) => ({
        method,
        workspaceParam: 'worktree',
        maxRequestBytes: 16 * 1024,
        // Directory listings, file reads and diffs get the whole bridge envelope.
        maxResponseBytes: [
          'mobileWeb.files.readDir',
          'mobileWeb.files.read',
          'mobileWeb.sourceControl.diff'
        ].includes(method)
          ? MOBILE_WEB_BRIDGE_MAX_OPERATION_BYTES
          : 512 * 1024
      }))
    })
    for (const method of [
      'mobileWeb.sourceControl.status',
      'mobileWeb.sourceControl.diff',
      'mobileWeb.files.readDir',
      'files.readChunk',
      'mobileWeb.files.searchPaths',
      'mobileWeb.files.read'
    ]) {
      expect(ALL_RPC_METHODS.some((entry) => entry.name === method)).toBe(true)
    }
  })
})
