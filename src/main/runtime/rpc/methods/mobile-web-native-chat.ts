import { MOBILE_WEB_NATIVE_CHAT_MUTATION_METHOD } from './mobile-web-native-chat-mutations'
import { z } from 'zod'
import { defineMethod, isStreamingMethod } from '../core'
import { NATIVE_CHAT_METHODS } from './native-chat'
import {
  bindMobileWebNativeChat,
  MobileWebChatScope,
  mobileWebNativeChatHostParams,
  resolveMobileWebNativeChat
} from './mobile-web-native-chat-binding'

const read = NATIVE_CHAT_METHODS.find((method) => method.name === 'nativeChat.readSession')
if (!read || isStreamingMethod(read)) {
  throw new Error('Missing native chat reader')
}
const reader = read

export const MOBILE_WEB_NATIVE_CHAT_METHODS = [
  defineMethod({
    name: 'mobileWeb.nativeChat.bind',
    params: MobileWebChatScope.extend({ tabId: z.string().min(1).max(512) }),
    handler: (params, context) => bindMobileWebNativeChat(context, params)
  }),
  defineMethod({
    name: 'mobileWeb.nativeChat.read',
    params: MobileWebChatScope.extend({
      resourceId: z.string().min(1).max(160),
      read: z.record(z.string(), z.unknown())
    }),
    handler: async (params, context) => {
      const binding = await resolveMobileWebNativeChat(context, params)
      const input = reader.params!.parse(mobileWebNativeChatHostParams(binding, params.read))
      const result = await reader.handler(input, context)
      await resolveMobileWebNativeChat(context, params)
      return result
    }
  }),
  MOBILE_WEB_NATIVE_CHAT_MUTATION_METHOD
]
