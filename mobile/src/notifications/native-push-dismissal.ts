import type { OrcaPushPayload } from './push-payload'

export type NativeDismissal = {
  remember(payload: OrcaPushPayload): Promise<void>
  wasDismissed(payload: OrcaPushPayload): Promise<boolean>
}
// Web has no native notification center; native shells resolve the .native module.
export const nativePushDismissal: NativeDismissal | null = null
