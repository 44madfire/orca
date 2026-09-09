import * as ExpoCrypto from 'expo-crypto'
import type { DeviceOperations } from './device-operations'

export const nativeDeviceOperations: DeviceOperations = {
  randomNonce() {
    return ExpoCrypto.randomUUID()
  }
}
