import { requireOptionalNativeModule } from 'expo-modules-core'
import type { NativeDismissal } from './native-push-dismissal'

export const nativePushDismissal = requireOptionalNativeModule<NativeDismissal>(
  'OrcaNotificationDismissal'
)
