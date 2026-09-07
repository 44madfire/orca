import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MobileWebNativeChatSessionIdSchema = z.string().min(1).max(160)

export const MobileWebNativeChatTargetShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  sessionId: MobileWebNativeChatSessionIdSchema
} as const
