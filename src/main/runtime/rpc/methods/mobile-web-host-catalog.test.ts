import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_HOST_CATALOG_METHOD } from './mobile-web-host-catalog'
import type { RpcContext } from '../core'
import { ALL_RPC_METHODS } from './index'

describe('mobile web host catalog', () => {
  it('advertises only page-safe registered methods and never credential operations', () => {
    const result = MOBILE_WEB_HOST_CATALOG_METHOD.handler(
      {
        methods: [
          'git.status',
          'git.diff',
          'files.readDir',
          'files.readChunk',
          'git.status',
          'pairing.getEndpoints',
          'files.searchPaths',
          'future.unknown'
        ]
      },
      {} as RpcContext
    )
    expect(result).toEqual({
      grants: ['git.status', 'git.diff', 'files.readDir', 'files.readChunk'].map((method) => ({
        method,
        workspaceParam: 'worktree',
        maxRequestBytes: 16 * 1024,
        maxResponseBytes: 512 * 1024
      }))
    })
    for (const method of ['git.status', 'git.diff', 'files.readDir', 'files.readChunk']) {
      expect(ALL_RPC_METHODS.some((entry) => entry.name === method)).toBe(true)
    }
  })
})
