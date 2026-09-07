import { z } from 'zod'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { readMobileWebNativeResource } from './mobile-web-native-resource-binding'

export async function bindMobileWebBrowserResource(
  args: MobileWebCapabilityExecutionDependencies,
  workspaceId: string,
  pageId: string
) {
  const generation = args.browserAuthority.captureGeneration()
  const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(workspaceId)
  const binding = z
    .object({ hostWorkspaceId: z.literal(hostWorkspaceId), hostPageId: z.string().min(1).max(512) })
    .parse(
      await readMobileWebNativeResource({
        client: args.connectedClient(),
        getPageSessionId: args.getPageSessionId,
        isActive: args.isRequestActive,
        hostWorkspaceId,
        kind: 'browser',
        resourceId: pageId
      })
    )
  args.workspaceAuthority.assertHostWorkspaceBinding(workspaceId, hostWorkspaceId)
  args.browserAuthority.assertGeneration(generation)
  args.browserAuthority.bind(pageId, binding)
}
