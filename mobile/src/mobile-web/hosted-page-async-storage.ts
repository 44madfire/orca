import { requestMobileWebPagePreferences } from '../../../src/mobile-web/src/mobile-web-page-preferences-channel'

type Callback<T = void> = (error: Error | null, result?: T) => void
const namespace = 'expo.preferences'

function callbackResult<T>(work: Promise<T>, callback?: Callback<T>): Promise<T> {
  return work.then(
    (result) => {
      callback?.(null, result)
      return result
    },
    (error: unknown) => {
      const failure = error instanceof Error ? error : new Error('Page preferences unavailable')
      callback?.(failure)
      throw failure
    }
  )
}
async function multiGet(keys: readonly string[]): Promise<[string, string | null][]> {
  const result = await requestMobileWebPagePreferences({
    namespace,
    action: 'read',
    keys: [...keys]
  })
  if (!('entries' in result)) {
    throw new Error('Invalid page preference response')
  }
  return result.entries
}
async function multiSet(entries: readonly [string, string][]): Promise<void> {
  await requestMobileWebPagePreferences({ namespace, action: 'write', entries: [...entries] })
}
async function multiRemove(keys: readonly string[]): Promise<void> {
  await requestMobileWebPagePreferences({ namespace, action: 'remove', keys: [...keys] })
}
const storage = {
  getItem(key: string, callback?: Callback<string | null>) {
    return callbackResult(
      multiGet([key]).then((entries) => entries[0]?.[1] ?? null),
      callback
    )
  },
  setItem(key: string, value: string, callback?: Callback) {
    return callbackResult(multiSet([[key, value]]), callback)
  },
  removeItem(key: string, callback?: Callback) {
    return callbackResult(multiRemove([key]), callback)
  },
  clear(callback?: Callback) {
    return callbackResult(
      requestMobileWebPagePreferences({ namespace, action: 'clear' }).then(() => {}),
      callback
    )
  },
  getAllKeys(callback?: Callback<string[]>) {
    return callbackResult(
      requestMobileWebPagePreferences({ namespace, action: 'keys' }).then((result) => {
        if (!('keys' in result)) {
          throw new Error('Invalid page preference response')
        }
        return result.keys
      }),
      callback
    )
  },
  multiGet(keys: readonly string[], callback?: Callback<[string, string | null][]>) {
    return callbackResult(multiGet(keys), callback)
  },
  multiSet(entries: readonly [string, string][], callback?: Callback) {
    return callbackResult(multiSet(entries), callback)
  },
  multiRemove(keys: readonly string[], callback?: Callback) {
    return callbackResult(multiRemove(keys), callback)
  },
  mergeItem(_key: string, _value: string, callback?: Callback) {
    return callbackResult(
      Promise.reject<void>(new Error('Use explicit page preference writes')),
      callback
    )
  },
  multiMerge(_entries: readonly [string, string][], callback?: Callback) {
    return callbackResult(
      Promise.reject<void>(new Error('Use explicit page preference writes')),
      callback
    )
  },
  flushGetRequests() {}
}
export function useAsyncStorage(key: string) {
  return {
    getItem: (callback?: Callback<string | null>) => storage.getItem(key, callback),
    setItem: (value: string, callback?: Callback) => storage.setItem(key, value, callback),
    removeItem: (callback?: Callback) => storage.removeItem(key, callback),
    mergeItem: (value: string, callback?: Callback) => storage.mergeItem(key, value, callback)
  }
}
export default storage
