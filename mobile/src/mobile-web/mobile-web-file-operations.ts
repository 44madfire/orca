import {
  MobileWebFileOpenPayloadSchema,
  type MobileWebFileChunkWireResult,
  type MobileWebFileDirectoryResult,
  type MobileWebFileListResult,
  type MobileWebFileReadWireResult
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebFileWriteResult } from '../../../src/shared/mobile-web/file-edit-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { executeMobileWebFileOpenOperation } from './mobile-web-file-open-operation'
import { executeMobileWebFileWrite } from './mobile-web-file-write'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

export async function executeMobileWebFileOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  workspaceAuthority: MobileWebWorkspaceAuthority
}): Promise<
  | MobileWebFileListResult
  | MobileWebFileDirectoryResult
  | MobileWebFileReadWireResult
  | MobileWebFileChunkWireResult
  | MobileWebFileWriteResult
  | null
> {
  if (args.operation === 'write') {
    return executeMobileWebFileWrite(args.payload, args.client, args.workspaceAuthority)
  }
  if (args.operation === 'open') {
    const payload = MobileWebFileOpenPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    return executeMobileWebFileOpenOperation({
      client: args.client,
      hostWorkspaceId,
      relativePath: payload.relativePath,
      assertCurrent: () =>
        args.workspaceAuthority.assertHostWorkspaceBinding(payload.workspaceId, hostWorkspaceId)
    })
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
