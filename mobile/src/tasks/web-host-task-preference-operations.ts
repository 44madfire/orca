import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { persistSetupHookTrustApproval } from './setup-hook-trust'
import type { HostTaskPreferenceOperations } from './host-task-preference-operations'

export function webHostTaskPreferenceOperations(
  client: MobileWebBridgeClient
): HostTaskPreferenceOperations {
  return {
    async updateResume(taskResumeState) {
      await client.task.updateResume({ taskResumeState })
    },
    async updateSettings(settings) {
      await client.task.updateSettings(settings)
    },
    persistSetupTrust: (args) =>
      persistSetupHookTrustApproval({ client: client.hostRpcSender, ...args })
  }
}
