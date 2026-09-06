import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'
import { ALL_RPC_METHODS } from './rpc/methods'
import { MOBILE_WEB_HOST_CATALOG_METHOD } from './rpc/methods/mobile-web-host-catalog'
import type { RpcContext } from './rpc/core'
import {
  MobileWebHostCatalogResultSchema,
  type MobileWebHostGrant
} from '../../shared/mobile-web/host-rpc-contract'

it('admits every catalog method and cleanup through authenticated mobile dispatch', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-catalog-'))
  const { runtime } = createMobileRpcSurfaceRuntime()
  const readMobileFile = vi.fn().mockResolvedValue({
    worktree: 'private-workspace',
    rootPath: '/private/repo',
    relativePath: 'README.md',
    content: 'host-owned adapter',
    futureField: { revision: 2 }
  })
  Object.assign(runtime, { readMobileFile })
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
  async function dispatch(method: string, params: unknown = {}) {
    const responses: { ok: boolean; result?: unknown; error?: { code: string } }[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'request', method, params, deviceToken: mobile.token }),
      (response) => responses.push(JSON.parse(response)),
      () => {}
    )
    expect(responses).toHaveLength(1)
    return responses[0]!
  }
  try {
    const grants: MobileWebHostGrant[] = []
    for (const method of ALL_RPC_METHODS) {
      const result = await MOBILE_WEB_HOST_CATALOG_METHOD.handler(
        { methods: [method.name] },
        {} as RpcContext
      )
      grants.push(...MobileWebHostCatalogResultSchema.parse(result).grants)
    }
    expect(grants.some((grant) => grant.method === 'mobileWeb.nativeChat.read')).toBe(true)
    for (const grant of grants) {
      for (const method of [grant.method, grant.unsubscribeMethod].filter(
        (method) => method !== undefined
      )) {
        // Invalid parameters stop at validation; this verifies the real authorization boundary.
        const response = await dispatch(method, null)
        expect(response.error?.code, method).not.toBe('forbidden')
        expect(response.error?.code, method).not.toBe('method_not_found')
      }
    }
    await expect(
      dispatch('mobileWeb.files.read', {
        worktree: 'id:workspace',
        relativePath: 'README.md'
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        relativePath: 'README.md',
        content: 'host-owned adapter',
        futureField: { revision: 2 }
      }
    })
    expect(readMobileFile).toHaveBeenCalledWith('id:workspace', 'README.md')
    const result = await dispatch('mobileWeb.files.read', {
      worktree: 'id:workspace',
      relativePath: 'README.md'
    })
    expect(JSON.stringify(result.result)).not.toContain('private')
    await expect(dispatch('files.delete')).resolves.toMatchObject({ error: { code: 'forbidden' } })
    await expect(dispatch('mobileWeb.futureUnadvertised')).resolves.toMatchObject({
      error: { code: 'forbidden' }
    })
  } finally {
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
