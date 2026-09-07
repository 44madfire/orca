import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileSpeechSetup } from '../dictation/mobile-dictation-setup'
import type { VoiceSettingsOperations } from './voice-settings-operations'

export function webVoiceSettingsOperations(client: MobileWebBridgeClient): VoiceSettingsOperations {
  const request = (method: string, params: Record<string, unknown>) =>
    client.host.request({ method, params })
  return {
    load: async () => (await request('speech.models.list', {})) as MobileSpeechSetup,
    configure: async (params) => {
      const result = (await request('speech.dictation.setup', params)) as MobileSpeechSetup
      if (
        (params.enabled !== undefined && result.enabled !== params.enabled) ||
        (params.modelId !== undefined && result.selectedModelId !== params.modelId) ||
        (params.dictationMode !== undefined && result.dictationMode !== params.dictationMode)
      ) {
        throw new Error('Voice settings update was not confirmed')
      }
      return result
    },
    download: async (modelId) => {
      await request('speech.models.download', { modelId })
    },
    delete: async (modelId) =>
      (await request('speech.models.delete', { modelId })) as MobileSpeechSetup
  }
}
