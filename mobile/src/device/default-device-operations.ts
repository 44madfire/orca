import type { DeviceOperations } from './device-operations'
import { nativeDeviceOperations } from './native-device-operations'

export function defaultDeviceOperations(): DeviceOperations {
  return nativeDeviceOperations
}
