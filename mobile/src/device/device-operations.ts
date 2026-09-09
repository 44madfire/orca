/** Device capabilities a screen reaches through its host binding instead of importing a native
 *  module directly, so the same screen runs against a non-native provider later.
 *
 *  Deliberately narrow: only what a caller on this branch reads. Haptics, clipboard and external
 *  links join it when the screens that use them are routed. */
export type DeviceOperations = {
  randomNonce(): string
}
