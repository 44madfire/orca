import { z } from 'zod'
import { readMobileWebNativeResource } from './mobile-web-native-resource-binding'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type {
  MobileWebHostNativeChatBinding,
  MobileWebNativeChatAuthority
} from './mobile-web-native-chat-authority'
import type {
  MobileWebHostWorkspaceId,
  MobileWebWorkspaceAuthority
} from './mobile-web-workspace-authority'

export async function resolveFreshMobileWebNativeChatBinding(args: {
  client: RpcClient
  hostWorkspaceId: MobileWebHostWorkspaceId
  sessionId: string
  getPageSessionId?: () => Promise<string>
  isActive?: () => boolean
  nativeChatAuthority: MobileWebNativeChatAuthority
  requireTerminal?: boolean
}): Promise<Readonly<MobileWebHostNativeChatBinding>> {
  const generation = args.nativeChatAuthority.captureGeneration()
  const binding = z
    .object({
      hostWorkspaceId: z.literal(args.hostWorkspaceId),
      hostTabId: z.string().min(1).max(512),
      hostTerminalId: z.string().min(1).max(512).nullable(),
      agent: z.string().min(1).max(64),
      providerSessionId: z.string().min(1).max(512),
      transcriptPath: z
        .string()
        .max(16 * 1024)
        .optional()
    })
    .parse(
      await readMobileWebNativeResource({
        ...args,
        kind: 'sessionChat',
        resourceId: args.sessionId
      })
    )
  if (args.requireTerminal && !binding.hostTerminalId) {
    throw new MobileWebBrokerError('not_found')
  }
  const bound = { ...binding, hostWorkspaceId: args.hostWorkspaceId }
  args.nativeChatAuthority.assertGeneration(generation)
  args.nativeChatAuthority.bind(args.sessionId, bound)
  return bound
}

export function resolveFreshMobileWebNativeChatPageBinding(
  args: {
    client: RpcClient
    getPageSessionId?: () => Promise<string>
    isActive?: () => boolean
    workspaceAuthority: MobileWebWorkspaceAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
  },
  pageWorkspaceId: string,
  sessionId: string,
  requireTerminal = false
) {
  return resolveFreshMobileWebNativeChatBinding({
    client: args.client,
    getPageSessionId: args.getPageSessionId,
    isActive: args.isActive,
    hostWorkspaceId: args.workspaceAuthority.hostWorkspaceId(pageWorkspaceId),
    sessionId,
    nativeChatAuthority: args.nativeChatAuthority,
    requireTerminal
  })
}

export async function assertCurrentMobileWebNativeChatPageBinding(
  args: {
    client: RpcClient
    getPageSessionId?: () => Promise<string>
    isActive?: () => boolean
    workspaceAuthority: MobileWebWorkspaceAuthority
    nativeChatAuthority: MobileWebNativeChatAuthority
  },
  pageWorkspaceId: string,
  sessionId: string,
  binding: Readonly<MobileWebHostNativeChatBinding>
): Promise<void> {
  args.workspaceAuthority.assertHostWorkspaceBinding(pageWorkspaceId, binding.hostWorkspaceId)
  const current = await resolveFreshMobileWebNativeChatPageBinding(args, pageWorkspaceId, sessionId)
  args.workspaceAuthority.assertHostWorkspaceBinding(pageWorkspaceId, binding.hostWorkspaceId)
  if (JSON.stringify(current) !== JSON.stringify(binding)) {
    throw new MobileWebBrokerError('not_found')
  }
  args.nativeChatAuthority.assertBinding(binding.hostWorkspaceId, sessionId, binding)
}
